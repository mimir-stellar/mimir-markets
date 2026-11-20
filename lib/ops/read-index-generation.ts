/**
 * Generation-based read-index rebuild and atomic cutover — pure verification
 * and state-machine half (zero DB or network dependencies).
 *
 * A candidate read-index projection is built and staged separately from the
 * active reader tables. Readers are switched to the candidate generation ONLY
 * after:
 *   1. Archive / table integrity and privacy checks pass (`verifyCacheBackup`)
 *   2. Candidate fingerprint matches the expected SHA-256 checksum
 *   3. Ledger coverage checks pass (valid cursor, no regression vs active
 *      generation, and >= required minimum ledger if specified)
 *
 * Any failure leaves the active reader generation completely untouched
 * (fail-closed).
 */

import {
  computeBackupChecksum,
  makeBackup,
  verifyCacheBackup,
  type BackupTables,
  type CacheBackupFinding,
} from "@/lib/ops/cache-backup";

export const ACTIVE_GENERATION_META_KEY = "read_index_active_generation" as const;
export const ACTIVE_GENERATION_FINGERPRINT_META_KEY = "read_index_active_fingerprint" as const;
export const ACTIVE_GENERATION_LEDGER_META_KEY = "read_index_active_ledger" as const;
export const ACTIVE_GENERATION_CUTOVER_AT_META_KEY = "read_index_active_cutover_at" as const;
export const CLAIM_EVENTS_CURSOR_META_KEY = "claim_events_cursor_ledger" as const;

const GENERATION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export type GenerationFindingCode =
  | "CANDIDATE_GENERATION_ID_INVALID"
  | "CANDIDATE_GENERATION_ALREADY_ACTIVE"
  | "CANDIDATE_BACKUP_INVALID"
  | "CANDIDATE_FINGERPRINT_MISMATCH"
  | "CANDIDATE_EMPTY"
  | "CANDIDATE_LEDGER_MISSING"
  | "CANDIDATE_LEDGER_INVALID"
  | "CANDIDATE_LEDGER_REGRESSION"
  | "CANDIDATE_LEDGER_INCOMPLETE"
  | "CANDIDATE_CLAIM_COVERAGE_SHORT";

export interface GenerationFinding {
  code: GenerationFindingCode;
  severity: "error" | "warning";
  message: string;
}

export interface ActiveGenerationState {
  generationId: string | null;
  fingerprint: string | null;
  ledger: number | null;
  cutoverAt: number | null;
}

export interface CandidateGeneration {
  generationId: string;
  tables: BackupTables;
  fingerprint: string;
  ledger: number | null;
  stagedAt: number;
}

export interface CandidateVerificationRequirements {
  /** Currently active generation state (readers' current view). */
  active: ActiveGenerationState;
  /** Expected SHA-256 fingerprint of the candidate projection. */
  expectedFingerprint?: string;
  /** Minimum ledger cursor the candidate must cover (e.g. target chain tip). */
  requiredMinLedger?: number;
  /** Minimum number of claim rows the candidate must contain. */
  expectedMinClaimCount?: number;
  /** Allow an empty candidate projection (default false — fail-closed). */
  allowEmpty?: boolean;
}

export interface CandidateVerificationReport {
  ok: boolean;
  generationId: string;
  fingerprint: string;
  ledger: number | null;
  claimCount: number;
  findings: GenerationFinding[];
  backupFindings: CacheBackupFinding[];
}

export interface CutoverResult {
  ok: boolean;
  switched: boolean;
  previousGeneration: ActiveGenerationState;
  activeGeneration: ActiveGenerationState;
  verification: CandidateVerificationReport;
}

export function isValidGenerationId(generationId: string): boolean {
  return typeof generationId === "string" && GENERATION_ID_PATTERN.test(generationId);
}

/**
 * Extract and validate the indexed ledger cursor from `sync_meta` rows.
 * Returns `null` if missing or not a non-negative integer.
 */
