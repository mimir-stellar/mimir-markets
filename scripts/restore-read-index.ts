/**
 * Restore a verified read-index cache backup archive.
 *
 *   npm run restore:read-index -- backups/read-index.json
 *   npm run restore:read-index -- backups/read-index.json --dry-run
 *   npm run restore:read-index -- backups/read-index.json --batch-size 50
 *
 * Requires DATABASE_URL. The archive must verify (checksum + privacy) before a
 * single write starts; writes run in checkpointed transactions (or a single transaction
 * when --batch-size is omitted); and after commit the tables are re-read and
 * fingerprinted against the archive's checksum.
 *
 * Exit codes: 0 restored & verified · 1 unverified archive or restore drift ·
 * 2 usage error.
 */
import { readFileSync } from "node:fs";

import { formatCacheBackupReport } from "../lib/ops/cache-backup";
import { restoreReadIndexFromBackup } from "../lib/server/read-index-backup";

function parseArgs(argv: string[]): { path: string; dryRun: boolean; batchSize?: number } {
  let batchSize: number | undefined;
  const batchIdx = argv.indexOf("--batch-size");
  if (batchIdx !== -1 && argv[batchIdx + 1]) {
    const parsed = Number(argv[batchIdx + 1]);
    if (Number.isInteger(parsed) && parsed > 0) {
      batchSize = parsed;
    }
  }

  const dryRun = argv.includes("--dry-run");
  const args = argv.filter(
    (arg, i) => arg !== "--dry-run" && arg !== "--batch-size" && (batchIdx === -1 || i !== batchIdx + 1),
  );
  const [path] = args;
  if (!path) {
    throw new Error("usage: npm run restore:read-index -- <archive.json> [--dry-run] [--batch-size <n>]");
  }
  return { path, dryRun, batchSize };
}

async function main(): Promise<void> {
  const { path, dryRun, batchSize } = parseArgs(process.argv.slice(2));
  const archiveText = readFileSync(path, "utf8");

  const result = await restoreReadIndexFromBackup(archiveText, { dryRun, batchSize });

  const action = dryRun ? "dry-run (no writes)" : "restored";
  console.log(
    `[restore] ${action} ${result.restored.length} tables: ` +
      result.restored.map((t) => `${t.table}=${t.rows}`).join(" "),
  );

  const verification = formatCacheBackupReport(result.verify);
  console.log(`[restore] post-restore verification — ${verification}`);

  if (result.applied && !result.verify.ok) {
    console.error(
      "[restore] the cache does not match the archive. Re-apply the archive or " +
        "re-warm from chain (`npm run warm:vs-index` / `npm run sync`).",
    );
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("[restore] failed:", message);
  process.exit(message.startsWith("usage:") ? 2 : 1);
});