# Generation-Based Read-Index Rebuild and Atomic Cutover

Soroban contract state remains authoritative; Postgres is a read index projecting chain events. When rebuilding or restoring the read index, candidate projections are staged and verified separately before active readers switch over.

## Architecture

1. **Pure Verification & State Machine (`lib/ops/read-index-generation.ts`)**
   - `buildCandidateGeneration(generationId, tables)` computes the deterministic SHA-256 fingerprint (`computeBackupChecksum`) and extracts `claim_events_cursor_ledger` from `sync_meta`.
   - `verifyCandidateGeneration(candidate, requirements)` enforces fail-closed checks:
     - Archive/table schema integrity and private-claim content scrubbing (`verifyCacheBackup`).
     - Fingerprint self-consistency and optional `expectedFingerprint` match.
     - Ledger coverage: valid non-negative integer cursor, no regression behind the active generation's ledger (`candidateLedger >= activeLedger`), and `>= requiredMinLedger` when specified.
     - Non-empty projection (unless `allowEmpty: true`) and optional `expectedMinClaimCount`.
   - `ReadIndexGenerationCoordinator` coordinates `stageCandidate`, `verifyStagedCandidate`, and `cutover` against any `ReadIndexGenerationStore` (including `InMemoryReadIndexGenerationStore` for zero-DB tests).

2. **Postgres Storage & Atomic Cutover (`lib/server/read-index-generation.ts`)**
   - `PostgresReadIndexGenerationStore` stages candidate snapshots in `read_index_candidate_generations` without modifying live reader tables.
   - `atomicCutover` runs inside a single `BEGIN ... COMMIT` Postgres transaction: replaces projection tables with the verified candidate rows, updates `sync_meta` generation pointers, and marks the candidate `active` (rolling back completely on any error).
   - `rebuildAndCutoverReadIndex(options)` stages, verifies, and cuts over in one call.

3. **Reader Compatibility (`lib/server/vs-index.ts`)**
   - Existing read paths (`getVsFeedSnapshot`, `getVsDetailSnapshot`, `getUserVsSnapshot`) remain unchanged and backwards-compatible.
   - `getActiveReadIndexGeneration()` reads active generation metadata from `sync_meta`:
     - `read_index_active_generation`
     - `read_index_active_fingerprint`
     - `read_index_active_ledger`
     - `read_index_active_cutover_at`
