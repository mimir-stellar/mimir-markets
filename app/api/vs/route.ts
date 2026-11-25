import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import { CATEGORIES } from "@/lib/constants";
import {
  getActiveReadIndexGeneration,
  getVsFeedSnapshot,
  type VsFeedOptions,
  type VsSort,
} from "@/lib/server/vs-index";
import { VS_CACHE_HEADERS } from "@/lib/server/vs-cache";
import { CURRENT_PROJECTION_GENERATION } from "@/lib/vs-freshness";
import { decodeCursor, encodeCursor, type CursorFilters } from "@/lib/api/cursor";

export const dynamic = "force-dynamic";

const MAX_CATEGORY_COUNT = 10;
const MAX_STATE_COUNT = 10;
const MAX_FILTER_ARRAY_BYTES = 512;

export function computeVsEtag(updatedAt: string | number | null | undefined, count: number): string {
  const maxUpdatedAt = updatedAt == null ? "0" : String(updatedAt);
  return `W/"${maxUpdatedAt}-${count}"`;
}

export function isEtagMatch(ifNoneMatch: string | null, ifNoneMatchWeak: string | null, etag: string): boolean {
  const header = ifNoneMatch ?? ifNoneMatchWeak;
  if (!header) return false;
  const tokens = header.split(",").map((t) => t.trim());
  if (tokens.includes("*")) return true;
  const normalize = (value: string) => value.replace(/^W\//, "");
  const target = normalize(etag);
  return tokens.some((t) => normalize(t) === target);
}

/**
 * Validates the size of filter arrays (categories, states) before any
 * read-index query is constructed. Returns an error body on violation.
 */
export function validateFilterArrayBounds(
  categories: string[],
  states: string[],
): { ok: true } | { ok: false; error: ReturnType<typeof apiError> } {
  if (categories.length > MAX_CATEGORY_COUNT) {
    return {
      ok: false,
      error: apiError("validation_error", `category filter accepts at most ${MAX_CATEGORY_COUNT} values`),
    };
  }
  if (states.length > MAX_STATE_COUNT) {
    return {
      ok: false,
      error: apiError("validation_error", `states filter accepts at most ${MAX_STATE_COUNT} values`),
    };
  }
  const categoryBytes = categories.reduce((sum, v) => sum + Buffer.byteLength(v, "utf8"), 0);
  if (categoryBytes > MAX_FILTER_ARRAY_BYTES) {
    return {
      ok: false,
      error: apiError("validation_error", `category filter exceeds ${MAX_FILTER_ARRAY_BYTES} bytes`),
    };
  }
  const stateBytes = states.reduce((sum, v) => sum + Buffer.byteLength(v, "utf8"), 0);
  if (stateBytes > MAX_FILTER_ARRAY_BYTES) {
    return {
      ok: false,
      error: apiError("validation_error", `states filter exceeds ${MAX_FILTER_ARRAY_BYTES} bytes`),
    };
  }
  return { ok: true };
}

function resolveMaxUpdatedAt(items: Array<Record<string, unknown>>): string | number | null {
  let max: string | number | null = null;
  for (const item of items) {
    const value = item.updated_at as string | number | null | undefined;
    if (value == null) continue;
    if (max === null || value > max) max = value;
  }
  return max;
}

export function parseVsListParams(searchParams: URLSearchParams):
  | { kind: "ok"; params: VsFeedOptions & { forceRefresh: boolean; rawCursor?: string } }
  | { kind: "error"; body: ReturnType<typeof apiError>["body"]; status: number; headers: Record<string, string> } {
  const category = searchParams.getAll("category");
  if (category.length > 1) {
    const error = apiError("invalid_request", "category must be supplied once", { field: "category" });
    return { kind: "error", body: error.body, status: error.status, headers: error.headers };
  }
  const categoryValue = category[0]?.trim() || undefined;
  if (categoryValue && !CATEGORIES.some((item) => item.id === categoryValue)) {
    const error = apiError("invalid_request", "unsupported category", { field: "category" });
    return { kind: "error", body: error.body, status: error.status, headers: error.headers };
  }

  const states = searchParams.getAll("state").map((value) => value.trim()).filter(Boolean);
  for (const state of states) {
    if (!["open", "active", "resolved", "cancelled"].includes(state)) {
      const error = apiError("invalid_request", "unsupported state", { field: "state" });
      return { kind: "error", body: error.body, status: error.status, headers: error.headers };
    }
  }

  const creatorValues = searchParams.getAll("creator");
  if (creatorValues.length > 1) {
    const error = apiError("invalid_request", "creator must be supplied once", { field: "creator" });
    return { kind: "error", body: error.body, status: error.status, headers: error.headers };
  }
  const creator = creatorValues[0]?.trim() || undefined;
  if (creatorValues[0] !== undefined && !creator) {
    const error = apiError("invalid_request", "creator must not be empty", { field: "creator" });
    return { kind: "error", body: error.body, status: error.status, headers: error.headers };
  }

  const sortValues = searchParams.getAll("sort");
  if (sortValues.length > 1) {
    const error = apiError("invalid_request", "sort must be supplied once", { field: "sort" });
    return { kind: "error", body: error.body, status: error.status, headers: error.headers };
  }
  const sort = (sortValues[0]?.trim() || "newest") as VsSort;
  if (!["newest", "expiring", "updated"].includes(sort)) {
    const error = apiError("invalid_request", "unsupported sort", { field: "sort" });
    return { kind: "error", body: error.body, status: error.status, headers: error.headers };
  }

  const cursorValue = searchParams.get("cursor")?.trim();
  const numericCursor = cursorValue && /^\d+$/.test(cursorValue) ? Number(cursorValue) : undefined;
  if (cursorValue && /^\d+$/.test(cursorValue) && (!Number.isSafeInteger(numericCursor) || Number(numericCursor) <= 0)) {
    const error = apiError("invalid_cursor", "pagination cursor position is invalid");
    return { kind: "error", body: error.body, status: error.status, headers: error.headers };
  }

  const limitValue = searchParams.get("limit")?.trim();
  const limit = limitValue ? Number(limitValue) : 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    const error = apiError("invalid_request", "limit must be between 1 and 100", { field: "limit" });
    return { kind: "error", body: error.body, status: error.status, headers: error.headers };
  }

  const refresh = searchParams.get("refresh")?.trim();
  if (refresh !== null && refresh !== undefined && !["0", "1"].includes(refresh)) {
    const error = apiError("invalid_request", "refresh must be 0 or 1", { field: "refresh" });
    return { kind: "error", body: error.body, status: error.status, headers: error.headers };
  }

  return {
    kind: "ok",
    params: {
      forceRefresh: refresh === "1",
      cursor: numericCursor,
      limit,
      category: categoryValue,
      states: states.length > 0 ? states : undefined,
      creator,
      sort,
      rawCursor: cursorValue,
    } as VsFeedOptions & { forceRefresh: boolean; rawCursor?: string },
  };
}

