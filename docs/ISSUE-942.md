# Issue #942 — Record cache-backup redaction policy version in release evidence

## Problem

`lib/ops/cache-backup.ts` verifies the committed read-index archive offline: schema, checksum, table allowlist and privacy (scrubbed private-content fields). Release evidence records the `cache-backup-verify` gate as `pass`/`fail`, but does not say **which redaction policy version** the verifier enforced. A reviewer reading a release record therefore cannot tell whether the archive was checked under the current privacy rules or an older ones.

## Goal

Record the cache-backup redaction policy version in release evidence without changing the existing offline gate contracts.

## Minimal contract

- Export a single `CACHE_BACKUP_REDACTION_POLICY_VERSION` constant from `lib/ops/cache-backup.ts` and derive the verifier's redaction behavior from it.
- Emit the version as a small, secret-free field in the release evidence record (outside `results`), so gate ids, `pass`/`fail` statuses, commands, reproducibility and artifact pointers stay unchanged.
- Keep old evidence records parseable: the new field is optional on input, and its absence means "legacy record, version unknown" rather than a parse failure.
- Do not bump `RELEASE_READINESS_SCHEMA_VERSION`, add a gate, change `RELEASE_GATES`, alter cache-backup finding codes, or regenerate the synthetic archive fixture.

## Non-goals

- No new live-evidence gate and no change to the funded-release fail-closed rules.
- No secret or private archive content in release evidence.
- No change to schema-snapshot identity or the release-evidence manifest revision binding.

## Verification

Targeted node tests should pin that the emitted evidence carries the current policy version, that legacy evidence without the field still parses, and that a wrong version is refused when explicitly supplied. The existing `npm run verify:release-readiness` and `npm run verify:cache-backup -- tests/fixtures/cache-backup/valid.json` checks must remain green.

## Failure and rollback

The change is docs/evidence metadata only. Roll back by reverting the constant, the evidence field and their tests together; no chain, database or deployment rollback is required.
