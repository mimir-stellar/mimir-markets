# API error recovery actions

Errors built by `lib/api/errors.ts` may include an optional
`error.recoveryAction`. Public read routes and the agent API share this vocabulary;
their OpenAPI v1 error schemas publish the same three allowed strings.

| Value | Meaning | Error codes |
| --- | --- | --- |
| `refresh_request` | Construct a fresh request. For signed requests, use a fresh timestamp and nonce, then sign again locally. Preserve the idempotency key for the same logical operation. | `request_expired` |
| `reconnect_wallet` | Ask the user to reconnect the expected operator wallet and obtain a fresh signature. Reconnecting does not rotate the registered operator or grant authority. | `invalid_signature` |
| `retry_later` | Wait before another attempt, respecting `Retry-After` and the existing retry delay. A paused agent also needs the operator to resume it. | `agent_paused`, `rate_limited`, `budget_exhausted`, `upstream_unavailable`, `internal_error` |

Other error codes omit the property. In particular, `unauthenticated` can refer
to API keys, so it does not assume a wallet reconnect will fix the failure.
No existing error code, HTTP status, `retryable` flag, delay or header changes.
The optional field is an additive v1 response change; requests and their schema
version are unchanged.

Recovery actions are advice for clients and interfaces. They do not authorize
an operation or cause the SDK to retry, reconnect, sign or submit anything.
`invalid_signature` remains `retryable: false`: replaying the same invalid
signature cannot succeed. `request_expired` remains retryable with a zero delay
and no `Retry-After` header, but requires a fresh signed request.

Clients should continue branching on stable error codes and retryability.
They should ignore absent or unknown recovery actions while retaining the
original error. The exported `ApiRecoveryAction` type and
`isApiRecoveryAction()` guard in `lib/api/schema.ts` provide the closed
vocabulary; `MimirAgentError.recoveryAction` exposes only recognized values
from the agent response. Guidance contains no URLs, commands, wallet addresses
or credentials.

## Before and after

A rate limit previously returned HTTP 429, `Retry-After: 60`, and:

```json
{"error":{"code":"rate_limited","message":"Rate limit exceeded","retryable":true,"retryAfterSeconds":60}}
```

It now returns the same status and header with one additional property:

```json
{"error":{"code":"rate_limited","message":"Rate limit exceeded","retryable":true,"retryAfterSeconds":60,"recoveryAction":"retry_later"}}
```

A client can render: **Rate limit exceeded. Try again in 60 seconds.**
A signature failure can render: **Signature invalid. Reconnect your operator
wallet and sign a fresh request.** Neither message automatically triggers an
operation.

## Verification and rollback

```bash
npm run test:node -- api-recovery-actions.test.ts agent-sdk-errors.test.ts api-schema.test.ts agent-api-openapi.test.ts public-api-openapi.test.ts
node --import tsx scripts/generate-agent-openapi.ts
```

Both OpenAPI audits report `ERROR_RECOVERY_ACTION_DRIFT` when an example's action
differs from the error catalogue. The finding omits the supplied value. The
schema keeps the property optional and rejects values outside the enum.

To roll back, revert the optional field, SDK support, generator changes and
generated documents together. Legacy clients already support omission of this
field. No contract, database, signing authority or deployment change is needed.
