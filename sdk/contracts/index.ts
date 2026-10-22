/**
 * Barrel for the generated Soroban contract bindings.
 *
 * `mimir-market/` and `mimir-squad/` are generated packages: `src/index.ts`
 * re-exports the typed `Client` from `src/client.ts` and every contract type
 * from `src/types.ts`, and carries the `networks` block with the deployed
 * testnet contract id, so `Client` can be constructed without repeating it.
 *
 * Do not hand-edit them — regenerate:
 *
 *   npm run stellar:bindings:local   # from a release wasm build; keeps `networks`
 *   npm run stellar:bindings         # from the live testnet contracts (needs the
 *                                    # Stellar CLI and the deployed ids)
 *
 * `npm run check:bindings` fails when the committed packages no longer describe
 * the built contract, so a contract change cannot ship with stale bindings.
 *
 * Generated `package.json` files pin the same `@stellar/stellar-sdk` major this
 * repo already uses; the sources are consumed directly, without a nested
 * `npm install`, which keeps exactly one copy of the SDK in the tree.
 */
export * as MimirMarket from "./mimir-market/src/index";
export * as MimirSquad from "./mimir-squad/src/index";
