# Schema snapshot gate

Mimir's Postgres schema is the ordered `SCHEMA_STATEMENTS` list in `lib/db.ts`,
applied by `ensureSchema()` on the first query of a cold process. There is no
separate migration runner, so a schema edit takes effect as soon as it deploys.
The snapshot gate makes that change visible in review:

```bash
npm ci
npm run check:schema-snapshot            # verify (CI gate)
npm run check:schema-snapshot -- --write # regenerate after a reviewed change
```

The check is pure: no `DATABASE_URL`, no network, no seeds, and no production
secrets. Because it performs no database access, it is safe to run as a read-only
check ahead of any restore preview; a preview must not write to the database, and the
schema fingerprint and table/index names reported here are the baseline a preview
compares against. It exports the schema definition (`getSchemaStatements()`), rebuilds the
snapshot in memory, and compares it with the committed artifact at
`schemas/db-schema.snapshot.json`.

## What the snapshot pins

- **Fingerprint.** SHA-256 over every statement, canonicalised for whitespace and
  including its bound arguments. Any edit — schema, migration registration, or
  seed insert — changes the fingerprint and fails the gate.
- **Tables and indexes.** The `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
  EXISTS` names, so a new table or index is reported explicitly.
- **Migrations.** Every row inserted into `schema_migrations`
  (`migration_id`, `schema_version`, `checksum`, `applied_at`).

A snapshot is valid only when the machine speaks `schemaVersion: 1`, uses
`sha256`, and carries a 64-character lowercase-hex fingerprint. Garbage JSON is
rejected rather than treated as verified.

For the reversible migration rehearsal from a synthetic read-index snapshot,
see [`docs/MIGRATIONS.md`](./MIGRATIONS.md#migration-rehearsal-report-synthetic-snapshots)
and `npm run verify:migration-rehearsal`. It compares canonical fingerprints
across up → down → reapply using isolated in-memory state.

## Failure behaviour

The gate fails closed. `ok` is true only when there are zero error findings:

- `SNAPSHOT_MISSING` / `SNAPSHOT_INVALID` — the committed snapshot is absent or
  unreadable.
- `EMPTY_SCHEMA` — the source produced no statements; an empty schema is never
  treated as verified.
- `FINGERPRINT_MISMATCH`, `TABLE_DRIFT`, `INDEX_DRIFT`, `MIGRATION_DRIFT` — the
  source and the committed snapshot disagree.
- `MIGRATION_DUPLICATE_VERSION` — the same `schema_version` is registered twice.
- `MIGRATION_UNREGISTERED` — the schema creates tables but registers no
  `schema_migrations` row, so a migration was added without being recorded.

Findings name the tables, indexes, or migrations involved and print the exact
remediation command. They never include row data, addresses, or secrets.

## Offline cross-workspace compatibility report

`npm run report:compat` (and `npm run report:compat -- --json` for machine-readable output) compares the app, bindings, contracts, and schema versions recorded in tracked artifacts and flags incompatible combinations. It reads only committed files and never invokes live services, so it needs no credentials and performs no network calls. A combination is reported as incompatible when the schema snapshot's `schemaVersion` differs from the schema version declared by the app, or when a workspace's declared version does not match the version pinned in the shared compatibility manifest. Findings name the workspaces involved and the remediation step.

## Offline artifact and schema support bundle

`npm run report:support-bundle` (and `npm run report:support-bundle -- --json` or `--out <file>`) packages the offline schema snapshot fingerprint and drift report alongside contract Wasm digests and release readiness validation into a reproducible, deterministic bundle. Like the snapshot gate, it reads only public committed artifacts, never accesses `process.env` or a live database, and scrubs secret-shaped strings.

## Offline rollback readiness report

`npm run report:rollback-readiness` reuses the snapshot checks above to state the schema assumptions a rollback makes (committed snapshot present, source schema matches it, migration versions unique, migrations registered) next to the pinned Wasm digests and rollback runbooks, and lists the blockers it observed. Drift is an error in both modes; it never writes the snapshot or touches a database. See `docs/ROLLBACK.md`.
The funded-release evidence manifest (`npm run verify:release-readiness -- --manifest <file>`) also pins this snapshot's `schemaVersion`, `hashAlgorithm`, `source` and `fingerprint`, together with the release readiness fingerprint, in its `schemaIdentity`. A manifest recorded before a schema snapshot change is refused with `EVIDENCE_SCHEMA_IDENTITY_MISMATCH`; regenerate it on the released revision.

## Release, rollback, artifact, and environment

- **Release.** CI runs `npm run check:schema-snapshot` before typecheck. A failing
  gate blocks the pull request; do not bypass it. Run it locally alongside
  typecheck, node tests, contract tests, and release checks before merging a
  schema change.
- **Artifact.** The only artifact is the committed
  `schemas/db-schema.snapshot.json`. Regenerate it with `-- --write` in the same
  pull request as the schema edit, review the diff, and commit both together.
- **Secrets.** None. The check requires no environment variable; `lib/db.ts` is
  imported for its statement list only and never opens a pool.
- **Environment.** The verdict is identical on a clean checkout, in CI, and on a
  developer machine. It does not depend on database contents, chain state, or
  network reachability.
- **Rollback.** Revert the schema change and the snapshot together, then rerun
  `npm run check:schema-snapshot`. Reverting only one of the two leaves the gate
  failing, which is intended. Because the chain is the source of truth, a
  problematic table can also be dropped by applying a reviewed compensating
  statement and re-snapshotting; the read index remains disposable and can be
  rebuilt with `npm run warm:vs-index`.
