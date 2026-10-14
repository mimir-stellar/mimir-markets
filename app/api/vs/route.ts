import { NextResponse } from "next/server";

import { apiError } from "@/lib/api/errors";
import { CATEGORIES } from "@/lib/constants";
import { parseAddressParam } from "@/lib/server/api-validation";
import { getVsFeedSnapshot } from "@/lib/server/vs-index";
import { VS_CACHE_HEADERS } from "@/lib/server/vs-cache";

export const dynamic = "force-dynamic";

const VALID_CATEGORY_IDS = new Set<string>(CATEGORIES.map((c) => c.id));
const VALID_STATE_IDS = new Set(["open", "active", "resolved", "cancelled"]);
const STATE_ALIASES: Record<string, string> = {
  settled: "resolved",
  challenging: "active",
};
const VALID_SORTS = new Set([
  "newest",
  "expiring",
  "updated",
  "id_desc",
  "deadline_asc",
  "deadline_desc",
  "updated_desc",
]);

export async function GET(request: Request) {
  try {
    const { authorizeRequest } = await import("@/lib/api/policy");
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
    const gate = authorizeRequest("public_read", { route: "/api/vs", ip });
    if (!gate.allowed && gate.error) {
      return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
    }
    const { searchParams } = new URL(request.url);
    const refreshValue = searchParams.get("refresh");
    const cursorValue = searchParams.get("cursor");
    const limitValue = searchParams.get("limit");

    if (refreshValue && refreshValue !== "1") {
      const err = apiError("invalid_request", "refresh must be 1 when provided", { field: "refresh" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    const shouldRefresh = refreshValue === "1";
    const cursor = cursorValue ? Number(cursorValue) : undefined;
    const limit = limitValue ? Number(limitValue) : undefined;

    if (cursor !== undefined && (!Number.isInteger(cursor) || cursor <= 0)) {
      const err = apiError("invalid_request", "cursor must be a positive integer", { field: "cursor" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0 || limit > 100)) {
      const err = apiError("invalid_request", "limit must be between 1 and 100", { field: "limit" });
      return NextResponse.json(err.body, { status: err.status, headers: err.headers });
    }

    // Category filter validation
    const categoryParam = searchParams.get("category");
    let category: string | undefined;
    let categories: string[] | undefined;
    if (categoryParam !== null && categoryParam !== "") {
      const rawCategories = categoryParam
        .split(",")
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
      for (const cat of rawCategories) {
        if (!VALID_CATEGORY_IDS.has(cat)) {
          const err = apiError("invalid_request", `Invalid category: ${cat}`, { field: "category" });
          return NextResponse.json(err.body, { status: err.status, headers: err.headers });
        }
      }
      if (rawCategories.length === 1) {
        category = rawCategories[0];
      } else if (rawCategories.length > 1) {
        categories = rawCategories;
      }
    }

    // State filter validation
    const stateParams = searchParams.getAll("state");
    let state: string | undefined;
    let states: string[] | undefined;
    if (stateParams.length > 0) {
      const rawStates: string[] = [];
      for (const sp of stateParams) {
        for (const part of sp.split(",")) {
          const trimmed = part.trim().toLowerCase();
          if (trimmed) rawStates.push(trimmed);
        }
      }
      if (rawStates.length > 0) {
        const canonicalStates: string[] = [];
        for (const s of rawStates) {
          const canonical = STATE_ALIASES[s] || s;
          if (!VALID_STATE_IDS.has(canonical)) {
            const err = apiError("invalid_request", `Invalid state: ${s}`, { field: "state" });
            return NextResponse.json(err.body, { status: err.status, headers: err.headers });
          }
          canonicalStates.push(canonical);
        }
        if (canonicalStates.length === 1) {
          state = canonicalStates[0];
        } else if (canonicalStates.length > 1) {
          states = canonicalStates;
        }
      }
    }

    // Creator filter validation (Stellar address)
    const creatorParam = searchParams.get("creator");
    let creator: string | undefined;
    if (creatorParam !== null && creatorParam !== "") {
      const parsedCreator = parseAddressParam(creatorParam);
      if (!parsedCreator) {
        const err = apiError(
          "invalid_request",
          "creator must be a valid Stellar account or contract address",
          { field: "creator" }
        );
        return NextResponse.json(err.body, { status: err.status, headers: err.headers });
      }
      creator = parsedCreator;
    }

    // Sort filter validation
    const sortParam = (searchParams.get("sort") || searchParams.get("orderBy"))?.trim().toLowerCase();
    let sort: string | undefined;
    if (sortParam !== undefined && sortParam !== "") {
      if (!VALID_SORTS.has(sortParam)) {
        const err = apiError("invalid_request", `Invalid sort option: ${sortParam}`, { field: "sort" });
        return NextResponse.json(err.body, { status: err.status, headers: err.headers });
      }
      sort = sortParam;
    }

    const { items, cache, nextCursor } = await getVsFeedSnapshot({
      forceRefresh: shouldRefresh,
      cursor,
      limit,
      category,
      categories,
      state,
      states,
      creator,
      sort,
    });

    return NextResponse.json(
      {
        items,
        count: items.length,
        cache,
        nextCursor,
      },
      {
        headers: VS_CACHE_HEADERS,
      }
    );
  } catch {
    const err = apiError("internal_error", "Unable to load VS feed");
    return NextResponse.json(err.body, { status: err.status, headers: err.headers });
  }
}
