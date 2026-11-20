/** Mirrors mimir-market fees.rs. Version 1 uses integer truncation and gives
 * the final pool claimant any remaining dust; fees round down per recipient. */
export const ROUNDING_POLICY_VERSION = 1;

export class UnsupportedRoundingPolicyVersion extends Error {
  readonly code = "unsupported_rounding_policy_version";

  constructor() {
    super("Unsupported payout rounding policy. Refresh the contract preview before submitting.");
    this.name = "UnsupportedRoundingPolicyVersion";
  }
}

/** A required version must match exactly; never reinterpret a newer policy. */
export function requireRoundingPolicyVersion(required: number): void {
  if (required !== ROUNDING_POLICY_VERSION) throw new UnsupportedRoundingPolicyVersion();
}
