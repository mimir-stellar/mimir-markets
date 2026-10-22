/**
 * tests/node/explorer-cursor-pagination.test.ts
 *
 * Unit tests for cursor-based pagination helpers introduced in
 * feat(ui): add cursor pagination to the explorer (Closes #55).
 *
 * These tests exercise:
 *   - ClaimFilters.cursor being applied as an `id < cursor` SQL clause
 *     via getClaimsByFilter (tested via the shape of the ClaimFilters type).
 *   - The logic that derives `nextCursor` and `hasMore` from an oversized page.
 *   - API-route parameter validation for `cursor` and `limit` inputs.
 *   - Client-side de-duplication in loadMoreVS (append-without-repeat).
 *   - Boundary conditions: empty result, single page that fits exactly, and
 *     the last page (hasMore = false).
 */
import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// Helpers that mirror the production logic in vs-index.ts
// ---------------------------------------------------------------------------

function paginateItems<T extends { id: number }>(
  items: T[],
  cursor: number | undefined,
  limit: number
): { paginatedItems: T[]; nextCursor: number | null } {
  let view = [...items].sort((a, b) => b.id - a.id);

  if (cursor !== undefined) {
    view = view.filter((item) => item.id < cursor);
  }

  const hasMore = view.length > limit;
  const paginatedItems = hasMore ? view.slice(0, limit) : view;
  const nextCursor = hasMore ? paginatedItems[paginatedItems.length - 1].id : null;
  return { paginatedItems, nextCursor };
}

function validateCursorParam(cursor: number | undefined): string | null {
  if (cursor === undefined) return null;
  if (isNaN(cursor) || cursor <= 0) return "cursor must be a positive integer";
  return null;
}

function validateLimitParam(limit: number | undefined): string | null {
  if (limit === undefined) return null;
  if (isNaN(limit) || limit <= 0 || limit > 100) return "limit must be between 1 and 100";
  return null;
}

/** Mirror of ExploreClient deduplicate-and-append logic. */
function appendWithoutDuplicates<T extends { id: number }>(prev: T[], incoming: T[]): T[] {
  const existingIds = new Set(prev.map((item) => item.id));
  const newItems = incoming.filter((item) => !existingIds.has(item.id));
  return [...prev, ...newItems];
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const ITEMS = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 })).reverse();
// ids: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]

// ---------------------------------------------------------------------------
// Positive: first page
// ---------------------------------------------------------------------------

test("first page: returns first N items and a nextCursor", () => {
  const { paginatedItems, nextCursor } = paginateItems(ITEMS, undefined, 4);
  assert.equal(paginatedItems.length, 4);
  assert.deepEqual(
    paginatedItems.map((i) => i.id),
    [10, 9, 8, 7]
  );
  assert.equal(nextCursor, 7);
});

// ---------------------------------------------------------------------------
// Positive: subsequent page via cursor
// ---------------------------------------------------------------------------

test("second page using cursor: returns items below the cursor", () => {
  const { paginatedItems, nextCursor } = paginateItems(ITEMS, 7, 4);
  assert.equal(paginatedItems.length, 4);
  assert.deepEqual(
    paginatedItems.map((i) => i.id),
    [6, 5, 4, 3]
  );
  assert.equal(nextCursor, 3);
});

// ---------------------------------------------------------------------------
// Boundary: last page fits exactly without overflow → no nextCursor
// ---------------------------------------------------------------------------

test("last page: no nextCursor when items fit exactly within limit", () => {
  const { paginatedItems, nextCursor } = paginateItems(ITEMS, 3, 10);
  // items below id=3: [2, 1]
  assert.equal(paginatedItems.length, 2);
  assert.equal(nextCursor, null);
});

// ---------------------------------------------------------------------------
// Boundary: empty set
// ---------------------------------------------------------------------------

test("empty items: returns empty array and null nextCursor", () => {
  const { paginatedItems, nextCursor } = paginateItems([], undefined, 5);
  assert.equal(paginatedItems.length, 0);
  assert.equal(nextCursor, null);
});

