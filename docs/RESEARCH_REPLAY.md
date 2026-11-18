# Research gateway replay mode

Replay mode serves research fetches from a fixture of captured (or synthetic)
responses instead of the network. It exists for deterministic tests, offline
evaluation of agents, and reproducing a settlement's evidence exactly.

Only the transport and DNS are replaced. Every other step of
`gatewayFetch` (`lib/research/gateway.ts`) runs unchanged: URL and domain-policy
checks on every hop, manual redirect handling, protocol-downgrade and loop
checks, the content-type allowlist, the bounded body read, per-agent budgets and
SHA-256 content hashing. The resulting `FetchSuccess` then goes through
`validateResearchContent` (`lib/research/content-validation.ts`) like any live
result, so freshness, duplication, hash-integrity and privacy findings all apply.

## Enabling it

- Per call: `gatewayFetch({ ..., replay: createReplaySource(fixture) })`.
- Process-wide: `RESEARCH_REPLAY_FIXTURE=/path/to/fixture.json`.

Never set `RESEARCH_REPLAY_FIXTURE` in production.

## Guarantees

| Guarantee | Behaviour |
| --- | --- |
| No real network | The caller's `fetchImpl` and the system resolver are never called. A URL with no capture fails with `replay_miss`. |
| No paid endpoints | A capture with `paid: true`, a captured `402`, or a request carrying an x402 payment header (`X-PAYMENT`, `X-402-Payment`, `Payment-Signature`, `X-Payment-Authorization`) fails with `replay_paid_endpoint`. |
| Fails closed | A configured fixture that cannot be read or parsed fails every fetch with `replay_invalid_fixture`; it never falls back to the network. |
| Deterministic | The shared response cache is bypassed in both directions, and `capturedAt` is taken from the capture when set. Replayed results carry `replayed: true`. |

## Fixture format

```json
{
  "version": 1,
  "captures": [
    { "url": "https://example.com/report", "body": "<html>…</html>", "capturedAt": 1763000000000 },
    { "url": "https://example.com/moved", "status": 301, "location": "/report" },
    { "url": "https://bazaar.example.com/quote", "body": "{}", "contentType": "application/json", "paid": true }
  ]
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `url` | required | Matched exactly after URL normalisation (fragment dropped). Duplicates are rejected. |
| `status` | `200` | A `3xx` requires `location`. |
| `contentType` | `text/html; charset=utf-8` | Still subject to the gateway's content-type allowlist. |
| `body` | `""` | Still subject to `MAX_RESPONSE_BYTES`. |
| `location` | — | Redirect target, resolved relative to `url`. |
| `headers` | `{}` | Extra response headers. |
| `capturedAt` | fetch time | Epoch ms; makes freshness checks reproducible. |
| `addresses` | `["93.184.216.34"]` | What the host "resolves" to, so SSRF address checks still run. |
| `paid` | `false` | Marks a paid endpoint; always refused. |

See `fixtures/research/replay.example.json` and `tests/node/research-replay.test.ts`.

## New failure kinds

`FetchFailure` gains `replay_miss`, `replay_paid_endpoint` and
`replay_invalid_fixture`. They are only produced while replay is active, and are
counted by `recordSourceFailure` like every other failure kind.
