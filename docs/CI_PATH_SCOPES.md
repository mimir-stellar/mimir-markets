# CI path scopes

The `paths` job in `.github/workflows/ci.yml` decides which suites run from the
change set. It is an **allowlist**: a changed path either matches a known scope
and enables its tier(s), or it matches nothing and the job fails closed.

That is the whole rule, and it is the reason a new root-level file can break CI
with no other symptom than "changed-paths could not determine the change set".
A filter that fails open turns a green check into a lie about what was verified,
so unclassified paths must stop the pipeline instead of quietly skipping work.

Two implementations of one contract:

| file | role |
| --- | --- |
| `lib/ci/path-scope.ts` | the TypeScript source of truth, used by tests |
| `scripts/ci/changed-paths.mjs` | the workflow driver (plain Node, no TS pipeline) |

`npm run check:driver-parity` fails if the two drift, and
`tests/node/ci-path-scope.test.ts` pins the behaviour that matters: defaults,
shared-file fan-out, doc-only exclusion, and the fail-closed default.

## Tiers

| tier | what it covers |
| --- | --- |
| `app` | the Next.js site: `app/`, `components/`, `hooks/`, `i18n/`, `messages/`, `public/`, `examples/`, `sdk/`, `lib/`, plus build/deploy config (`tsconfig.json`, `next.config.js`, `tailwind.config.ts`, `postcss.config.js`, `proxy.ts`, `playwright.config.ts`, `vercel.json`, `railway.json`, `nixpacks.toml`) and the npm manifests |
| `agents` | the workers: `agents/`, `deploy/`, `lib/`, `proxy.ts`, and the same manifests |
| `contracts` | `contracts-soroban/` and the Rust toolchain pin `rust-toolchain.toml` |
| `tests` | `tests/`, `scripts/`, `fixtures/`, `.github/`, `.c8rc`, `playwright.config.ts`, `lib/`, and the manifests |

Outcomes a path can produce:

- **scoped** — enables the listed tier(s).
- **shared** — `SHARED_FILES` (`.env.example`, `.nvmrc`, `.editorconfig`,
  `.gitattributes`, `.gitignore`): outside every tier but affecting all of
  them, so it enables every tier.
- **doc** — the only outcome that enables nothing: `docs/**`, `LICENSE`, and
  any bare `*.md` at the repo root.
- **unknown** — fails the `paths` job, and the workflow then runs *all* tiers
  as the fail-closed fallback. Do not merge on the fallback; fix the
  classification.

## Adding a path

When you add, rename or delete a file at the repo root, or a new top-level
directory, classify it:

1. Add the entry to `PREFIX_SCOPES` or `FILE_SCOPES` in `lib/ci/path-scope.ts`
   **and** the identical entry to `scripts/ci/changed-paths.mjs`. The two lists
   are kept byte-equivalent on purpose.
2. If the file belongs to no tier but changes how every tier builds or runs,
   add it to `SHARED_FILES` instead. If it is documentation, add it to
   `DOC_ONLY` (or leave it a root `*.md`, which is doc by suffix).
3. Pin the decision in `tests/node/ci-path-scope.test.ts` — one assertion that
   the path classifies to the tiers you intended, and one that a similar
   unclassified path is still `unknown`.
4. Run `npm run check:driver-parity` and `npm run test:node`.

A config file that is genuinely inert (editor noise, a scratch note) still needs
an explicit home: `doc` is an explicit classification, not a fallback.
