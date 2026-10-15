import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PRICE_SYMBOL_LENGTH,
  parsePriceSymbol,
} from "../../lib/server/api-validation";

test("parsePriceSymbol accepts valid crypto symbols", () => {
  assert.equal(parsePriceSymbol("bitcoin"), "bitcoin");
  assert.equal(parsePriceSymbol("ethereum"), "ethereum");
  assert.equal(parsePriceSymbol("solana"), "solana");
  assert.equal(parsePriceSymbol("usd-coin"), "usd-coin");
  assert.equal(parsePriceSymbol("stellar"), "stellar");
});

test("parsePriceSymbol normalises case and whitespace", () => {
  assert.equal(parsePriceSymbol("  BITCOIN  "), "bitcoin");
  assert.equal(parsePriceSymbol("Ethereum"), "ethereum");
  assert.equal(parsePriceSymbol("\tsolana\n"), "solana");
});

test("parsePriceSymbol defaults to bitcoin when null or undefined", () => {
  assert.equal(parsePriceSymbol(null), "bitcoin");
  assert.equal(parsePriceSymbol(undefined), "bitcoin");
});

test("parsePriceSymbol rejects empty or whitespace-only strings", () => {
  assert.equal(parsePriceSymbol(""), null);
  assert.equal(parsePriceSymbol("   "), null);
  assert.equal(parsePriceSymbol("\t\n"), null);
});

test("parsePriceSymbol accepts symbols up to MAX_PRICE_SYMBOL_LENGTH (64 chars)", () => {
  assert.equal(MAX_PRICE_SYMBOL_LENGTH, 64);
  const maxValidSymbol = "a".repeat(64);
  assert.equal(parsePriceSymbol(maxValidSymbol), maxValidSymbol);

  const mixedValid = "coin-".repeat(12) + "test"; // 64 chars
  assert.equal(mixedValid.length, 64);
  assert.equal(parsePriceSymbol(mixedValid), mixedValid);
});

test("parsePriceSymbol rejects symbols exceeding MAX_PRICE_SYMBOL_LENGTH", () => {
  const overlong65 = "a".repeat(65);
  assert.equal(parsePriceSymbol(overlong65), null);

  const absurdlyLong = "bitcoin".repeat(100); // 700 chars
  assert.equal(parsePriceSymbol(absurdlyLong), null);
});

test("parsePriceSymbol rejects invalid characters, path traversal, and special symbols", () => {
  assert.equal(parsePriceSymbol("btc/usd"), null);
  assert.equal(parsePriceSymbol("btc?foo=bar"), null);
  assert.equal(parsePriceSymbol("btc&param=1"), null);
  assert.equal(parsePriceSymbol("btc$"), null);
  assert.equal(parsePriceSymbol("btc_usd"), null);
  assert.equal(parsePriceSymbol("../bitcoin"), null);
  assert.equal(parsePriceSymbol("<script>alert(1)</script>"), null);
});
