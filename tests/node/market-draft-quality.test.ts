import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAFT_QUALITY_REPORT_VERSION,
  MAX_REASONS_PER_CHECK,
  MAX_REASON_MESSAGE_LENGTH,
  explainDraftBatchQuality,
  explainDraftQuality,
  type DraftQualityReport,
} from "../../agents/market-creator/draft-quality";
import { filterDuplicateCandidates } from "../../agents/market-creator/dedupe";
import { parseDraftedCandidates } from "../../agents/market-creator/drafting";

// Synthetic fixtures only: no network, no credentials.
const NOW_MS = Date.parse("2040-01-01T00:00:00.000Z");
const IN_TWO_DAYS = "2040-01-03T00:00:00.000Z";

const validDraft = {
  question: "Will the forecast high in Berlin exceed 5°C on 2040-01-03?",
  resolutionUrl: "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&daily=temperature_2m_max",
  deadline: IN_TWO_DAYS,
  sourceId: "open-meteo",
  captureVersion: "v1",
};

function check(report: DraftQualityReport, id: string) {
  const found = report.checks.find((c) => c.id === id);
  assert.ok(found, `missing check ${id}`);
  return found;
}

function codes(report: DraftQualityReport, id: string): string[] {
  return check(report, id).reasons.map((r) => r.code);
}

test("a well-formed draft passes every check and is accepted", () => {
  const report = explainDraftQuality(validDraft, { nowMs: NOW_MS, evidence: { state: "available" } });
  assert.equal(report.version, DRAFT_QUALITY_REPORT_VERSION);
  assert.equal(report.verdict, "accepted");
  assert.equal(report.retryable, false);
  assert.deepEqual(report.checks.map((c) => [c.id, c.status]), [
    ["objective_wording", "pass"],
    ["source", "pass"],
    ["deadline", "pass"],
  ]);
});

test("unknown evidence availability is not a failure", () => {
  const report = explainDraftQuality(validDraft, { nowMs: NOW_MS });
  assert.equal(report.verdict, "accepted");
});

test("subjective, compound wording is listed as objective_wording failures", () => {
  const report = explainDraftQuality(
    { ...validDraft, question: "Will Bitcoin have the best week? Will ETH follow?" },
    { nowMs: NOW_MS },
  );
  assert.equal(report.verdict, "invalid");
  assert.equal(check(report, "objective_wording").status, "fail");
  assert.deepEqual(codes(report, "objective_wording"), ["question_compound", "question_subjective_term"]);
  assert.equal(check(report, "source").status, "pass");
  assert.equal(check(report, "deadline").status, "pass");
});

test("an unsafe crypto threshold is reported with the threshold helper's reason", () => {
  const report = explainDraftQuality({ ...validDraft, threshold: 0.5 }, { nowMs: NOW_MS });
  assert.equal(report.verdict, "invalid");
  const reason = check(report, "objective_wording").reasons[0];
  assert.equal(reason.code, "threshold_unsafe");
  assert.match(reason.message, /below \$1/);
});

test("source check rejects insecure, credentialed and private URLs", () => {
  const insecure = explainDraftQuality({ ...validDraft, resolutionUrl: "http://example.com/x" }, { nowMs: NOW_MS });
  assert.deepEqual(codes(insecure, "source"), ["source_url_insecure"]);

  const creds = explainDraftQuality(
    { ...validDraft, resolutionUrl: "https://user:pw@example.com/x" },
    { nowMs: NOW_MS },
  );
  assert.deepEqual(codes(creds, "source"), ["source_url_has_credentials"]);

  const local = explainDraftQuality({ ...validDraft, resolutionUrl: "https://127.0.0.1/x" }, { nowMs: NOW_MS });
  assert.deepEqual(codes(local, "source"), ["source_url_local_host"]);

  const malformed = explainDraftQuality({ ...validDraft, resolutionUrl: "not a url" }, { nowMs: NOW_MS });
  assert.deepEqual(codes(malformed, "source"), ["source_url_malformed"]);
  for (const report of [insecure, creds, local, malformed]) assert.equal(report.verdict, "invalid");
});

test("source snapshot binding is only required when asked", () => {
  const unbound = { ...validDraft, sourceId: undefined, captureVersion: undefined };
  assert.equal(explainDraftQuality(unbound, { nowMs: NOW_MS }).verdict, "accepted");
  const strict = explainDraftQuality(unbound, { nowMs: NOW_MS, requireSourceSnapshot: true });
  assert.deepEqual(codes(strict, "source"), ["source_snapshot_missing"]);
});

test("temporarily unavailable evidence is distinguished from an invalid draft", () => {
  const unavailable = explainDraftQuality(validDraft, {
    nowMs: NOW_MS,
    evidence: { state: "unavailable", detail: "HTTP 503 from source" },
  });
  assert.equal(unavailable.verdict, "evidence_unavailable");
  assert.equal(unavailable.retryable, true);
  assert.equal(check(unavailable, "source").status, "unavailable");
  assert.deepEqual(codes(unavailable, "source"), ["source_evidence_unavailable"]);
  assert.match(check(unavailable, "source").reasons[0].message, /HTTP 503/);

  // A draft that is wrong stays invalid even when evidence is also down:
  // retrying later would not fix it.
  const brokenAndDown = explainDraftQuality(
    { ...validDraft, deadline: "2039-12-31T00:00:00.000Z" },
    { nowMs: NOW_MS, evidence: { state: "unavailable" } },
  );
  assert.equal(brokenAndDown.verdict, "invalid");
  assert.equal(brokenAndDown.retryable, false);

  // A malformed URL is never reported as "unavailable".
  const badUrlDown = explainDraftQuality(
    { ...validDraft, resolutionUrl: "ftp://example.com" },
    { nowMs: NOW_MS, evidence: { state: "unavailable" } },
  );
  assert.equal(check(badUrlDown, "source").status, "fail");
  assert.equal(badUrlDown.verdict, "invalid");
});

