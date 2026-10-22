/**
 * Read-only contract helpers.
 *
 * Houses the raw contract read paths (single claim and range queries) that
 * wrap the generated bindings client. No state-changing logic lives here.
 */

import { getContractClient } from './client';

export interface RawClaim {
  id: bigint;
  creator: string;
  amount: bigint;
  status: number;
  createdAt: bigint;
  expiresAt: bigint;
  metadataURi?: string;
}

export interface RawClaimRange {
  claims: RawClaim[];
  nextCursor?: bigint;
  total: number;
}

/**
 * Maximum number of claims the contract's `get_claims_batch` view returns
 * per call.
 */
const CLAIMS_BATCH_SIZE = 50;

const MAX_CONCURRENCY = 5;

let batchViewUnavailable = false;

/**
 * Fetch a single claim by id directly from the contract.
 * Returns null when the claim does not exist.
 */
export async function readClaimRaw(id: bigint | number | string): Promise<RawClaim | null> {
  const client = getContractClient();
  const claimId = toBigIntSafe(id);
  try {
    const result = await client.readClaim({ id: claimId });
    if (!result) {
      return null;
    }
    return normalizeRawClaim(result);
  } catch (err) {
    if (isNotFoundError(err)) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetch a page of claims within a cursor range.
 *
 * Uses the contract's batch view (`get_claims_batch`) in chunks of
 * {@const CLAIMS_BATCH_SIZE}, preserving order and returning `null` for missing
 * ids. Falls back to the per-id path when the deployed contract lacks the
 * method (logged once).
 */
export async function readClaimsRange(
  startCursor: bigint | number | string = 0,
  limit: number = 20,
): Promise<RawClaimRange> {
  const client = getContractClient();
  const cursor = toBigIntSafe(startCursor);
  const count = Math.max(0, Math.floor(limit));

  if (count === 0) {
    return { claims: [], nextCursor: undefined, total: 0 };
  }

  const ids = Array.from({ length: count }, (_, i) => cursor + BigInt(i));

  if (!batchViewUnavailable && typeof (client as any).getClaimsBatch === 'function') {
    try {
      const rawClaims = await readClaimsBatch(client as any, ids);
      const claims = rawClaims.map((claim) => (claim ? normalizeRawClaim(claim) : null));
      return buildRangeResult(claims, count);
    } catch (err) {
      if (isMissingMethodError(err)) {
        batchViewUnavailable = true;
        console.warn(
          '[contract] get_claims_batch unavailable on deployed contract; falling back to per-id reads',
        );
      } else {
        throw err;
      }
    }
  }

  const claims = await mapWithConcurrency(ids, MAX_CONCURRENCY, (id) => readClaimRaw(id));
  return buildRangeResult(claims, count);
}

async function readClaimsBatch(client: any, ids: bigint[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let offset = 0; offset < ids.length; offset += CLAIMS_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + CLAIMS_BATCH_SIZE);
    const response = await client.getClaimsBatch({ ids: chunk });
    const claims = Array.isArray(response) ? response : (response?.claims ?? []);
    for (let i = 0; i < chunk.length; i++) {
      results.push(claims[i] ?? null);
    }
  }
  return results;
}

function buildRangeResult(claims: (RawClaim | null)[], count: number): RawClaimRange {
  const present = claims.filter((claim): claim is RawClaim => claim !== null);
  return {
    claims,
    nextCursor: count > 0 ? undefined : undefined,
    total: present.length,
  };
}

function normalizeRawClaim(input: any): RawClaim {
  return {
    id: toBigInt(input.id),
    creator: String(input.creator),
    amount: toBigInt(input.amount),
    status: Number(input.status),
    createdAt: toBigInt(input.createdAt),
    expiresAt: toBigInt(input.expiresAt),
    metadataUri: input.metadataUri ?? input.metadataURi ?? undefined,
  };
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string') {
    try {
      return BigInt(value);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function toBigIntSafe(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid claim id: ${value}`);
    return BigInt(value);
  }
  return BigInt(value);
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = String((err as { message?: unknown }).message ?? '').toLowerCase();
  return message.includes('not found') || message.includes('notfound');
}

function isMissingMethodError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const message = String(
    (err as { message?: unknown; code?: unknown }).message ?? (err as { code?: unknown }).code ?? '',
  ).toLowerCase();
  return (
    message.includes('method not found') ||
    message.includes('missing method') ||
    message.includes('not implemented') ||
    message.includes('unknown method') ||
    message.includes('no such method') ||
    message.includes('getclaimsbatch') ||
    message.includes('get_claims_batch')
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}
