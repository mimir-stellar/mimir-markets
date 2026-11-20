/**
 * Generation-based read-index rebuild and atomic cutover — DB-bound half.
 *
 * Candidate projections are staged into `read_index_candidate_generations`
 * without touching the live projection tables (`claims`, `challengers`,
 * `sync_meta`, settlement/fee tables). Cutover runs inside a single Postgres
 * transaction ONLY after `verifyCandidateGeneration` confirms archive
 * integrity, privacy, SHA-256 fingerprint, and ledger coverage.
 */

import type { Pool } from "@neondatabase/serverless";
import { getDb } from "@/lib/db";
import {
  READ_INDEX_TABLES,
  parseBackup,
  serializeBackup,
  makeBackup,
  type BackupTables,
  type ReadIndexTableName,
} from "@/lib/ops/cache-backup";
import {
  ACTIVE_GENERATION_CUTOVER_AT_META_KEY,
  ACTIVE_GENERATION_FINGERPRINT_META_KEY,
  ACTIVE_GENERATION_LEDGER_META_KEY,
  ACTIVE_GENERATION_META_KEY,
  CLAIM_EVENTS_CURSOR_META_KEY,
  ReadIndexGenerationCoordinator,
  type ActiveGenerationState,
  type CandidateGeneration,
  type CandidateVerificationRequirements,
  type CutoverResult,
  type ReadIndexGenerationStore,
} from "@/lib/ops/read-index-generation";
import {
  buildUpsertStatements,
  requireBackupEnv,
} from "@/lib/server/read-index-backup";

const CANDIDATE_TABLE = "read_index_candidate_generations";