test("deadline boundaries: past, too soon, exactly the minimum lead, too far, unparseable", () => {
  const past = explainDraftQuality({ ...validDraft, deadline: "2039-12-31T23:59:59Z" }, { nowMs: NOW_MS });
  assert.deepEqual(codes(past, "deadline"), ["deadline_in_past"]);

  const atNow = explainDraftQuality({ ...validDraft, deadline: "2040-01-01T00:00:00Z" }, { nowMs: NOW_MS });
  assert.deepEqual(codes(atNow, "deadline"), ["deadline_in_past"]);

  const soon = explainDraftQuality({ ...validDraft, deadline: "2040-01-01T00:30:00Z" }, { nowMs: NOW_MS });
  assert.deepEqual(codes(soon, "deadline"), ["deadline_too_soon"]);

  const exactlyOneHour = explainDraftQuality({ ...validDraft, deadline: "2040-01-01T01:00:00Z" }, { nowMs: NOW_MS });
  assert.equal(check(exactlyOneHour, "deadline").status, "pass");

  const far = explainDraftQuality({ ...validDraft, deadline: "2041-01-01T00:00:00Z" }, { nowMs: NOW_MS });
  assert.deepEqual(codes(far, "deadline"), ["deadline_too_far"]);

  const garbage = explainDraftQuality({ ...validDraft, deadline: "next tuesday" }, { nowMs: NOW_MS });
  assert.deepEqual(codes(garbage, "deadline"), ["deadline_unparseable"]);

  const custom = explainDraftQuality(
    { ...validDraft, deadline: "2040-01-01T00:30:00Z" },
    { nowMs: NOW_MS, minDeadlineLeadMs: 10 * 60 * 1000 },
  );
  assert.equal(check(custom, "deadline").status, "pass");
});

test("missing fields fail each check with a single reason", () => {
  const report = explainDraftQuality({}, { nowMs: NOW_MS });
  assert.equal(report.verdict, "invalid");
  assert.deepEqual(codes(report, "objective_wording"), ["question_missing"]);
  assert.deepEqual(codes(report, "source"), ["source_url_missing"]);
  assert.deepEqual(codes(report, "deadline"), ["deadline_missing"]);
});

test("reasons are bounded in count and in message length", () => {
  const report = explainDraftQuality(
    {
      ...validDraft,
      question: "best worst good bad great better worse likely popular successful",
    },
    { nowMs: NOW_MS },
  );
  const wording = check(report, "objective_wording");
  assert.equal(wording.reasons.length, MAX_REASONS_PER_CHECK);
  assert.ok(wording.truncatedReasons > 0);

  const longDetail = "x".repeat(5_000);
  const unavailable = explainDraftQuality(validDraft, {
    nowMs: NOW_MS,
    evidence: { state: "unavailable", detail: longDetail },
  });
  for (const c of unavailable.checks) {
    for (const reason of c.reasons) assert.ok(reason.message.length <= MAX_REASON_MESSAGE_LENGTH);
  }

  const tooLong = explainDraftQuality({ ...validDraft, question: `${"a".repeat(400)}?` }, { nowMs: NOW_MS });
  assert.ok(codes(tooLong, "objective_wording").includes("question_too_long"));
  assert.ok(tooLong.question.length <= 200);
});

test("batch report summarises verdicts and points duplicates at the draft dedupe keeps", () => {
  const drafts = [
    validDraft,
    { ...validDraft, question: "  WILL the forecast high in Berlin exceed 5°C on 2040-01-03?  " },
    { ...validDraft, question: "Will it be a good day?", resolutionUrl: "https://example.com/a" },
    { ...validDraft, question: "Will launch X lift off before 2040-01-03?", resolutionUrl: "https://ll.example/launch/1/" },
  ];
  const report = explainDraftBatchQuality(drafts, {
    nowMs: NOW_MS,
    evidenceByUrl: new Map([["https://ll.example/launch/1/", { state: "unavailable" as const }]]),
  });

  assert.deepEqual(report.summary, {
    total: 4,
    accepted: 2,
    invalid: 1,
    evidenceUnavailable: 1,
    duplicates: 1,
  });
  assert.equal(report.entries[1].duplicateOf, 0);
  assert.equal(report.entries[0].duplicateOf, null);
  assert.equal(report.entries[3].verdict, "evidence_unavailable");

  // Same verdict as the existing dedupe layer: it drops exactly the flagged duplicate.
  const mapped = drafts.map((d) => ({ ...d, sourceVersion: d.captureVersion }));
  const kept = filterDuplicateCandidates(mapped);
  assert.equal(kept.length, drafts.length - report.summary.duplicates);
});

test("existing drafting behaviour is unchanged (compatibility)", () => {
  const parsed = parseDraftedCandidates(
    "```json\n" + JSON.stringify([{ question: validDraft.question, resolutionUrl: validDraft.resolutionUrl, deadline: IN_TWO_DAYS }]) + "\n```",
  );
  assert.equal(parsed.length, 1);
  assert.deepEqual(Object.keys(parsed[0]).sort(), ["category", "deadline", "question", "resolutionUrl", "threshold"]);
  // The report can be computed straight from the parser output.
  assert.equal(explainDraftQuality(parsed[0], { nowMs: NOW_MS }).verdict, "accepted");
});
