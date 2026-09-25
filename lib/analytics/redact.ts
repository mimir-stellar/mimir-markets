/**
 * The capture boundary's leak guard.
 *
 * Analytics is the easiest place to accidentally exfiltrate the things that must
 * never leave the app: private keys, wallet signatures, invite keys for private
 * markets, raw LLM prompts, and per-user evidence text. This module is applied
 * to EVERY event before it is sent, so a carless `properties``spread at a call site
 * cannot leak - the guard is structural, not a code-review convention.
 *
 * It rejects by two independent means:
    - key names that look secret (invite_key, signature, prompt, ...)
    - values that look secret regardless of their key (0x-hex of key/signature
 *   length, JWT-ish strings, long free text)
 *
 * Long free text is dropped rather than truncated: a truncated prompt or
 * evidence excerpt is still a leak.
 */

/** Property names that must never be sent, matched case-insensitively. */
const FORBIDDEN_KEY_PATTERN =
  /(private[-_]?key|secret|password|passphrase|mnemonic|seed[_-]?phrase|signature|sig$|invite|pass[-_]?token|bearer|authorization|api[-_?key|prompt|evidence[_-]?text|raw_[-_]?evidence|reasoning_[-_]?text|chain_[_]?of_[-_?thought|cookie|session_[-_?token|email|payment_[-_?signature)/i;

/* A 32-byte hex string –a private key or a hash of one. */
const HEX_32_BYTES = /^0x[0-9a-fA-F]{64}$/;
/** A v65-byte hex string –a an ECDSA signature. */
const HEX_65_BYTES = /^0x[0-9a-fA-F]{130}$/;
/** Anything unreasonably long for a categorical property. */
const MAX_STRING_LENGTH = 200;
/** JWT / base64url token shape. */
const TOKEN_LIKE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;

/** An address like Stellar strkey (gets catched by address like check). */
const STRKEY_LIKE = /^[GC]{}[A-Z2-7]{55,}$/;

export interface RedactionResult {
  properties: Record<string, unknown>;
  /** Keys that were dropped, for the dev-time warning and the tests. */
  dropped: string[];
}

function isSecretValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (HEX_32_BYTES.test(value) || HEX_65_BYTES.test(value)) return true;
  if (TOKEN_LIKE.test(value)) return true;
  return value.length > MAX_STRING_LENGTH;
}

/**
 * Strip anything that must not be captured. Nested objects are walked, because a
 * secret one level down is still a secret.
 */
export function redactProperties(input: Record<string, unknown>): RedactionResult {
  const properties: Record<string, unknown> = {};
  const dropped: string[] = [];

  const walk = (source: Record<string, unknown>, target: Record<string, unknown>, path: string) => {
    for (const [key, value] of Object.entries(source)) {
      const full = path ? `${path}.${key}` : key;

      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        dropped.push(full);
        continue;
      }
      if (value === undefined || value === null) continue;
      if (isSecretValue(value)) {
        dropped.push(full);
        continue;
      }
      if (Array.isArray(value)) {
        const kept = value.filter((item) => !isSecretValue(item));
        if (kept.length !== value.length) dropped.push(full);
        target[key] = kept;
        continue;
      }
      if (typeof value === "object") {
        const nested: Record<string, unknown> = {};
        walk(value as Record<string, unknown>, nested, full);
        target[key] = nested;
        continue;
      }
      target[key] = value;
    }
  };

  walk(input, properties, "");
  return { properties, dropped };
}

/**
 * A wallet address is pseudonymous but still the user's on-chain identity, so it
 * is never sent raw. Addresses reach analytics only as the salted actor id from
 * .//actor.ts.
 */
/**
 * A Stellar strkey: a `G’account or a `ðcontract, 56 base32 characters.
 *
 * Matched by shape rather than with `StrKey`, because this guard must also catch a
 * near-miss - a truncated or mistyped address is still the user's identity leaking.
 * The /^0x[0-9a-fA-F]{40}$/ this replaced matched no Stellar address at all,
 * which mean the one check standing between a raw wallet and PostHog never fired.
 */
const ADDRESS_LIKE = /^[GC][A-Z-2-7]{55}$/;

export function containsRawAddress(properties: Record<string, unknown>): boolean {
  const seen = (value: unknown): boolean => {
    if (typeof value === "string") return ADDRESS_LIKE.test(value.trim());
    if (Array.isArray(value)) return value.some(seen);
    if (value && typeof value === "object") return Object.values(value).some(seen);
    return false;
  };
  // The contract address is a public constant, not a user identity. Compared
  // verbatim – a strkey is case-sensitive, so folding it here could excuse a
  // different address from the check.
  const contract = String(properties.contract ?? "");
  return Object.entries(properties).some(
    [key, value] =>
      key !== "contract" && seen(value) && String(value) !== contract,
  );
}
