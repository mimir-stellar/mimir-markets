import assert from "node:assert/strict";
import test from "node:test";

import {
  SIGNED_ACTION_MAX_TTL_MS,
  validateSignedWindow,
} from "../../lib/signed-window.ts";

const NOW = 1_800_000_000_000;
const NONCE = "nonce-aaaaaaaaaaaaaaaa";

test("signed window accepts one canonical timestamp and preserves nonce trimming", () => {
  assert.deepEqual(
    validateSignedWindow(` ${NONCE} `, NOW + SIGNED_ACTION_MAX_TTL_MS, NOW),
    { ok: true, nonce: NONCE, expiresAt: NOW + SIGNED_ACTION_MAX_TTL_MS },
  );
});

test("signed window rejects repeated nonce and expiry values with stable errors", () => {
  assert.deepEqual(
    validateSignedWindow([NONCE, "nonce-bbbbbbbbbbbbbbbb"], NOW + 1_000, NOW),
    {
      ok: false,
      code: "invalid_request",
      message: "nonce must be provided exactly once",
      field: "nonce",
    },
  );
  assert.deepEqual(
    validateSignedWindow(NONCE, [NOW + 1_000, NOW + 2_000], NOW),
    {
      ok: false,
      code: "invalid_request",
      message: "expiresAt must be provided exactly once",
      field: "expiresAt",
    },
  );
});

test("signed window rejects fractional and unsafe expiry timestamps", () => {
  assert.equal(validateSignedWindow(NONCE, NOW + 1.5, NOW).ok, false);
  assert.equal(
    validateSignedWindow(NONCE, Number.MAX_SAFE_INTEGER + 1, NOW).ok,
    false,
  );
});