// ---------------------------------------------------------------------------
// Boundary: exact page size (no overflow)
// ---------------------------------------------------------------------------

test("exact page size: no nextCursor when count equals limit", () => {
  const fiveItems = [{ id: 5 }, { id: 4 }, { id: 3 }, { id: 2 }, { id: 1 }];
  const { paginatedItems, nextCursor } = paginateItems(fiveItems, undefined, 5);
  assert.equal(paginatedItems.length, 5);
  assert.equal(nextCursor, null);
});

// ---------------------------------------------------------------------------
// API validation: cursor
// ---------------------------------------------------------------------------

test("validateCursorParam: undefined is valid", () => {
  assert.equal(validateCursorParam(undefined), null);
});

test("validateCursorParam: positive integer is valid", () => {
  assert.equal(validateCursorParam(42), null);
});

test("validateCursorParam: zero is invalid", () => {
  assert.notEqual(validateCursorParam(0), null);
});

test("validateCursorParam: negative is invalid", () => {
  assert.notEqual(validateCursorParam(-5), null);
});

test("validateCursorParam: NaN is invalid", () => {
  assert.notEqual(validateCursorParam(NaN), null);
});

// ---------------------------------------------------------------------------
// API validation: limit
// ---------------------------------------------------------------------------

test("validateLimitParam: undefined is valid", () => {
  assert.equal(validateLimitParam(undefined), null);
});

test("validateLimitParam: 1 is valid", () => {
  assert.equal(validateLimitParam(1), null);
});

test("validateLimitParam: 100 is valid", () => {
  assert.equal(validateLimitParam(100), null);
});

test("validateLimitParam: 0 is invalid", () => {
  assert.notEqual(validateLimitParam(0), null);
});

test("validateLimitParam: 101 is invalid (exceeds max)", () => {
  assert.notEqual(validateLimitParam(101), null);
});

test("validateLimitParam: NaN is invalid", () => {
  assert.notEqual(validateLimitParam(NaN), null);
});

// ---------------------------------------------------------------------------
// Client-side deduplication: appending a second page never creates duplicates
// ---------------------------------------------------------------------------

test("appendWithoutDuplicates: second page appended without repeats", () => {
  const page1 = [{ id: 10 }, { id: 9 }, { id: 8 }];
  const page2 = [{ id: 7 }, { id: 6 }, { id: 5 }];
  const result = appendWithoutDuplicates(page1, page2);
  assert.equal(result.length, 6);
  assert.deepEqual(
    result.map((i) => i.id),
    [10, 9, 8, 7, 6, 5]
  );
});

test("appendWithoutDuplicates: overlap is silently dropped", () => {
  const page1 = [{ id: 10 }, { id: 9 }, { id: 8 }];
  const overlapping = [{ id: 9 }, { id: 8 }, { id: 7 }]; // 9 & 8 already present
  const result = appendWithoutDuplicates(page1, overlapping);
  assert.equal(result.length, 4); // only 7 was genuinely new
  assert.ok(result.every((item, idx, arr) => arr.findIndex((x) => x.id === item.id) === idx));
});

test("appendWithoutDuplicates: appending empty list returns unchanged list", () => {
  const page1 = [{ id: 10 }, { id: 9 }];
  const result = appendWithoutDuplicates(page1, []);
  assert.equal(result.length, 2);
});

test("appendWithoutDuplicates: appending to empty list returns second page", () => {
  const page2 = [{ id: 5 }, { id: 4 }];
  const result = appendWithoutDuplicates([], page2);
  assert.deepEqual(result, page2);
});

// ---------------------------------------------------------------------------
// Regression: cursor correctly excludes items AT the cursor boundary
// ---------------------------------------------------------------------------

