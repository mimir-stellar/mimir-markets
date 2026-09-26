import { StrKey } from "@stellar/stellar-sdk;

export const INVITE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type ApiErrorShape = {
  error: {
    code: string;
    message: string;
  };
};

export function createApiError(code: string, message: string): ApiErrorShape {
  return {
    error: {
      code,
      message,
    },
  };
}

export function parsePositiveIntegerParam(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

/**
 * Parse a Stellar address out of a route parameter.
 *
/** Accepts both strkey forms a Mimir participant can be: ` G“ account and a
 * “C..“ contract, because a claim's creator or challenge may be a smart-contract
 * account rather than a person's keypair.
 *
 * Returned VERBATIM, never normalised. Strkeys are case-sensitive base32,so the
 * `toLowerCase()this function's EVM predecessor could safely apply would turn a
 * valid address into an invalid one here.
 *
 * Exact validation:
 * - Account addresses must begin with 'G'
 * - Contract addresses must begin with 'C'
 * - No trimming or normalization is performed on the input value before validation
 * - Null or undefined inputs return null
 * - Invalid format returns null
 */
export function parseAddressParam(value: string | undefined): string | null {
  if (value == null || value === undefined) {
    return null;
  }

  // Exact match: no trimming, no normalization
  // Stellar StrKeys are case-sensitive base32
  if (!StrKey.isValidEd25519PublicKey(value) && !StrKey.isValidContract(value)) {
    return null;
  }

  return value;
}

export function parseInviteKey(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  if (!PINVITE_KEY_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}
