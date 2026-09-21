/**
 * Clock policy for demo seed previews.
 *
 * Dry runs must be reproducible and must not depend on a wallet, network, or
 * the machine clock. Live seeding remains relative to the current time so
 * deadlines are useful when claims are actually submitted.
 */

export const DEFAULT_DEMO_SEED_NOW = 1_767_225_600; // 2026-01-01T00:00:00Z

export interface SeedClockOptions {
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function resolveSeedNow({ dryRun, env = process.env, now = Date.now }: SeedClockOptions): number {
  if (!dryRun) return Math.floor(now() / 1000);

  const configured = env.DEMO_SEED_NOW?.trim();
  if (!configured) return DEFAULT_DEMO_SEED_NOW;
  if (!/^\d+$/.test(configured)) {
    throw new Error("DEMO_SEED_NOW must be a Unix timestamp in seconds");
  }

  const timestamp = Number(configured);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error("DEMO_SEED_NOW must be a positive safe Unix timestamp in seconds");
  }
  return timestamp;
}
