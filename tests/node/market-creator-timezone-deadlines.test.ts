import * as assert from "node:assert/strict";
import test from "node:test";

import {
  buildCandidateSignature,
  filterDuplicateCandidates,
  formatUtcOffset,
  interpretDeadline,
  normaliseDeadline,
  parseExplicitDeadline,
  resolveCandidateDeadline,
  type CandidateLike,
} from "../../agents/market-creator/dedupe";
import {
  buildDraftingPrompt,
  parseDraftedCandidates,
  type ClaimCandidate,
} from "../../agents/market-creator/drafting";

// ── parseExplicitDeadline & interpretDeadline ────────────────────────────────

test("parses explicit UTC deadline with Z suffix", () => {
  const result = parseExplicitDeadline("2026-05-01T15:30:00.000Z");
  assert.equal(result.ok, true);
  if (result.ok === true) {
    assert.equal(result.canonicalUtc, "2026-05-01T15:30:00.000Z");
    assert.equal(result.sourceZone, "UTC");
    assert.equal(result.offsetMinutes, 0);
    assert.equal(result.utcOffset, "+00:00");
    assert.equal(result.rawDeadline, "2026-05-01T15:30:00.000Z");
  }
});

test("normalizes numeric positive offset (+02:00) to canonical UTC", () => {
  const result = parseExplicitDeadline("2026-06-15T18:00:00+02:00");
  assert.equal(result.ok, true);
  if (result.ok === true) {
    assert.equal(result.canonicalUtc, "2026-06-15T16:00:00.000Z");
    assert.equal(result.sourceZone, "+02:00");
    assert.equal(result.offsetMinutes, 120);
    assert.equal(result.utcOffset, "+02:00");
  }
});

test("normalizes numeric negative offset (-05:00) to canonical UTC", () => {
  const result = parseExplicitDeadline("2026-11-20T10:00:00-05:00");
  assert.equal(result.ok, true);
  if (result.ok === true) {
    assert.equal(result.canonicalUtc, "2026-11-20T15:00:00.000Z");
    assert.equal(result.sourceZone, "-05:00");
    assert.equal(result.offsetMinutes, -300);
    assert.equal(result.utcOffset, "-05:00");
  }
});

test("interprets IANA time zone when passed as explicit argument", () => {
  // During EDT (UTC-4 in summer)
  const summerResult = parseExplicitDeadline("2026-07-01T12:00:00", "America/New_York");
  assert.equal(summerResult.ok, true);
  if (summerResult.ok === true) {
    assert.equal(summerResult.canonicalUtc, "2026-07-01T16:00:00.000Z");
    assert.equal(summerResult.sourceZone, "America/New_York");
    assert.equal(summerResult.offsetMinutes, -240);
    assert.equal(summerResult.utcOffset, "-04:00");
  }

  // During EST (UTC-5 in winter)
  const winterResult = parseExplicitDeadline("2026-01-15T12:00:00", "America/New_York");
  assert.equal(winterResult.ok, true);
  if (winterResult.ok === true) {
    assert.equal(winterResult.canonicalUtc, "2026-01-15T17:00:00.000Z");
    assert.equal(winterResult.sourceZone, "America/New_York");
    assert.equal(winterResult.offsetMinutes, -300);
    assert.equal(winterResult.utcOffset, "-05:00");
  }
});

test("interprets RFC 9557 bracketed IANA time zone annotation", () => {
  const result = parseExplicitDeadline("2026-07-01T12:00:00-04:00[America/New_York]");
  assert.equal(result.ok, true);
  if (result.ok === true) {
    assert.equal(result.canonicalUtc, "2026-07-01T16:00:00.000Z");
    assert.equal(result.sourceZone, "America/New_York");
    assert.equal(result.offsetMinutes, -240);
    assert.equal(result.utcOffset, "-04:00");
  }
});

test("retains sourceZone as metadata while normalizing equivalent instants to identical canonical UTC", () => {
  const tokyo = interpretDeadline("2026-05-01T21:00:00+09:00");
  const london = interpretDeadline("2026-05-01T13:00:00+01:00");
  const utc = interpretDeadline("2026-05-01T12:00:00Z");

  assert.ok(tokyo && london && utc);
  assert.equal(tokyo.canonicalUtc, utc.canonicalUtc);
  assert.equal(london.canonicalUtc, utc.canonicalUtc);

  // But source zones are distinct and retained as metadata
  assert.equal(tokyo.sourceZone, "+09:00");
  assert.equal(london.sourceZone, "+01:00");
  assert.equal(utc.sourceZone, "UTC");
});

// ── Rejection of ambiguous, local-only, or invalid deadlines ─────────────────

test("rejects ambiguous local-only deadlines without timezone designator", () => {
  for (const raw of [
    "2026-05-01T12:00:00",
    "2026-05-01 12:00:00",
    "2026-12-31T23:59:59",
    "2026-05-01",
  ]) {
    const result = parseExplicitDeadline(raw);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.reason, "ambiguous_local_deadline");
    }
  }
});

