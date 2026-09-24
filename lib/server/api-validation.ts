import { StrKey } from "@stellar/stellar-sdk";

export const INVITE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type ApiErrorShape = {
  error: {
    code: string;
    message: string;
    requestId?: string;
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
 * Accepts both strkey forms a Mimir participant can be: a `G…` account and a
 * `C…` contract, because a claim's creator or challenger may be a smart-contract
 * account rather than a person's keypair.
 *
 * Returned VERBATIM, never normalised. Strkeys are case-sensitive base32, so the
 * `toLowerCase()` this function's EVM predecessor could safely apply would turn a
 * valid address into an invalid one here.
 */
export function parseAddressParam(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (!StrKey.isValidEd25519PublicKey(trimmed) && !StrKey.isValidContract(trimmed)) {
    return null;
  }
  return trimmed;
}

export function parseInviteKey(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }

  if (!INVITE_KEY_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}
