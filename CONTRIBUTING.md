# Contributing

Contributor quick start for this repo. It covers the essentials for getting set up and iterating on a single test file.

## Prerequisites

This repo pins its toolchains. Use the versions declared in the repo rather than whatever is installed globally.

- **Node.js** -- use the version in `.nvmrc`. If you use [nvm](https://github.com/nvm-sh/nvm), run:
  ```sh
  nvm install
  nvm use
  ```
  Otherwise, install the Node version listed in `.nvmrc` by whatever means you prefer.

- **Rust** -- use the toolchain in `rust-toolchain.toml`. With [rustup](https://rustup.com/), the correct toolchain is selected automatically when you are inside the repo. You can verify with:
  ```sh
  rustc --version
  cargo --version
  ```

## Install

From the repo root:

```sh
npm install
```

This installs the JavaScript/TypeScript dependencies used by the test runners and tooling.

## Running one node test

`scripts/run-node-tests.mjs ` runs all of `tests/node` with a cache. While iterating, run a single file directly with Node's test runner and the `sdx` loader:

```shnode --import tsx --test tests/node/<file>.test.ts
```

For example, to run a single test file named `example.test.ts`:

```sh
node --import tsx --test tests/node/example.test.ts
```

To run a single test case by name, pass Node's test name pattern flag after `the file:

```sh
node --import tsx --test tests/node/<file>.test.ts --test-name-pattern "<pattern>"
```

## Running one contract test

Contract tests are Rust tests in the `mimir-market` crate. Run a single test by name:

```sh
cargo test -p mimir-market <name>
```

To run all tests in the crate:

```sh
cargo test -p mimir-market
```

## Typecheck

Run the TypeScript typechecker before opening a PR:

```sh
npm run typecheck
```

## Wave PR conventions

- Base your branch on the latest `main`.
- Keep the change focused on the issue. Avoid unrelated refactors or formatting changes.
- List the commands you ran and verified in the PR description.
- Link your PR to the issue with `Closes #<issue>`.
- Use a clear commit message that describes the change.
