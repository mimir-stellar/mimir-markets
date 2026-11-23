# OWASP web/API security review

Original review: 2026-08-12. Chain-specific claims updated for Stellar: 2026-08-19.
Scope: Next.js web/API, agent signed API, copy permissions, research gateway and
production dependencies.

The web-layer findings below are chain-agnostic and still hold. The signature and
chain-configuration paragraphs were rewritten for Stellar; that rewrite is a
documentation pass and **not** a re-review. A fresh review of the Stellar-specific
paths — SEP-43 message verification, the x402 Horizon-proof scheme, contract-account
callers — is part of the open external gate in `LAUNCH_GATE_STATUS.md`.

## Result

No open critical web finding was identified in the reviewed paths. Financial writes use
parameterized SQL and signed wallet requests with nonce/idempotency/audit controls.
Agent capability and owner/operator authorization is deny-by-default. Signature
verification fails closed: a `G…` account is checked locally as Ed25519 over the SEP-43
message, and a `C…` contract account — whose `__check_auth` would need a network round
trip — is **refused by default** rather than guessed at, so nobody who can merely POST
can claim to be a contract account. Research performs URL, port, credentials, DNS/IP and
every-redirect validation, bounds MIME/bytes/time, and has global/per-agent kill
switches. Offline research diagnostics expose bounded per-hop scheme, domain, and SSRF
verdicts with redacted URL identities over captured redirect chains without issuing network requests.
React output is escaped and the repository has no dynamic code execution, shell
execution from request data, credentialed wildcard CORS, or unsafe HTML rendering.

The review added CSP, HSTS, frame denial, MIME-sniffing protection, referrer and
permissions policy headers. CSP retains `unsafe-inline` for Next.js hydration/styles
compatibility; removing it requires a nonce-based rendering migration and is tracked as
hardening, not represented as an audit pass.

Production `npm audit --omit=dev` is clean after updating the lockfile and overriding the
vulnerable transitive Axios line to 1.18.0. The local shell runs Node 20 while the
application and XMTP require Node 22; CI/hosting must use Node 22 or newer as declared in
`package.json`.

## Stellar-specific notes

- **Address handling.** `G…`/`C…` strkeys are case-sensitive base32. A `toLowerCase()`
  normalisation — the reflex from EVM hex addresses — turns a valid address into one that
  matches nothing, which fails *open* in an allowlist written the wrong way round. Every
  comparison in the repo is exact; `tests/node/db-address-fidelity.test.ts` and
  `tests/node/stellar-address-validation.test.ts` cover it.
- **Signature primitive.** Ed25519 has no recovery step, so the public key is an *input*
  to verification, not an output of it. This removes a class of confusion the EVM
  `personal_sign` recovery flow invited, but it means the address a signature is checked
  against must come from the registry, never from the request body.
- **Payment proofs.** The x402 payload is a signed proof over an already-landed Stellar
  payment, not a bare transaction hash. A landed hash is public and permanent, so a
  bare-hash proof would be a bearer token published to the world; requiring an Ed25519
  signature by the payment's source account confines it to the holder of the paying key.
  Replay is denied by claiming the hash at settlement — durably against `payments_v2` and
  in-process for the window before that row exists.
- **No sponsorship path.** Every account funds its own ledger fee. There is no
  fee-sponsor endpoint, so there is no surface for making Mimir pay for an attacker's
  transactions.

## Remaining launch boundary

This source review is not an independent smart-contract audit, penetration test,
legal/custody/sanctions review, or a Stellar Testnet deployment attestation. Funded basket
deposits and unaudited contracts remain disabled until those external reviews are
recorded. Production must configure provider `NEXT_PUBLIC_STELLAR_RPC_URL` and
`NEXT_PUBLIC_STELLAR_HORIZON_URL` endpoints; the public Soroban RPC and Horizon
instances are rate-limited and development/testnet-only.
