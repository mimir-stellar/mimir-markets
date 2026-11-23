/**
 * Reproducible artifact and schema support bundle — CLI.
 *
 *   npm run report:support-bundle              # print the bundle to stdout
 *   npm run report:support-bundle -- --json    # machine-readable JSON
 *   npm run report:support-bundle -- --out bundle.json   # write to disk
 *   npm run report:support-bundle -- --mode=release   # release mode for artifact provenance
 *
 * Reproducible from a clean checkout: reads only tracked repo files, runs the
 * offline schema snapshot, artifact provenance and release readiness checks,
 * and never reads `.env`, a database URL, a seed or any other production
 * credential.
 *
 * Exit codes:
 *   0  the bundle was produced with no error-severity findings
 *   1  the bundle has error findings or could not be produced
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSupportBundle,
  formatSupportBundle,
  serializeSupportBundle,
} from "../lib/ops/release-support-bundle";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

interface Args {
  json: boolean;
  out?: string;
  mode: "develop" | "release";
  requireBuilt: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = new Set(argv);
  let out: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out" && argv[i + 1] && !argv[i + 1].startsWith("-")) {
      out = argv[i + 1];
    } else if (argv[i].startsWith("--out=")) {
      out = argv[i].slice("--out=".length);
    }
  }

  return {
    json: args.has("--json"),
    out,
    mode:
      args.has("--mode=release") || args.has("--release")
        ? "release"
        : "develop",
    requireBuilt: !args.has("--no-require-built"),
    help: args.has("--help") || args.has("-h"),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      [
        "Usage: node scripts/report-support-bundle.ts [options]",
        "",
        "  --json              print the bundle as JSON instead of text",
        "  --out <file>        write the deterministic bundle to disk",
        "  --mode=release      release mode for artifact provenance (unpinned digests are errors)",
        "  --no-require-built  do not require Wasm files to exist on disk",
        "",
        "Exit codes:",
        "  0  bundle produced with no error-severity findings",
        "  1  bundle has error findings or could not be produced",
      ].join("\n"),
    );
    return;
  }

  let bundle;
  try {
    bundle = buildSupportBundle({
      repoRoot: REPO_ROOT,
      artifactMode: args.mode,
      artifactRequireBuilt: args.requireBuilt,
    });
  } catch (error) {
    console.error(
      `✗ support bundle failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (args.json) {
    console.log(JSON.stringify(bundle, null, 2));
  } else {
    console.log(formatSupportBundle(bundle));
  }

  if (args.out) {
    const outPath = path.resolve(process.cwd(), args.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, serializeSupportBundle(bundle), "utf8");
    console.log(
      `  · support bundle → ${path.relative(REPO_ROOT, outPath) || args.out}`,
    );
  }

  if (!bundle.ok) process.exit(1);
}

main();
