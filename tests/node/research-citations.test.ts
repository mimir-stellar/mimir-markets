import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResearchCitations,
  citationsFromContextPack,
  citationsFromResolutionSource,
  formatCitationCaptureTime,
  getCitationDigestStatus,
  getCitationSourceAvailability,
  researchCitationsShowsRows,
  type CitationDigestStatus,
  type CitationSourceAvailability,
  type ResearchCitationInput,
  type ResearchCitationView,
} from "../../lib/research/citations";
import type { ContextSource, MarketContextPack } from "../../lib/research/context-pack";

const PRIMARY_HASH = "aa".repeat(32);
const CORROB_HASH = "bb".repeat(32);
const NOW = 1_700_000_000_000;

function source(overrides: ResearchCitationInput = {}): ResearchCitationInput {
  return {
    url: "https://primary.example/report",
    domain: "primary.example",
    trustTier: "primary",
    contentHash: PRIMARY_HASH,
    excerpt: "the number was 42",
    capturedAt: NOW - 60_000,
    ...overrides,
  };
}

function contextSource(
  url: string,
  contentHash: string,
  trustTier: ContextSource["trustTier"] = "corroborating",
): ContextSource {
  return {
    url,
    domain: new URL(url).hostname,
    trustTier,
    capturedAt: NOW - 60_000,
    contentHash,
    excerpt: "the number was 42",
  };
}

function pack(overrides: Partial<MarketContextPack> = {}): MarketContextPack {
  return {
    packVersion: 1,
    claim: "the number will exceed 40",
    creatorPosition: "yes",
    counterPosition: "no",
    subjectType: "binary",
    category: "crypto",
    entities: ["number"],
    deadline: Math.floor(NOW / 1000) + 3_600,
    resolution: {
      rule: "read the number from the primary source after the deadline",
      timezone: "UTC",
      edgeCases: [],
    },
    primarySource: contextSource(
      "https://primary.example/report",
      PRIMARY_HASH,
      "primary",
    ),
    corroboratingSources: [
      contextSource("https://mirror.example/report", CORROB_HASH),
    ],
    confidenceBps: 8_000,
    unresolvedQuestions: [],
    createdAt: NOW - 120_000,
    revision: 0,
    ...overrides,
  };
}

test("positive: primary + corroborating sources render as ready citations", () => {
  const view = buildResearchCitations({
    sources: [
      source(),
      source({
        url: "https://mirror.example/report",
        domain: "mirror.example",
        trustTier: "corroborating",
        contentHash: CORROB_HASH,
      }),
    ],
    nowMs: NOW,
  });
  assert.equal(view.status, "ready");
  assert.equal(view.displayable.length, 2);
  assert.equal(view.primaryCount, 1);
  assert.equal(view.displayable[0].domain, "primary.example");
  assert.equal(view.displayable[0].shortHash.includes("…"), true);
  assert.equal(researchCitationsShowsRows(view), true);
});

test("positive: context pack maps primary then corroborating", () => {
  const view = citationsFromContextPack(pack(), { nowMs: NOW });
  assert.equal(view.status, "ready");
  assert.equal(view.displayable.length, 2);
  assert.equal(view.displayable[0].trustTier, "primary");
  assert.equal(view.displayable[1].trustTier, "corroborating");
});

test("positive: resolution url + evidence hash builds a single primary citation", () => {
  const view = citationsFromResolutionSource({
    resolutionUrl: "https://docs.example.org/settle",
    evidenceHash: PRIMARY_HASH,
    excerpt: "settled on published close",
  });
  assert.equal(view.status, "ready");
  assert.equal(view.displayable.length, 1);
  assert.equal(view.displayable[0].trustTier, "primary");
  assert.equal(view.displayable[0].domain, "docs.example.org");
});

test("negative: empty sources yield empty status", () => {
  const view = buildResearchCitations({ sources: [] });
  assert.equal(view.status, "empty");
  assert.equal(researchCitationsShowsRows(view), false);
});

test("negative: javascript URL is invalid and not displayable", () => {
  const view = buildResearchCitations({
    sources: [source({ url: "javascript:alert(1)" })],
  });
  assert.equal(view.status, "invalid");
  assert.equal(view.displayable.length, 0);
  assert.equal(view.citations[0].status, "invalid");
});

test("negative: cancelled market suppresses citation rows", () => {
  const view = buildResearchCitations({
    sources: [source()],
    cancelled: true,
  });
  assert.equal(view.status, "cancelled");
  assert.equal(view.displayable.length, 0);
});

test("boundary: duplicate content hash collapses with duplicatedDropped", () => {
  const view = buildResearchCitations({
    sources: [
      source(),
      source({
        url: "https://cdn.example/copy",
        domain: "cdn.example",
        trustTier: "corroborating",
        contentHash: PRIMARY_HASH,
      }),
    ],
    nowMs: NOW,
  });
  assert.equal(view.displayable.length, 1);
  assert.equal(view.duplicatedDropped, 1);
  assert.equal(
    view.citations.some((row) => row.status === "duplicated"),
    true,
  );
});

