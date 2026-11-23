/**
 * Fail-closed changed-path classification for CI.
 *
 * The one rule this module encodes: CI decides what to run from an *allowlist.
 * A changed path either matches a known scope and enables it, or it matches
 * nothing and is UNKNOWN. Unknown paths fail the path job — they never
 * silently skip the suites they were invisible to. Filters that fail open are
 * worse than no filters at all: they turn a green check into a lie about what
 * was actually verified.
 *
 * Consumers:
 *  - `scripts/ci/changed-paths.mjs` re-implements the classification contract
 *    for the workflow driver (plain Node, no TS pipeline — see that file).
 *  - `tests/node/ci-path-scope.test.ts` pins the behaviour that matters:
 *    defaults, shared-file fan-out, doc-only exclusion, and the fail-closed
 *    default. If this file and the driver ever drift, those tests plus
 *    `check:driver-parity` are what catch it.
 *
 * Keep in sync with `scripts/ci/changed-paths.mjs` (same lists, same rules).
 * See `docs/CI_PATH_SCOPES.md` for the tier matrix and the checklist for
 * adding a new path.
 */

export type Tier = "app" | "agents" | "contracts" | "tests";

/** Tier-level prefixes: a change inside the directory is that tier's change. */
export const PREFIX_SCOPES: ReadonlyArray<readonly [string, Tier]> = [
  ["app/", "app"],
  ["components/", "app"],
  ["hooks/", "app"],
  ["i18n/", "app"],
  ["messages/", "app"],
  ["public/", "app"],
  ["examples/", "app"],
  ["sdk/", "app"],

  // Shared code: imported by the Next.js server, the workers and the node
  // tests alike, so a change here enables all three Node tiers (contracts has
  // its own Rust toolchain and shares nothing with lib/).

  ["lib/", "app"],
  ["lib/", "agents"],
  ["lib/", "tests"],

  ["agents/", "agents"],
  ["deploy/", "agents"],

  ["contracts-soroban/", "contracts"],

  ["tests/", "tests"],
  ["scripts/", "tests"],
  // Replay and contract fixtures are read by node tests and release readiness.
  ["fixtures/", "tests"],
  [".github/", "tests"],
];

/** File-level scopes: a change to one of these files is that tier's change. */
export const FILE_SCOPES: ReadonlyArray<readonly [string, Tier]> = [
  ["proxy.ts", "app"],

  ["tsconfig.json", "app"],
  ["next.config.js", "app"],
  ["tailwind.config.ts", "app"],
  ["postcss.config.js", "app"],

  ["package.json", "app"],
  ["package-lock.json", "app"],
  ["npm-shrinkwrap.json", "app"],

  ["tsconfig.json", "agents"],
  ["package.json", "agents"],
  ["package-lock.json", "agents"],
  ["npm-shrinkwrap.json", "agents"],

  ["package.json", "tests"],
  ["package-lock.json", "tests"],
  ["npm-shrinkwrap.json", "tests"],

  ["proxy.ts", "agents"],
];

/**
 * Files that sit outside any tier but affect every one of them. Workflow and
 * tooling files are deliberately NOT here: the tests tier owns `.github/` and
 * `scripts/`, which is where those live.
 */
export const SHARED_FILES: ReadonlySet<string> = new Set([
  ".env.example",
  ".nvmrc",
  ".gitattributes",
  ".gitignore",
]);

/**
 * Top-level entries that are documentation-only: touching these disables
 * nothing. Anything at the root that is NOT in this list or in a scope above
 * is UNKNOWN — the point is that adding a file here is an explicit,
 * reviewed decision, not a silent default.
 */
export const DOC_ONLY: ReadonlySet<string> = new Set([
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
]);

/**
 * Docs directories: the same doc-only carve-out by prefix.
 */
export const DOC_ONLY_PREFIXES: ReadonlyArray<string> = ["docs/"];

/**
 * What a changed path means for CI. `shared` enables every tier; `doc` is the
 * only outcome that enables nothing (still fail-closed: it is an explicit
 * classification, not a miss); `unknown` fails the path job.
 */
export type Scope = { kind: "scoped"; tiers: ReadonlySet<Tier> } | { kind: "doc" } | { kind: "unknown" };

export const ALL_TIERS: ReadonlySet<Tier> = new Set<Tier>(["app", "agents", "contracts", "tests"]);