test("rejects local-only labels like 'local', 'localtime', 'system'", () => {
  for (const zone of ["local", "localtime", "system", "auto"]) {
    const result = parseExplicitDeadline("2026-05-01T12:00:00", zone);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.reason, "ambiguous_local_deadline");
    }
  }
});

test("rejects RFC 3339 unknown local offset -00:00", () => {
  const result = parseExplicitDeadline("2026-05-01T12:00:00-00:00");
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.reason, "ambiguous_local_deadline");
  }
});

test("rejects ambiguous timezone abbreviations (PST, EST, CST, BST)", () => {
  for (const abbr of ["PST", "EST", "CST", "BST", "CET"]) {
    const result = parseExplicitDeadline(`2026-05-01T12:00:00 ${abbr}`);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.reason, "ambiguous_timezone");
    }
  }
});

test("rejects invalid or unknown time zones", () => {
  for (const bad of ["Mars/Olympus", "Invalid/Zone", "12345", "NotAZone"]) {
    const result = parseExplicitDeadline("2026-05-01T12:00:00", bad);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.reason, "invalid_timezone");
    }
  }
});

test("rejects timezone and offset mismatches", () => {
  // During EDT (July), America/New_York is UTC-4 (-04:00), not +05:00
  const result = parseExplicitDeadline("2026-07-01T12:00:00+05:00", "America/New_York");
  assert.equal(result.ok, false);
  if (result.ok === false) {
    assert.equal(result.reason, "timezone_offset_mismatch");
  }
});

test("rejects calendar invalid dates (e.g. Feb 30, non-leap Feb 29)", () => {
  const feb30 = parseExplicitDeadline("2026-02-30T12:00:00Z");
  assert.equal(feb30.ok, false);
  if (feb30.ok === false) {
    assert.equal(feb30.reason, "invalid_datetime");
  }

  // 2026 is not a leap year
  const feb29NonLeap = parseExplicitDeadline("2026-02-29T12:00:00Z");
  assert.equal(feb29NonLeap.ok, false);
  if (feb29NonLeap.ok === false) {
    assert.equal(feb29NonLeap.reason, "invalid_datetime");
  }

  // 2028 is a leap year
  const feb29Leap = parseExplicitDeadline("2028-02-29T12:00:00Z");
  assert.equal(feb29Leap.ok, true);
});

test("boundary case: rejects spring-forward DST gap hour in local wall-clock", () => {
  // In America/New_York, on March 8, 2026, 2:00 AM springs forward to 3:00 AM (2:30 AM does not exist)
  const gapResult = parseExplicitDeadline("2026-03-08T02:30:00", "America/New_York");
  assert.equal(gapResult.ok, false);
  if (gapResult.ok === false) {
    assert.equal(gapResult.reason, "ambiguous_local_deadline");
    assert.match(gapResult.error, /DST gap/i);
  }
});

test("boundary case: rejects fall-back DST duplicate hour without disambiguating offset", () => {
  // In America/New_York, on November 1, 2026, 1:30 AM occurs twice (EDT and EST)
  const ambigResult = parseExplicitDeadline("2026-11-01T01:30:00", "America/New_York");
  assert.equal(ambigResult.ok, false);
  if (ambigResult.ok === false) {
    assert.equal(ambigResult.reason, "ambiguous_local_deadline");
    assert.match(ambigResult.error, /fall-back transition/i);
  }

  // With explicit offset, the exact instant is unambiguous and accepted
  const edtResult = parseExplicitDeadline("2026-11-01T01:30:00-04:00", "America/New_York");
  assert.equal(edtResult.ok, true);
  if (edtResult.ok === true) {
    assert.equal(edtResult.canonicalUtc, "2026-11-01T05:30:00.000Z");
  }

  const estResult = parseExplicitDeadline("2026-11-01T01:30:00-05:00", "America/New_York");
  assert.equal(estResult.ok, true);
  if (estResult.ok === true) {
    assert.equal(estResult.canonicalUtc, "2026-11-01T06:30:00.000Z");
  }
});

// ── LLM parsing: parseDraftedCandidates ──────────────────────────────────────