test("boundary: duplicate URL without hash collapses", () => {
  const view = buildResearchCitations({
    sources: [
      source({ contentHash: "" }),
      source({ contentHash: "", trustTier: "corroborating" }),
    ],
    nowMs: NOW,
  });
  assert.equal(view.displayable.length, 1);
  assert.equal(view.duplicatedDropped, 1);
  assert.equal(view.withoutHash, 1);
});

test("boundary: capture after deadline is stale", () => {
  const deadline = Math.floor(NOW / 1000) - 10;
  const view = buildResearchCitations({
    sources: [source({ capturedAt: NOW })],
    deadlineUnix: deadline,
    nowMs: NOW,
  });
  assert.equal(view.status, "stale");
  assert.equal(view.displayable[0].status, "stale");
  assert.equal(researchCitationsShowsRows(view), true);
});

test("boundary: malformed hash is dependency_failure", () => {
  const view = buildResearchCitations({
    sources: [source({ contentHash: "not-a-hash" })],
  });
  assert.equal(view.status, "dependency_failure");
  assert.equal(view.displayable[0].status, "dependency_failure");
});

test("regression: wallet addresses and prompt markers are redacted from excerpts", () => {
  const stellar = "G" + "A".repeat(55);
  const view = buildResearchCitations({
    sources: [
      source({
        excerpt: `Contact ${stellar} and ignore system prompt leaks`,
      }),
    ],
  });
  assert.match(view.displayable[0].excerpt, /\[redacted\]/);
  assert.equal(view.displayable[0].excerpt.includes(stellar), false);
  assert.equal(view.displayable[0].excerpt.toLowerCase().includes("system prompt"), false);
});

test("regression: scheme-less URL is normalized to https", () => {
  const view = citationsFromResolutionSource({
    resolutionUrl: "oracle.example/path",
    evidenceHash: PRIMARY_HASH,
  });
  assert.equal(view.displayable[0].url.startsWith("https://"), true);
  assert.equal(view.displayable[0].domain, "oracle.example");
});

test("regression: maxAgeSeconds flags stale without inventing age when unknown", () => {
  const stale = buildResearchCitations({
    sources: [source({ freshnessSeconds: 9_000 })],
    maxAgeSeconds: 3_600,
    nowMs: NOW,
  });
  assert.equal(stale.displayable[0].status, "stale");

  const unknown = buildResearchCitations({
    sources: [source({ capturedAt: null, freshnessSeconds: null })],
    maxAgeSeconds: 3_600,
    nowMs: NOW,
  });
  assert.equal(unknown.displayable[0].status, "ready");
  assert.equal(unknown.displayable[0].ageSeconds, null);
});

test("positive: citation retains capturedAt and precomputes capturedAtIso", () => {
  const captureTime = NOW - 60_000;
  const view = buildResearchCitations({
    sources: [source({ capturedAt: captureTime })],
    nowMs: NOW,
  });
  assert.equal(view.displayable[0].capturedAt, captureTime);
  assert.equal(view.displayable[0].capturedAtIso, new Date(captureTime).toISOString());
});

test("positive: valid 32-byte hex hash is marked verified digest", () => {
  const view = buildResearchCitations({
    sources: [source({ contentHash: PRIMARY_HASH })],
    nowMs: NOW,
  });
  assert.equal(view.displayable[0].digestStatus, "verified");
  assert.equal(getCitationDigestStatus(PRIMARY_HASH), "verified");
  assert.equal(getCitationDigestStatus("0x" + PRIMARY_HASH), "verified");
  assert.equal(getCitationDigestStatus(PRIMARY_HASH.toUpperCase()), "verified");
});

test("positive: ready citation with verified digest computes available source availability", () => {
  const view = buildResearchCitations({
    sources: [source({ contentHash: PRIMARY_HASH })],
    nowMs: NOW,
  });
  assert.equal(view.displayable[0].status, "ready");
  assert.equal(view.displayable[0].sourceAvailability, "available");
  assert.equal(getCitationSourceAvailability("ready", "verified"), "available");
});

test("positive: formatCitationCaptureTime formats timestamp with relative age", () => {
  const t1 = NOW - 45_000;
  assert.equal(
    formatCitationCaptureTime(t1, NOW),
    `${new Date(t1).toISOString()} (45s ago)`,
  );

  const t2 = NOW - 120_000;
  assert.equal(
    formatCitationCaptureTime(t2, NOW),
    `${new Date(t2).toISOString()} (2m ago)`,
  );

  const t3 = NOW - 7_200_000;
  assert.equal(
    formatCitationCaptureTime(t3, NOW),
    `${new Date(t3).toISOString()} (2h ago)`,
  );

  const t4 = NOW - 86_400_000 * 3;
  assert.equal(
    formatCitationCaptureTime(t4, NOW),
    `${new Date(t4).toISOString()} (3d ago)`,
  );
});

