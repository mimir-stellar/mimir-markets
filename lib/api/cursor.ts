import { apiError, type ApiErrorResult } from "@/lib/api/errors";
import { bindCursor, verifyCursor } from "@/lib/api/schema";

export interface CursorFilters {
  category?: string;
  states?: string[];
  creator?: string;
  sort?: string;
  projectionGeneration?: string;
}

function cursorSecret(): string {
  return (
    process.env.CURSOR_HMAC_SECRET?.trim() ||
    process.env.PASS_SECRET?.trim() ||
    "mimir-public-cursor-v1"
  );
}

function cursorQuery(filters: CursorFilters) {
  return {
    sort: filters.sort,
    filters: {
      category: filters.category,
      states: filters.states?.join(","),
      creator: filters.creator,
      projectionGeneration: filters.projectionGeneration,
    },
  };
}

export function encodeCursor(
  position: { key: string | number; id: string | number },
  filters: CursorFilters,
): string {
  return bindCursor(
    { key: position.key, id: String(position.id) },
    cursorQuery(filters),
    cursorSecret(),
  );
}

export type DecodedCursor =
  | { kind: "ok"; cursor?: number }
  | { kind: "error"; error: ApiErrorResult };

export function decodeCursor(
  cursor: string | null | undefined,
  filters: CursorFilters,
): DecodedCursor {
  if (!cursor) return { kind: "ok" };

  const legacyCursor = /^\d+$/.test(cursor);
  if (legacyCursor) {
    const cursorValue = Number(cursor);
    if (!Number.isSafeInteger(cursorValue) || cursorValue <= 0) {
      return {
        kind: "error",
        error: apiError("invalid_cursor", "pagination cursor position is invalid"),
      };
    }
    return { kind: "ok", cursor: cursorValue };
  }

  const verdict = verifyCursor(cursor, cursorQuery(filters), cursorSecret());
  if (!verdict.ok) {
    return {
      kind: "error",
      error: apiError("invalid_cursor", "pagination cursor is malformed or bound to a different request or projection generation"),
    };
  }

  const key = verdict.payload.k;
  const cursorValue = typeof key === "number" ? key : Number(key);
  if (!Number.isSafeInteger(cursorValue) || cursorValue <= 0) {
    return {
      kind: "error",
      error: apiError("invalid_cursor", "pagination cursor position is invalid"),
    };
  }
  return { kind: "ok", cursor: cursorValue };
}