test("parseDraftedCandidates normalizes deadlines to UTC and retains sourceZone metadata", () => {
  const rawLlmOutput = JSON.stringify([
    {
      question: "Will Bitcoin exceed $100k by May 1?",
      resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
      deadline: "2026-05-01T18:00:00+02:00",
      category: "crypto",
    },
    {
      question: "Will Apple release the device by July?",
      resolutionUrl: "https://stockanalysis.com/stocks/aapl/",
      deadline: "2026-07-01T15:00:00",
      timeZone: "America/New_York",
      category: "stocks",
    },
  ]);

  const candidates = parseDraftedCandidates(rawLlmOutput);
  assert.equal(candidates.length, 2);

  // Candidate 1
  assert.equal(candidates[0].deadline, "2026-05-01T16:00:00.000Z");
  assert.equal(candidates[0].sourceZone, "+02:00");
  assert.equal(candidates[0].deadlineInterpretation?.rawDeadline, "2026-05-01T18:00:00+02:00");
  assert.equal(candidates[0].deadlineInterpretation?.utcOffset, "+02:00");

  // Candidate 2
  assert.equal(candidates[1].deadline, "2026-07-01T19:00:00.000Z");
  assert.equal(candidates[1].sourceZone, "America/New_York");
  assert.equal(candidates[1].deadlineInterpretation?.sourceZone, "America/New_York");
});

test("parseDraftedCandidates rejects candidates with ambiguous local-only deadlines", () => {
  const rawLlmOutput = JSON.stringify([
    {
      question: "Ambiguous deadline candidate",
      resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
      deadline: "2026-05-01T18:00:00", // No timezone!
      category: "crypto",
    },
    {
      question: "Valid deadline candidate",
      resolutionUrl: "https://www.coingecko.com/en/coins/bitcoin",
      deadline: "2026-05-01T18:00:00Z",
      category: "crypto",
    },
  ]);

  const candidates = parseDraftedCandidates(rawLlmOutput);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].question, "Valid deadline candidate");
});

// ── Dedupe: buildCandidateSignature & filterDuplicateCandidates ──────────────

test("buildCandidateSignature normalizes equivalent deadlines across timezones to identical signatures", () => {
  const c1: CandidateLike = {
    question: "Will BTC hit $100k?",
    resolutionUrl: "https://coingecko.com/en/coins/bitcoin",
    deadline: "2026-05-01T18:00:00+02:00",
  };
  const c2: CandidateLike = {
    question: "Will BTC hit $100k?",
    resolutionUrl: "https://coingecko.com/en/coins/bitcoin",
    deadline: "2026-05-01T16:00:00Z",
  };
  const c3: CandidateLike = {
    question: "Will BTC hit $100k?",
    resolutionUrl: "https://coingecko.com/en/coins/bitcoin",
    deadline: "2026-05-01T12:00:00-04:00",
  };

  const sig1 = buildCandidateSignature(c1);
  const sig2 = buildCandidateSignature(c2);
  const sig3 = buildCandidateSignature(c3);

  assert.equal(sig1, sig2);
  assert.equal(sig2, sig3);
  assert.match(sig1, /\|2026-05-01T16:00:00\.000Z$/);
});

test("filterDuplicateCandidates eliminates duplicate markets across time zones while retaining sourceZone metadata", () => {
  const candidates: CandidateLike[] = [
    {
      question: "Will BTC hit $100k?",
      resolutionUrl: "https://coingecko.com/en/coins/bitcoin",
      deadline: "2026-05-01T18:00:00+02:00",
    },
    {
      question: "Will BTC hit $100k?",
      resolutionUrl: "https://coingecko.com/en/coins/bitcoin",
      deadline: "2026-05-01T16:00:00Z", // Same canonical instant as above!
    },
    {
      question: "Will ETH hit $5k?",
      resolutionUrl: "https://coingecko.com/en/coins/ethereum",
      deadline: "2026-05-01T18:00:00+02:00",
    },
  ];

  const filtered = filterDuplicateCandidates(candidates);
  assert.equal(filtered.length, 2);

  // First candidate was kept, normalized to canonical UTC and sourceZone retained
  assert.equal(filtered[0].question, "Will BTC hit $100k?");
  assert.equal(filtered[0].deadline, "2026-05-01T16:00:00.000Z");
  assert.equal(filtered[0].sourceZone, "+02:00");
  assert.equal(filtered[0].deadlineInterpretation?.sourceZone, "+02:00");

  assert.equal(filtered[1].question, "Will ETH hit $5k?");
});

test("filterDuplicateCandidates rejects ambiguous local-only candidates", () => {
  const candidates: CandidateLike[] = [
    {
      question: "Ambiguous market",
      resolutionUrl: "https://coingecko.com/en/coins/bitcoin",
      deadline: "2026-05-01T18:00:00", // Ambiguous local time!
    },
    {
      question: "Clear market",
      resolutionUrl: "https://coingecko.com/en/coins/ethereum",
      deadline: "2026-05-01T18:00:00Z",
    },
  ];

  const filtered = filterDuplicateCandidates(candidates);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].question, "Clear market");
});

test("buildDraftingPrompt includes time-zone instruction and optional timeZone context", () => {
  const prompt = buildDraftingPrompt({
    sourceText: "Some source material",
    timeZone: "America/New_York",
  });
  assert.match(prompt, /Time zone: America\/New_York/);
  assert.match(prompt, /explicit time zone/i);
  assert.match(prompt, /ambiguous local-only deadlines are rejected/i);
});