export function extractLedgerCursor(tables: BackupTables): {
  raw: string | null;
  ledger: number | null;
} {
  const metaRows = Array.isArray(tables.sync_meta) ? tables.sync_meta : [];
  const row = metaRows.find((r) => r && r.key === CLAIM_EVENTS_CURSOR_META_KEY);
  if (!row || row.value === undefined || row.value === null) {
    return { raw: null, ledger: null };
  }
  const raw = String(row.value).trim();
  if (!/^\d+$/.test(raw)) {
    return { raw, ledger: null };
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { raw, ledger: null };
  }
  return { raw, ledger: parsed };
}

/**
 * Build a candidate generation record from projection tables.
 * Computes the deterministic SHA-256 fingerprint and extracts ledger coverage.
 */
export function buildCandidateGeneration(
  generationId: string,
  tables: BackupTables,
  stagedAt: number = Date.now(),
): CandidateGeneration {
  const fingerprint = computeBackupChecksum(tables);
  const { ledger } = extractLedgerCursor(tables);
  return {
    generationId,
    tables,
    fingerprint,
    ledger,
    stagedAt,
  };
}

/**
 * Verify a staged candidate generation before allowing atomic cutover.
 * Pure and fail-closed: any integrity, privacy, fingerprint, or ledger
 * coverage violation produces `ok: false`.
 */