/**
 * Cross-workspace compatibility report.
 *
 * Compares app, bindings, contracts and schema versions read from tracked
 * artifacts (passed in as plain data, never fetched live) and lists every
 * incompatible combination. Pure and offline: no network, no service calls.
 */
export type WorkspaceVersions = {
  app: string;
  bindings: string;
  contracts: string;
  schema: string;
};

export type CompatibilityRule = {
  /** Which workspace pair the rule constrains. */
  dimension: "app" | "bindings" | "contracts" | "schema";
  /** Value the dimension must match for the report to be compatible. */
  expected: string;
};

export type CompatibilityIssue = {
  dimension: CompatibilityRule["dimension"];
  expected: string;
  actual: string;
};

export type CompatibilityReport = {
  compatible: boolean;
  issues: CompatibilityIssue[];
};

/**
 * Build an offline compatibility report from tracked versions and rules.
 * Missing or empty versions are reported as incompatible (fail closed).
 */
export function buildCompatibilityReport(
  versions: WorkspaceVersions,
  rules: ReadonlyArray<CompatibilityRule>,
): CompatibilityReport {
  const issues: CompatibilityIssue[] = [];
  for (const rule of rules) {
    const actual = versions[rule.dimension];
    if (!actual || actual !== rule.expected) {
      issues.push({
        dimension: rule.dimension,
        expected: rule.expected,
        actual: actual ?? "",
      });
    }
  }
  return { compatible: issues.length === 0, issues };
}

/** True when the path is a bare top-level entry (`foo`, not `foo/bar`). */
function isRootLevel(path: string): boolean {
  return !path.includes("/");
}

function scopesFor(path: string): Set<Tier> | "doc" | undefined {
  if (SHARED_FILES.has(path)) return new Set(ALL_TIERS);
  if (isRootLevel(path) && DOC_ONLY.has(path)) return "doc";
  for (const prefix of DOC_ONLY_PREFIXES) {
    if (path.startsWith(prefix)) return "doc";
  }
  const tiers = new Set<Tier>();
  for (const [prefix, tier] of PREFIX_SCOPES) {
    if (path.startsWith(prefix)) tiers.add(tier);
  }
  for (const [file, tier] of FILE_SCOPES) {
    if (path === file) tiers.add(tier);
  }
  return tiers.size > 0 ? tiers : undefined;
}

/**
 * Classify a single changed path.
 *
 * Root-level entries get the strictest treatment: any bare file at the repo
 * root that is not explicitly classified is UNKNOWN, because a new root file
 * (a config, a manifest, a script) is exactly the kind of change that can
 * alter how every tier builds and runs.
 */
export function scopeOf(path: string): Scope {
  const tiers = scopesFor(path);
  if (tiers === undefined) return { kind: "unknown" };
  if (tiers === "doc") return { kind: "doc" };
  return { kind: "scoped", tiers };
}

/** The tier set a whole change enables. `unknown` propagates — fail closed. */
export function scopesForPaths(paths: ReadonlyArray<string>): Scope {
  const tiers = new Set<Tier>();
  for (const path of paths) {
    const scope = scopeOf(path);
    if (scope.kind === "unknown") return { kind: "unknown" };
    if (scope.kind === "doc") continue;
    for (const tier of scope.tiers) tiers.add(tier);
  }
  if (tiers.size === 0) return { kind: "doc" };
  return { kind: "scoped", tiers };
}

/**
 * Validate that a package export or script target is a safe, in-checkout path.
 *
 * Rejects absolute paths, path traversal (`..` segments), and paths that
 * resolve outside the checkout root. Callers must still verify existence
 * before packaging; this function is purely lexical.
 */
export function validateCheckoutPath(
  target: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (target.length === 0) return { ok: false, reason: "empty path" };
  if (target.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith("\\")) {
    return { ok: false, reason: `absolute path not allowed: ${target}` };
  }
  const segments = target.split(/[\\/]+/);
  if (segments.includes("..")) {
    return { ok: false, reason: `path traversal not allowed: ${target}` };
  }
  const normalized = segments.filter((s) => s !== "" && s !== ".").join("/");
  if (normalized.length === 0) return { ok: false, reason: "empty path" };
  return { ok: true, path: normalized };
}

/** Every known tier — used by the fallback and by default-on matrices. */
export function allTiers(): readonly Tier[] {
  return [...ALL_TIERS];
}