async function ensureCandidateTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CANDIDATE_TABLE} (
      generation_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      ledger BIGINT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged',
      staged_at BIGINT NOT NULL,
      cutover_at BIGINT
    )
  `);
}

function parseOptionalInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export class PostgresReadIndexGenerationStore implements ReadIndexGenerationStore {
  constructor(private readonly poolProvider: () => Promise<Pool> = getDb) {}

  async getActiveGeneration(): Promise<ActiveGenerationState> {
    const pool = await this.poolProvider();
    const res = await pool.query(
      `SELECT key, value FROM sync_meta WHERE key = ANY($1::text[])`,
      [
        [
          ACTIVE_GENERATION_META_KEY,
          ACTIVE_GENERATION_FINGERPRINT_META_KEY,
          ACTIVE_GENERATION_LEDGER_META_KEY,
          ACTIVE_GENERATION_CUTOVER_AT_META_KEY,
          CLAIM_EVENTS_CURSOR_META_KEY,
        ],
      ],
    );

    const map = new Map<string, string>();
    for (const row of res.rows as Array<{ key: string; value: string }>) {
      map.set(row.key, row.value);
    }

    const activeLedger =
      parseOptionalInt(map.get(ACTIVE_GENERATION_LEDGER_META_KEY)) ??
      parseOptionalInt(map.get(CLAIM_EVENTS_CURSOR_META_KEY));

    return {
      generationId: map.get(ACTIVE_GENERATION_META_KEY) ?? null,
      fingerprint: map.get(ACTIVE_GENERATION_FINGERPRINT_META_KEY) ?? null,
      ledger: activeLedger,
      cutoverAt: parseOptionalInt(map.get(ACTIVE_GENERATION_CUTOVER_AT_META_KEY)),
    };
  }

  async saveCandidate(candidate: CandidateGeneration): Promise<void> {
    const pool = await this.poolProvider();
    await ensureCandidateTable(pool);
    const envelope = makeBackup(candidate.tables, { createdAt: candidate.stagedAt });
    const payloadJson = serializeBackup(envelope);
    await pool.query(
      `INSERT INTO ${CANDIDATE_TABLE}
         (generation_id, fingerprint, ledger, payload_json, status, staged_at, cutover_at)
       VALUES ($1, $2, $3, $4, 'staged', $5, NULL)
       ON CONFLICT (generation_id) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         ledger = excluded.ledger,
         payload_json = excluded.payload_json,
         status = 'staged',
         staged_at = excluded.staged_at,
         cutover_at = NULL`,
      [
        candidate.generationId,
        candidate.fingerprint,
        candidate.ledger,
        payloadJson,
        candidate.stagedAt,
      ],
    );
  }

  async loadCandidate(generationId: string): Promise<CandidateGeneration | null> {
    const pool = await this.poolProvider();
    await ensureCandidateTable(pool);
    const res = await pool.query(
      `SELECT generation_id, fingerprint, ledger, payload_json, staged_at
         FROM ${CANDIDATE_TABLE}
        WHERE generation_id = $1`,
      [generationId],
    );
    const row = res.rows[0] as
      | {
          generation_id: string;
          fingerprint: string;
          ledger: string | number | null;
          payload_json: string;
          staged_at: string | number;
        }
      | undefined;
    if (!row) return null;

    const backup = parseBackup(row.payload_json);
    return {
      generationId: row.generation_id,
      tables: backup.tables,
      fingerprint: row.fingerprint,
      ledger: parseOptionalInt(row.ledger),
      stagedAt: parseOptionalInt(row.staged_at) ?? 0,
    };
  }

  async atomicCutover(
    candidate: CandidateGeneration,
    cutoverAt: number,
  ): Promise<ActiveGenerationState> {
    const pool = await this.poolProvider();
    await ensureCandidateTable(pool);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Replace all read-index projection tables atomically inside the transaction.
      // Delete in reverse dependency order, then upsert verified candidate rows.
      const deleteOrder: ReadIndexTableName[] = [...READ_INDEX_TABLES].reverse();
      for (const table of deleteOrder) {
        await client.query(`DELETE FROM ${table}`);
      }

      for (const table of READ_INDEX_TABLES) {
        const statements = buildUpsertStatements(table, candidate.tables[table]);
        for (const stmt of statements) {
          await client.query(stmt.sql, stmt.args);
        }
      }

      // Record active generation pointer in sync_meta inside the same transaction.
      const metaEntries: Array<[string, string]> = [
        [ACTIVE_GENERATION_META_KEY, candidate.generationId],
        [ACTIVE_GENERATION_FINGERPRINT_META_KEY, candidate.fingerprint],
        [ACTIVE_GENERATION_CUTOVER_AT_META_KEY, String(cutoverAt)],
      ];
      if (candidate.ledger !== null) {
        metaEntries.push([ACTIVE_GENERATION_LEDGER_META_KEY, String(candidate.ledger)]);
      }

      for (const [key, value] of metaEntries) {
        await client.query(
          `INSERT INTO sync_meta (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          [key, value],
        );
      }

      await client.query(
        `UPDATE ${CANDIDATE_TABLE}
            SET status = CASE WHEN generation_id = $1 THEN 'active' ELSE 'superseded' END,
                cutover_at = CASE WHEN generation_id = $1 THEN $2 ELSE cutover_at END
          WHERE status = 'active' OR generation_id = $1`,
        [candidate.generationId, cutoverAt],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    return {
      generationId: candidate.generationId,
      fingerprint: candidate.fingerprint,
      ledger: candidate.ledger,
      cutoverAt,
    };
  }
}

export function createReadIndexGenerationCoordinator(
  store: ReadIndexGenerationStore = new PostgresReadIndexGenerationStore(),
): ReadIndexGenerationCoordinator {
  return new ReadIndexGenerationCoordinator(store);
}

/**
 * High-level helper: stage a candidate projection into Postgres, verify its
 * fingerprint and ledger coverage, and atomically cut readers over only if
 * all checks pass.
 */
export async function rebuildAndCutoverReadIndex(options: {
  generationId: string;
  tables: BackupTables;
  expectedFingerprint?: string;
  requiredMinLedger?: number;
  expectedMinClaimCount?: number;
  allowEmpty?: boolean;
  stagedAt?: number;
  cutoverAt?: number;
  store?: ReadIndexGenerationStore;
}): Promise<CutoverResult> {
  if (!options.store) {
    requireBackupEnv();
  }
  const coordinator = createReadIndexGenerationCoordinator(options.store);
  await coordinator.stageCandidate(
    options.generationId,
    options.tables,
    options.stagedAt,
  );
  return coordinator.cutover(options.generationId, {
    expectedFingerprint: options.expectedFingerprint,
    requiredMinLedger: options.requiredMinLedger,
    expectedMinClaimCount: options.expectedMinClaimCount,
    allowEmpty: options.allowEmpty,
    cutoverAt: options.cutoverAt,
  });
}

export type {
  ActiveGenerationState,
  CandidateGeneration,
  CandidateVerificationRequirements,
  CutoverResult,
  ReadIndexGenerationStore,
};