export function verifyCandidateGeneration(
  candidate: CandidateGeneration,
  requirements: CandidateVerificationRequirements,
): CandidateVerificationReport {
  const findings: GenerationFinding[] = [];
  let backupFindings: CacheBackupFinding[] = [];

  if (!isValidGenerationId(candidate.generationId)) {
    findings.push({
      code: "CANDIDATE_GENERATION_ID_INVALID",
      severity: "error",
      message: `invalid generationId "${candidate.generationId}" (must match ${GENERATION_ID_PATTERN})`,
    });
  }

  if (
    requirements.active.generationId !== null &&
    candidate.generationId === requirements.active.generationId
  ) {
    findings.push({
      code: "CANDIDATE_GENERATION_ALREADY_ACTIVE",
      severity: "error",
      message: `generation "${candidate.generationId}" is already active; rebuild into a new generation id`,
    });
  }

  // 1. Integrity + privacy check via the canonical backup verifier.
  const recomputedFingerprint = computeBackupChecksum(candidate.tables);
  const backupEnvelope = makeBackup(candidate.tables, { createdAt: candidate.stagedAt });
  const backupReport = verifyCacheBackup(backupEnvelope);
  if (!backupReport.ok) {
    backupFindings = backupReport.findings;
    findings.push({
      code: "CANDIDATE_BACKUP_INVALID",
      severity: "error",
      message: `candidate projection failed integrity/privacy verification: ${backupReport.findings
        .map((f) => `${f.code}: ${f.message}`)
        .join("; ")}`,
    });
  }

  // 2. Fingerprint check (candidate self-consistency + expected fingerprint).
  if (candidate.fingerprint !== recomputedFingerprint) {
    findings.push({
      code: "CANDIDATE_FINGERPRINT_MISMATCH",
      severity: "error",
      message: `candidate fingerprint drift: staged ${candidate.fingerprint}, recomputed ${recomputedFingerprint}`,
    });
  }

  if (
    requirements.expectedFingerprint !== undefined &&
    recomputedFingerprint !== requirements.expectedFingerprint
  ) {
    findings.push({
      code: "CANDIDATE_FINGERPRINT_MISMATCH",
      severity: "error",
      message: `candidate fingerprint ${recomputedFingerprint} does not match expected ${requirements.expectedFingerprint}`,
    });
  }

  const claimCount = Array.isArray(candidate.tables.claims)
    ? candidate.tables.claims.length
    : 0;

  if (!requirements.allowEmpty && claimCount === 0) {
    findings.push({
      code: "CANDIDATE_EMPTY",
      severity: "error",
      message: "candidate projection has 0 claims and allowEmpty is false",
    });
  }

  if (
    requirements.expectedMinClaimCount !== undefined &&
    claimCount < requirements.expectedMinClaimCount
  ) {
    findings.push({
      code: "CANDIDATE_CLAIM_COVERAGE_SHORT",
      severity: "error",
      message: `candidate has ${claimCount} claims, below required minimum ${requirements.expectedMinClaimCount}`,
    });
  }

  // 3. Ledger coverage checks.
  const { raw, ledger } = extractLedgerCursor(candidate.tables);
  if (raw === null) {
    findings.push({
      code: "CANDIDATE_LEDGER_MISSING",
      severity: "error",
      message: `candidate sync_meta is missing ${CLAIM_EVENTS_CURSOR_META_KEY}`,
    });
  } else if (ledger === null) {
    findings.push({
      code: "CANDIDATE_LEDGER_INVALID",
      severity: "error",
      message: `candidate ${CLAIM_EVENTS_CURSOR_META_KEY}="${raw}" is not a valid non-negative integer`,
    });
  } else {
    if (
      requirements.active.ledger !== null &&
      ledger < requirements.active.ledger
    ) {
      findings.push({
        code: "CANDIDATE_LEDGER_REGRESSION",
        severity: "error",
        message: `candidate ledger ${ledger} regresses behind active ledger ${requirements.active.ledger}`,
      });
    }

    if (
      requirements.requiredMinLedger !== undefined &&
      ledger < requirements.requiredMinLedger
    ) {
      findings.push({
        code: "CANDIDATE_LEDGER_INCOMPLETE",
        severity: "error",
        message: `candidate ledger ${ledger} is behind required minimum ledger ${requirements.requiredMinLedger}`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    generationId: candidate.generationId,
    fingerprint: recomputedFingerprint,
    ledger,
    claimCount,
    findings,
    backupFindings,
  };
}

/**
 * Storage adapter interface for generation-based rebuild and atomic cutover.
 * Implemented by both the Postgres backend (`lib/server/read-index-generation.ts`)
 * and in-memory test stores.
 */
export interface ReadIndexGenerationStore {
  getActiveGeneration(): Promise<ActiveGenerationState>;
  saveCandidate(candidate: CandidateGeneration): Promise<void>;
  loadCandidate(generationId: string): Promise<CandidateGeneration | null>;
  atomicCutover(
    candidate: CandidateGeneration,
    cutoverAt: number,
  ): Promise<ActiveGenerationState>;
}

/**
 * Orchestrates staging, verification, and atomic cutover against any
 * `ReadIndexGenerationStore`.
 */
export class ReadIndexGenerationCoordinator {
  constructor(private readonly store: ReadIndexGenerationStore) {}

  async getActiveGeneration(): Promise<ActiveGenerationState> {
    return this.store.getActiveGeneration();
  }

  /**
   * Build and stage a candidate projection separately from the active reader
   * tables. Does not affect active readers.
   */
  async stageCandidate(
    generationId: string,
    tables: BackupTables,
    stagedAt: number = Date.now(),
  ): Promise<CandidateGeneration> {
    const candidate = buildCandidateGeneration(generationId, tables, stagedAt);
    await this.store.saveCandidate(candidate);
    return candidate;
  }

  /**
   * Verify a previously staged candidate against the current active generation
   * and caller-supplied fingerprint / ledger coverage requirements.
   */
  async verifyStagedCandidate(
    generationId: string,
    opts: Omit<CandidateVerificationRequirements, "active"> = {},
  ): Promise<CandidateVerificationReport> {
    const [active, candidate] = await Promise.all([
      this.store.getActiveGeneration(),
      this.store.loadCandidate(generationId),
    ]);
    if (!candidate) {
      return {
        ok: false,
        generationId,
        fingerprint: "",
        ledger: null,
        claimCount: 0,
        findings: [
          {
            code: "CANDIDATE_BACKUP_INVALID",
            severity: "error",
            message: `staged candidate generation "${generationId}" not found`,
          },
        ],
        backupFindings: [],
      };
    }
    return verifyCandidateGeneration(candidate, { ...opts, active });
  }

  /**
   * Atomically switch readers to the staged candidate generation ONLY if
   * fingerprint and ledger coverage verification pass.
   */
  async cutover(
    generationId: string,
    opts: Omit<CandidateVerificationRequirements, "active"> & { cutoverAt?: number } = {},
  ): Promise<CutoverResult> {
    const previousGeneration = await this.store.getActiveGeneration();
    const candidate = await this.store.loadCandidate(generationId);

    if (!candidate) {
      const verification: CandidateVerificationReport = {
        ok: false,
        generationId,
        fingerprint: "",
        ledger: null,
        claimCount: 0,
        findings: [
          {
            code: "CANDIDATE_BACKUP_INVALID",
            severity: "error",
            message: `staged candidate generation "${generationId}" not found`,
          },
        ],
        backupFindings: [],
      };
      return {
        ok: false,
        switched: false,
        previousGeneration,
        activeGeneration: previousGeneration,
        verification,
      };
    }

    const verification = verifyCandidateGeneration(candidate, {
      ...opts,
      active: previousGeneration,
    });

    if (!verification.ok) {
      return {
        ok: false,
        switched: false,
        previousGeneration,
        activeGeneration: previousGeneration,
        verification,
      };
    }

    const activeGeneration = await this.store.atomicCutover(
      candidate,
      opts.cutoverAt ?? Date.now(),
    );

    return {
      ok: true,
      switched: true,
      previousGeneration,
      activeGeneration,
      verification,
    };
  }
}

/**
 * In-memory `ReadIndexGenerationStore` for unit tests and dry-run verification.
 */
export class InMemoryReadIndexGenerationStore implements ReadIndexGenerationStore {
  private activeState: ActiveGenerationState;
  private activeTables: BackupTables | null;
  private readonly candidates = new Map<string, CandidateGeneration>();

  constructor(
    initial?: {
      generationId?: string | null;
      tables?: BackupTables | null;
      cutoverAt?: number | null;
    },
  ) {
    if (initial?.tables) {
      const fingerprint = computeBackupChecksum(initial.tables);
      const { ledger } = extractLedgerCursor(initial.tables);
      this.activeTables = structuredClone(initial.tables);
      this.activeState = {
        generationId: initial.generationId ?? "gen_0",
        fingerprint,
        ledger,
        cutoverAt: initial.cutoverAt ?? 0,
      };
    } else {
      this.activeTables = null;
      this.activeState = {
        generationId: initial?.generationId ?? null,
        fingerprint: null,
        ledger: null,
        cutoverAt: initial?.cutoverAt ?? null,
      };
    }
  }

  async getActiveGeneration(): Promise<ActiveGenerationState> {
    return { ...this.activeState };
  }

  getActiveTables(): BackupTables | null {
    return this.activeTables ? structuredClone(this.activeTables) : null;
  }

  async saveCandidate(candidate: CandidateGeneration): Promise<void> {
    this.candidates.set(candidate.generationId, {
      ...candidate,
      tables: structuredClone(candidate.tables),
    });
  }

  async loadCandidate(generationId: string): Promise<CandidateGeneration | null> {
    const found = this.candidates.get(generationId);
    if (!found) return null;
    return {
      ...found,
      tables: structuredClone(found.tables),
    };
  }

  async atomicCutover(
    candidate: CandidateGeneration,
    cutoverAt: number,
  ): Promise<ActiveGenerationState> {
    const nextTables = structuredClone(candidate.tables);
    const nextState: ActiveGenerationState = {
      generationId: candidate.generationId,
      fingerprint: candidate.fingerprint,
      ledger: candidate.ledger,
      cutoverAt,
    };
    this.activeTables = nextTables;
    this.activeState = nextState;
    return { ...nextState };
  }
}