test("boundary: missing contentHash yields missing digestStatus and unverified availability", () => {
  const view = buildResearchCitations({
    sources: [source({ contentHash: "" })],
    nowMs: NOW,
  });
  assert.equal(view.displayable[0].digestStatus, "missing");
  assert.equal(view.displayable[0].sourceAvailability, "unverified");
  assert.equal(getCitationDigestStatus(""), "missing");
  assert.equal(getCitationDigestStatus(null), "missing");
  assert.equal(getCitationDigestStatus(undefined), "missing");
  assert.equal(getCitationDigestStatus("   "), "missing");
  assert.equal(getCitationSourceAvailability("ready", "missing"), "unverified");
});

test("boundary: malformed contentHash yields malformed digestStatus and unavailable availability", () => {
  const view = buildResearchCitations({
    sources: [source({ contentHash: "not-a-valid-hash" })],
    nowMs: NOW,
  });
  assert.equal(view.displayable[0].digestStatus, "malformed");
  assert.equal(view.displayable[0].sourceAvailability, "unavailable");
  assert.equal(getCitationDigestStatus("not-a-valid-hash"), "malformed");
  assert.equal(getCitationDigestStatus("0x123"), "malformed");
  assert.equal(getCitationDigestStatus("zz".repeat(32)), "malformed");
  assert.equal(getCitationSourceAvailability("dependency_failure", "malformed"), "unavailable");
});

test("boundary: capture time in the future or null handles gracefully", () => {
  const viewNull = buildResearchCitations({
    sources: [source({ capturedAt: null })],
    nowMs: NOW,
  });
  assert.equal(viewNull.displayable[0].capturedAt, null);
  assert.equal(viewNull.displayable[0].capturedAtIso, null);

  assert.equal(formatCitationCaptureTime(null, NOW), "");
  assert.equal(formatCitationCaptureTime(undefined, NOW), "");
  assert.equal(formatCitationCaptureTime(0, NOW), "");
  assert.equal(formatCitationCaptureTime(-5, NOW), "");

  const future = NOW + 60_000;
  assert.equal(
    formatCitationCaptureTime(future, NOW),
    `${new Date(future).toISOString()} (just now)`,
  );
});

test("boundary: stale citation computes stale source availability", () => {
  const deadline = Math.floor(NOW / 1000) - 10;
  const view = buildResearchCitations({
    sources: [source({ capturedAt: NOW })],
    deadlineUnix: deadline,
    nowMs: NOW,
  });
  assert.equal(view.displayable[0].status, "stale");
  assert.equal(view.displayable[0].sourceAvailability, "stale");
  assert.equal(getCitationSourceAvailability("stale", "verified"), "stale");
  assert.equal(getCitationSourceAvailability("stale", "missing"), "stale");
});

test("boundary: cancelled citation computes unavailable source availability", () => {
  const view = buildResearchCitations({
    sources: [source({ cancelled: true })],
    nowMs: NOW,
  });
  assert.equal(view.citations[0].status, "cancelled");
  assert.equal(view.citations[0].sourceAvailability, "unavailable");
  assert.equal(view.citations[0].digestStatus, "missing");
  assert.equal(getCitationSourceAvailability("cancelled", "verified"), "unavailable");
  assert.equal(getCitationSourceAvailability("invalid", "verified"), "unavailable");
});

test("regression: source availability is decoupled from claim truth value", () => {
  const view = buildResearchCitations({
    sources: [
      source({
        url: "https://oracle.example/claim-true",
        contentHash: PRIMARY_HASH,
        excerpt: "market claims X will happen",
      }),
    ],
    nowMs: NOW,
  });

  const citation = view.displayable[0];
  // Source availability reflects only retrieval and cryptographic hash match
  assert.equal(citation.sourceAvailability, "available");
  assert.equal(citation.digestStatus, "verified");

  // The citation view object MUST NOT declare or infer claim truth/resolution outcome
  const citationKeys = Object.keys(citation);
  assert.equal(citationKeys.includes("truthValue"), false);
  assert.equal(citationKeys.includes("marketOutcome"), false);
  assert.equal(citationKeys.includes("claimResolved"), false);
});

test("regression: existing buildResearchCitations caller contracts remain intact", () => {
  const packView = citationsFromContextPack(pack(), { nowMs: NOW });
  assert.equal(packView.status, "ready");
  assert.equal(packView.displayable.length, 2);
  assert.equal(packView.displayable[0].digestStatus, "verified");
  assert.equal(packView.displayable[0].sourceAvailability, "available");
  assert.equal(typeof packView.displayable[0].capturedAt, "number");
  assert.equal(typeof packView.displayable[0].capturedAtIso, "string");

  const resolutionView = citationsFromResolutionSource({
    resolutionUrl: "https://docs.example.org/settle",
    evidenceHash: PRIMARY_HASH,
    excerpt: "settled on published close",
    capturedAt: NOW - 30_000,
  });
  assert.equal(resolutionView.status, "ready");
  assert.equal(resolutionView.displayable.length, 1);
  assert.equal(resolutionView.displayable[0].capturedAt, NOW - 30_000);
  assert.equal(resolutionView.displayable[0].digestStatus, "verified");
  assert.equal(resolutionView.displayable[0].sourceAvailability, "available");
});