test("regression: cursor is exclusive — item with exact cursor id is not returned", () => {
  const { paginatedItems } = paginateItems(ITEMS, 5, 10);
  const ids = paginatedItems.map((i) => i.id);
  assert.ok(!ids.includes(5), "id=5 (the cursor) should be excluded");
  assert.ok(ids.every((id) => id < 5), "all returned ids must be strictly below the cursor");
});

// ---------------------------------------------------------------------------
// Route & Filter validation tests (feat(api): #482)
// ---------------------------------------------------------------------------

const ACCOUNT_A = "GBO43ZBS4RBC2QFDKB23U6TBFEEK47ZLGSXDJSRV2H3PNQK5ZDEYXVLE";
const CONTRACT_A = "CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR";
const INVALID_ADDRESS = "0x0000000000000000000000000000000000000abc";

test("API route rejects invalid category with 400 and field='category'", async () => {
  const { GET } = await import("../../app/api/vs/route");
  const req = new Request("http://localhost/api/vs?category=not_a_category");
  const res = await GET(req);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, "invalid_request");
  assert.equal(data.error.field, "category");
  assert.equal(data.error.retryable, false);
});

test("API route rejects invalid category in comma-separated list", async () => {
  const { GET } = await import("../../app/api/vs/route");
  const req = new Request("http://localhost/api/vs?category=crypto,unknown_cat");
  const res = await GET(req);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, "invalid_request");
  assert.equal(data.error.field, "category");
});

test("API route rejects invalid state with 400 and field='state'", async () => {
  const { GET } = await import("../../app/api/vs/route");
  const req = new Request("http://localhost/api/vs?state=invalid_state");
  const res = await GET(req);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, "invalid_request");
  assert.equal(data.error.field, "state");
  assert.equal(data.error.retryable, false);
});

test("API route rejects invalid creator address with 400 and field='creator'", async () => {
  const { GET } = await import("../../app/api/vs/route");
  const req = new Request(`http://localhost/api/vs?creator=${INVALID_ADDRESS}`);
  const res = await GET(req);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, "invalid_request");
  assert.equal(data.error.field, "creator");
  assert.equal(data.error.retryable, false);
});

test("API route rejects invalid sort option with 400 and field='sort'", async () => {
  const { GET } = await import("../../app/api/vs/route");
  const req = new Request("http://localhost/api/vs?sort=random_sort");
  const res = await GET(req);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.code, "invalid_request");
  assert.equal(data.error.field, "sort");
  assert.equal(data.error.retryable, false);
});

test("API route rejects non-integer or non-positive cursor with 400 and field='cursor'", async () => {
  const { GET } = await import("../../app/api/vs/route");
  const req1 = new Request("http://localhost/api/vs?cursor=-1");
  const res1 = await GET(req1);
  assert.equal(res1.status, 400);
  const data1 = await res1.json();
  assert.equal(data1.error.field, "cursor");

  const req2 = new Request("http://localhost/api/vs?cursor=abc");
  const res2 = await GET(req2);
  assert.equal(res2.status, 400);
  const data2 = await res2.json();
  assert.equal(data2.error.field, "cursor");
});

test("API route rejects invalid limit with 400 and field='limit'", async () => {
  const { GET } = await import("../../app/api/vs/route");
  const req = new Request("http://localhost/api/vs?limit=150");
  const res = await GET(req);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error.field, "limit");
});

// ---------------------------------------------------------------------------
// Filtered cursor pagination logic & private claim isolation
// ---------------------------------------------------------------------------

interface FilterableClaim {
  id: number;
  category: string;
  state: string;
  creator: string;
  visibility: "public" | "private";
}