export async function GET(request: Request) {
  try {
    const { authorizeRequest } = await import("@/lib/api/policy");
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
    const gate = await authorizeRequest("public_read", { route: "/api/vs", ip });
    if (!gate.allowed && gate.error) {
      return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
    }
    const { searchParams } = new URL(request.url);
    const parsed = parseVsListParams(searchParams);
    if (parsed.kind === "error") {
      return NextResponse.json(parsed.body, { status: parsed.status, headers: parsed.headers });
    }
    const { forceRefresh, cursor, rawCursor, limit, category, states, creator, sort } = parsed.params;

    const bounds = validateFilterArrayBounds(
      Array.isArray(category) ? category : category ? [category] : [],
      Array.isArray(states) ? states : states ? [states] : [],
    );
    if (!bounds.ok) {
      return NextResponse.json(bounds.error.body, { status: bounds.error.status, headers: bounds.error.headers });
    }

    const activeGeneration = await getActiveReadIndexGeneration();
    const projectionGeneration = activeGeneration.generationId
      ? `${activeGeneration.generationId}:${CURRENT_PROJECTION_GENERATION}`
      : String(CURRENT_PROJECTION_GENERATION);

    // Bind the cursor to its filters and active read-index generation.
    const filters: CursorFilters = { category, states, creator, sort, projectionGeneration };
    const decoded = decodeCursor(rawCursor, filters);
    if (decoded.kind === "error") {
      return NextResponse.json(decoded.error.body, { status: decoded.error.status, headers: decoded.error.headers });
    }

    const { items, cache, nextCursor } = await getVsFeedSnapshot({
      forceRefresh,
      cursor: decoded.cursor,
      limit,
      category,
      states,
      creator,
      sort,
    });

    const maxUpdatedAt = resolveMaxUpdatedAt(items as Array<Record<string, unknown>>);
    const etag = computeVsEtag(maxUpdatedAt, items.length);
    const ifNoneMatch = request.headers.get("if-none-match");

    if (isEtagMatch(ifNoneMatch, null, etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: { ...VS_CACHE_HEADERS, ETag: etag },
      });
    }

    const boundNextCursor =
      nextCursor && items.length > 0
        ? encodeCursor(
            {
              key: (items[items.length - 1] as { id: number }).id,
              id: (items[items.length - 1] as { id: number }).id,
            },
            filters,
          )
        : nextCursor;

    return NextResponse.json(
      {
        items,
        count: items.length,
        cache,
        nextCursor: boundNextCursor,
      },
      {
        headers: { ...VS_CACHE_HEADERS, ETag: etag },
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to load VS feed");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}