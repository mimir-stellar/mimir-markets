import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  computeBackupChecksum,
  parseBackup,
  type BackupTables,
  type ReadIndexBackup,
} from "../../lib/ops/cache-backup";
import {
  CLAIM_EVENTS_CURSOR_META_KEY,
  InMemoryReadIndexGenerationStore,
  ReadIndexGenerationCoordinator,
  buildCandidateGeneration,
  extractLedgerCursor,
  verifyCandidateGeneration,
} from "../../lib/ops/read-index-generation";

const FIXTURE_PATH = join(
  process.cwd(),
  "tests",
  "fixtures",
  "cache-backup",
  "valid.json",
);

function loadFixtureTables(ledger?: number): BackupTables {
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const backup = parseBackup(raw) as ReadIndexBackup;
  const tables = structuredClone(backup.tables) as BackupTables;
  if (ledger !== undefined) {
    const others = tables.sync_meta.filter(
      (row) => row.key !== CLAIM_EVENTS_CURSOR_META_KEY,
    );
    tables.sync_meta = [
      ...others,
      { key: CLAIM_EVENTS_CURSOR_META_KEY, value: String(ledger) },
    ];
  }
  return tables;
}

// ── positive & lifecycle ────────────────────────────────────────────────────

test("positive: staging a candidate keeps active readers isolated until atomic cutover", async () => {
  const initialTables = loadFixtureTables(1000);
  const store = new InMemoryReadIndexGenerationStore({
    generationId: "gen_1",
    tables: initialTables,
    cutoverAt: 1_700_000_000_000,
  });
  const coordinator = new ReadIndexGenerationCoordinator(store);

  const candidateTables = loadFixtureTables(1250);
  const expectedFingerprint = computeBackupChecksum(candidateTables);

  // Stage candidate separately
  const staged = await coordinator.stageCandidate("gen_2", candidateTables, 1_700_000_010_000);
  assert.equal(staged.generationId, "gen_2");
  assert.equal(staged.fingerprint, expectedFingerprint);
  assert.equal(staged.ledger, 1250);

  // Active readers still see gen_1 before cutover
  const activeBefore = await coordinator.getActiveGeneration();
  assert.equal(activeBefore.generationId, "gen_1");
  assert.equal(activeBefore.ledger, 1000);
  assert.equal(extractLedgerCursor(store.getActiveTables()!).ledger, 1000);

  // Cutover succeeds after fingerprint and ledger coverage checks pass
  const result = await coordinator.cutover("gen_2", {
    expectedFingerprint,
    requiredMinLedger: 1200,
    expectedMinClaimCount: candidateTables.claims.length,
    cutoverAt: 1_700_000_020_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.switched, true);
  assert.equal(result.previousGeneration.generationId, "gen_1");
  assert.equal(result.activeGeneration.generationId, "gen_2");
  assert.equal(result.activeGeneration.fingerprint, expectedFingerprint);
  assert.equal(result.activeGeneration.ledger, 1250);
  assert.equal(result.activeGeneration.cutoverAt, 1_700_000_020_000);
  assert.equal(extractLedgerCursor(store.getActiveTables()!).ledger, 1250);
});

test("boundary: cutover at identical ledger (deterministic re-index) is allowed", async () => {
  const initialTables = loadFixtureTables(1000);
  const store = new InMemoryReadIndexGenerationStore({
    generationId: "gen_1",
    tables: initialTables,
  });
  const coordinator = new ReadIndexGenerationCoordinator(store);

  const rebuiltTables = loadFixtureTables(1000);
  await coordinator.stageCandidate("gen_2_reindex", rebuiltTables);

  const result = await coordinator.cutover("gen_2_reindex", {
    requiredMinLedger: 1000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.switched, true);
  assert.equal(result.activeGeneration.generationId, "gen_2_reindex");
});

// ── negative / fail-closed ──────────────────────────────────────────────────

test("negative: fingerprint mismatch blocks cutover and leaves active readers untouched", async () => {
  const initialTables = loadFixtureTables(1000);
  const store = new InMemoryReadIndexGenerationStore({
    generationId: "gen_1",
    tables: initialTables,
  });
  const coordinator = new ReadIndexGenerationCoordinator(store);

  const candidateTables = loadFixtureTables(1100);
  await coordinator.stageCandidate("gen_2", candidateTables);

  const result = await coordinator.cutover("gen_2", {
    expectedFingerprint: "0".repeat(64),
  });

  assert.equal(result.ok, false);
  assert.equal(result.switched, false);
  assert.ok(
    result.verification.findings.some((f) => f.code === "CANDIDATE_FINGERPRINT_MISMATCH"),
  );
  assert.equal((await coordinator.getActiveGeneration()).generationId, "gen_1");
  assert.equal(extractLedgerCursor(store.getActiveTables()!).ledger, 1000);
});

test("negative: ledger regression behind active generation blocks cutover", async () => {
  const initialTables = loadFixtureTables(2000);
  const store = new InMemoryReadIndexGenerationStore({
    generationId: "gen_2",
    tables: initialTables,
  });
  const coordinator = new ReadIndexGenerationCoordinator(store);

  const staleCandidate = loadFixtureTables(1999);
  await coordinator.stageCandidate("gen_3", staleCandidate);

  const result = await coordinator.cutover("gen_3");
  assert.equal(result.ok, false);
  assert.equal(result.switched, false);
  assert.ok(
    result.verification.findings.some((f) => f.code === "CANDIDATE_LEDGER_REGRESSION"),
  );
  assert.equal((await coordinator.getActiveGeneration()).generationId, "gen_2");
});

test("negative: incomplete ledger coverage below requiredMinLedger blocks cutover", async () => {
  const initialTables = loadFixtureTables(1000);
  const store = new InMemoryReadIndexGenerationStore({
    generationId: "gen_1",
    tables: initialTables,
  });
  const coordinator = new ReadIndexGenerationCoordinator(store);

  const candidateTables = loadFixtureTables(1150);
  await coordinator.stageCandidate("gen_2", candidateTables);

  const result = await coordinator.cutover("gen_2", {
    requiredMinLedger: 1200,
  });
  assert.equal(result.ok, false);
  assert.equal(result.switched, false);
  assert.ok(
    result.verification.findings.some((f) => f.code === "CANDIDATE_LEDGER_INCOMPLETE"),
  );
  assert.equal((await coordinator.getActiveGeneration()).generationId, "gen_1");
});

test("negative: missing or invalid ledger cursor blocks cutover", async () => {
  const store = new InMemoryReadIndexGenerationStore({
    generationId: "gen_1",
    tables: loadFixtureTables(1000),
  });
  const coordinator = new ReadIndexGenerationCoordinator(store);

  // Missing cursor
  const noCursorTables = loadFixtureTables();
  noCursorTables.sync_meta = noCursorTables.sync_meta.filter(
    (r) => r.key !== CLAIM_EVENTS_CURSOR_META_KEY,
  );
  await coordinator.stageCandidate("gen_missing_cursor", noCursorTables);
  const missingResult = await coordinator.cutover("gen_missing_cursor");
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.switched, false);
  assert.ok(
    missingResult.verification.findings.some((f) => f.code === "CANDIDATE_LEDGER_MISSING"),
  );

  // Invalid cursor
  const badCursorTables = loadFixtureTables();
  badCursorTables.sync_meta = [
    ...badCursorTables.sync_meta.filter((r) => r.key !== CLAIM_EVENTS_CURSOR_META_KEY),
    { key: CLAIM_EVENTS_CURSOR_META_KEY, value: "not-a-ledger" },
  ];
  await coordinator.stageCandidate("gen_bad_cursor", badCursorTables);
  const badResult = await coordinator.cutover("gen_bad_cursor");
  assert.equal(badResult.ok, false);
  assert.equal(badResult.switched, false);
  assert.ok(
    badResult.verification.findings.some((f) => f.code === "CANDIDATE_LEDGER_INVALID"),
  );
});

test("negative: private claim content leak in candidate blocks cutover", async () => {
  const store = new InMemoryReadIndexGenerationStore({
    generationId: "gen_1",
    tables: loadFixtureTables(1000),
  });
  const coordinator = new ReadIndexGenerationCoordinator(store);

  const leakyTables = loadFixtureTables(1200);
  leakyTables.claims[0] = {
    ...leakyTables.claims[0],
    visibility: "private",
    question: "leaked private market question",
  };

  await coordinator.stageCandidate("gen_leaky", leakyTables);
  const result = await coordinator.cutover("gen_leaky");
  assert.equal(result.ok, false);
  assert.equal(result.switched, false);
  assert.ok(
    result.verification.findings.some((f) => f.code === "CANDIDATE_BACKUP_INVALID"),
  );
  assert.ok(
    result.verification.backupFindings.some((f) => f.code === "BACKUP_PRIVATE_CONTENT_LEAK"),
  );
});

test("negative: already-active generation id and short claim coverage block cutover", () => {
  const tables = loadFixtureTables(1200);
  const candidate = buildCandidateGeneration("gen_1", tables);

  const report = verifyCandidateGeneration(candidate, {
    active: {
      generationId: "gen_1",
      fingerprint: candidate.fingerprint,
      ledger: 1000,
      cutoverAt: 1,
    },
    expectedMinClaimCount: tables.claims.length + 5,
  });

  assert.equal(report.ok, false);
  assert.ok(
    report.findings.some((f) => f.code === "CANDIDATE_GENERATION_ALREADY_ACTIVE"),
  );
  assert.ok(
    report.findings.some((f) => f.code === "CANDIDATE_CLAIM_COVERAGE_SHORT"),
  );
});