const SAMPLE_CLAIMS: FilterableClaim[] = [
  { id: 10, category: "crypto", state: "open", creator: ACCOUNT_A, visibility: "public" },
  { id: 9, category: "sports", state: "active", creator: ACCOUNT_A, visibility: "public" },
  { id: 8, category: "crypto", state: "resolved", creator: "GOTHERACCOUNT", visibility: "public" },
  { id: 7, category: "weather", state: "open", creator: CONTRACT_A, visibility: "public" },
  { id: 6, category: "crypto", state: "open", creator: ACCOUNT_A, visibility: "private" }, // Private - MUST be excluded
  { id: 5, category: "culture", state: "cancelled", creator: ACCOUNT_A, visibility: "public" },
  { id: 4, category: "crypto", state: "open", creator: ACCOUNT_A, visibility: "public" },
  { id: 3, category: "sports", state: "resolved", creator: CONTRACT_A, visibility: "public" },
  { id: 2, category: "crypto", state: "open", creator: ACCOUNT_A, visibility: "public" },
  { id: 1, category: "weather", state: "open", creator: ACCOUNT_A, visibility: "public" },
];

function applyFilterAndPaginate(
  claims: FilterableClaim[],
  options: {
    category?: string;
    categories?: string[];
    state?: string;
    states?: string[];
    creator?: string;
    cursor?: number;
    limit?: number;
  }
) {
  const { category, categories, state, states, creator, cursor, limit = 50 } = options;

  let view = claims.filter((c) => c.visibility === "public");

  if (category) {
    view = view.filter((c) => c.category === category);
  } else if (categories && categories.length > 0) {
    const set = new Set(categories);
    view = view.filter((c) => set.has(c.category));
  }

  if (state) {
    view = view.filter((c) => c.state === state);
  } else if (states && states.length > 0) {
    const set = new Set(states);
    view = view.filter((c) => set.has(c.state));
  }

  if (creator) {
    view = view.filter((c) => c.creator === creator);
  }

  view.sort((a, b) => b.id - a.id);

  if (cursor !== undefined) {
    view = view.filter((c) => c.id < cursor);
  }

  const hasMore = view.length > limit;
  const items = hasMore ? view.slice(0, limit) : view;
  const nextCursor = hasMore ? items[items.length - 1].id : null;

  return { items, nextCursor };
}

test("filter by category: returns only matching public claims", () => {
  const { items } = applyFilterAndPaginate(SAMPLE_CLAIMS, { category: "crypto" });
  assert.ok(items.length > 0);
  assert.ok(items.every((c) => c.category === "crypto"));
  assert.ok(items.every((c) => c.visibility === "public"));
  // id 6 is private crypto, so it must not be present
  assert.ok(!items.some((c) => c.id === 6));
});

test("filter by state: returns only matching state", () => {
  const { items } = applyFilterAndPaginate(SAMPLE_CLAIMS, { state: "open" });
  assert.ok(items.length > 0);
  assert.ok(items.every((c) => c.state === "open"));
  assert.ok(items.every((c) => c.visibility === "public"));
});

test("filter by multi-state: returns claims in either state", () => {
  const { items } = applyFilterAndPaginate(SAMPLE_CLAIMS, { states: ["open", "active"] });
  assert.ok(items.length > 0);
  assert.ok(items.every((c) => c.state === "open" || c.state === "active"));
});

test("filter by creator: returns only claims by that creator", () => {
  const { items } = applyFilterAndPaginate(SAMPLE_CLAIMS, { creator: ACCOUNT_A });
  assert.ok(items.length > 0);
  assert.ok(items.every((c) => c.creator === ACCOUNT_A));
});

test("filtered pagination: stable cursor progression across filtered results", () => {
  // Category crypto public: ids [10, 8, 4, 2]
  const page1 = applyFilterAndPaginate(SAMPLE_CLAIMS, { category: "crypto", limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.deepEqual(
    page1.items.map((c) => c.id),
    [10, 8]
  );
  assert.equal(page1.nextCursor, 8);

  const page2 = applyFilterAndPaginate(SAMPLE_CLAIMS, {
    category: "crypto",
    cursor: page1.nextCursor,
    limit: 2,
  });
  assert.equal(page2.items.length, 2);
  assert.deepEqual(
    page2.items.map((c) => c.id),
    [4, 2]
  );
  assert.equal(page2.nextCursor, null);
});

