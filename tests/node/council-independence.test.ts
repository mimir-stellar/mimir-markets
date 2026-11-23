import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCouncilIndependenceReport,
  evaluateQuorumIndependence,
  formatCouncilIndependenceReport,
  INSTITUTIONAL_INDEPENDENCE_DISCLAIMER,
} from "../../lib/council/independence";
import {
  classifyVoteAttempt,
  evaluateQuorum,
  type ClassifiedVote,
  type VoteAttemptInput,
} from "../../lib/council/quorum";
import {
  COUNCIL_PERSONAS,
  configureCouncilPersonaRegistry,
  resetCouncilPersonaRegistry,
  type PersonaSpec,
} from "../../agents/council/personas";
import {
  getPeerReasoningGroupings,
  describePeerReasoningCorrelation,
} from "../../agents/council/shared/peer-reasoning";

function attempt(partial: Partial<VoteAttemptInput> & Pick<VoteAttemptInput, "slug">): VoteAttemptInput {
  return {
    claimId: 42,
    expectedClaimId: 42,
    claimState: "active",
    status: "ok",
    verdict: "CREATOR_WINS",
    confidence: 85,
    ...partial,
  };
}

function vote(
  slug: string,
  verdict: "CREATOR_WINS" | "CHALLENGERS_WIN" | "DRAW" | "UNRESOLVABLE" = "CREATOR_WINS",
): ClassifiedVote {
  return classifyVoteAttempt(attempt({ slug, verdict }));
}

// ── Baseline Report & Groupings ────────────────────────────────────────────────

test("positive: buildCouncilIndependenceReport generates report from public configuration", () => {
  const report = buildCouncilIndependenceReport({
    env: { COUNCIL_PHILOSOPHERS: "1" },
  });

  assert.equal(report.summary.totalPersonas, 20);
  assert.equal(report.summary.activePersonas, 20);
  assert.equal(report.summary.distinctProviders, 2);
  assert.equal(report.summary.distinctEvidenceSources, 2);
  assert.equal(report.summary.presentedAsIndependentInstitutions, false);
  assert.equal(report.summary.institutionalIndependenceStatus, "correlated_internal_agents");
  assert.equal(report.summary.correlationRiskLevel, "high");

  // Check providers grouping
  assert.ok("gemini" in report.groupings.providers);
  assert.ok("deterministic-rule-engine" in report.groupings.providers);
  assert.equal(report.groupings.providers["deterministic-rule-engine"].length, 2);
  assert.ok(report.groupings.providers["deterministic-rule-engine"].includes("contrarian"));
  assert.ok(report.groupings.providers["deterministic-rule-engine"].includes("whale-watcher"));
  assert.equal(report.groupings.providers["gemini"].length, 18);

  // Check evidence sources grouping
  assert.ok("resolution-url-cache" in report.groupings.evidenceSources);
  assert.ok("on-chain-pool" in report.groupings.evidenceSources);
  assert.equal(report.groupings.evidenceSources["on-chain-pool"].length, 2);
  assert.equal(report.groupings.evidenceSources["resolution-url-cache"].length, 18);

  // Check clusters
  assert.equal(report.clusters.length, 2);
  const geminiCluster = report.clusters.find((c) => c.id === "gemini::resolution-url-cache");
  assert.ok(geminiCluster);
  assert.equal(geminiCluster?.size, 18);

  const ruleCluster = report.clusters.find((c) => c.id === "deterministic-rule-engine::on-chain-pool");
  assert.ok(ruleCluster);
  assert.equal(ruleCluster?.size, 2);

  // Check critical disclaimer
  assert.equal(report.disclaimer, INSTITUTIONAL_INDEPENDENCE_DISCLAIMER);
  assert.match(report.disclaimer, /NEVER present or advertise/);
});

test("groupings: archetypes and tracks separate classic and philosopher jurors", () => {
  const report = buildCouncilIndependenceReport({
    env: { COUNCIL_PHILOSOPHERS: "1" },
  });

  assert.equal(report.groupings.tracks.classic.length, 10);
  assert.equal(report.groupings.tracks.philosopher.length, 10);
  assert.ok(report.groupings.archetypes["rule-based"].includes("contrarian"));
  assert.ok(report.groupings.archetypes["llm-biased"].includes("optimist"));
  assert.ok(report.groupings.archetypes["specialist"].includes("crypto-maxi"));
  assert.ok(report.groupings.archetypes["micro"].includes("yapper"));
});

// ── Peer Reasoning Dependencies ───────────────────────────────────────────────

test("peer-reasoning: when active, dependencies and information cascade risks are mapped", () => {
  const report = buildCouncilIndependenceReport({
    env: { COUNCIL_PEER_READS: "1", COUNCIL_PHILOSOPHERS: "0" },
    peerReadsEnabledOverride: true,
  });

  assert.equal(report.summary.peerReasoningActive, true);
  const deps = report.groupings.peerReasoningDependencies;
  assert.ok(deps["optimist"]);
  assert.ok(deps["optimist"].length > 0);
  assert.ok(!deps["optimist"].includes("optimist"), "a buyer never reads from itself");

  // Assumption audit reflects active peer reads
  const reasoningAssumption = report.assumptions.find((a) => a.id === "reasoning_isolation");
  assert.ok(reasoningAssumption);
  assert.equal(reasoningAssumption?.status, "violated");
  assert.match(reasoningAssumption?.reality ?? "", /ACTIVE/);
});

test("peer-reasoning: when inactive, dependencies are empty and isolation is satisfied", () => {
  const report = buildCouncilIndependenceReport({
    env: { COUNCIL_PEER_READS: "0" },
    peerReadsEnabledOverride: false,
  });

  assert.equal(report.summary.peerReasoningActive, false);
  for (const [, sellers] of Object.entries(report.groupings.peerReasoningDependencies)) {
    assert.equal(sellers.length, 0);
  }

  const reasoningAssumption = report.assumptions.find((a) => a.id === "reasoning_isolation");
  assert.equal(reasoningAssumption?.status, "satisfied");
});

test("peer-reasoning helpers: getPeerReasoningGroupings and describePeerReasoningCorrelation", () => {
  const personas = COUNCIL_PERSONAS.slice(0, 3);
  const groupings = getPeerReasoningGroupings(personas, 1, 42);
  assert.equal(Object.keys(groupings).length, 3);
  assert.equal(groupings[personas[0].slug].length, 1);

  const descActive = describePeerReasoningCorrelation(true, groupings);
  assert.equal(descActive.peerReadsEnabled, true);
  assert.match(descActive.correlationMechanism, /cascade/);
  assert.equal(descActive.affectedPersonas.length, 3);

  const descInactive = describePeerReasoningCorrelation(false, groupings);
  assert.equal(descInactive.peerReadsEnabled, false);
  assert.equal(descInactive.affectedPersonas.length, 0);
});

// ── Quorum Independence & Correlated Majority Detection ─────────────────────────

test("quorum independence: detects correlated majority when quorum is met by a single cluster", () => {
  const report = buildCouncilIndependenceReport();

  // 3 decisive votes all sharing Gemini + resolution URL cache
  const ballot = [vote("optimist"), vote("pessimist"), vote("statistician")];
  const qEval = evaluateQuorumIndependence(ballot, report, { quorum: 3 });

  assert.equal(qEval.decisiveCount, 3);
  assert.equal(qEval.correlatedMajority, true);
  assert.equal(qEval.distinctProviders.length, 1);
  assert.deepEqual(qEval.distinctProviders, ["gemini"]);
  assert.equal(qEval.distinctEvidenceSources.length, 1);
  assert.equal(qEval.status, "correlated_majority");
  assert.ok(qEval.warning);
  assert.match(qEval.warning ?? "", /CORRELATED MAJORITY/);
  assert.match(qEval.summary, /correlated cluster/);
});

test("quorum independence: recognizes diverse quorum when votes span multiple clusters", () => {
  const report = buildCouncilIndependenceReport();

  // 2 Gemini votes + 1 rule-based vote (contrarian)
  const ballot = [vote("optimist"), vote("pessimist"), vote("contrarian")];
  const qEval = evaluateQuorumIndependence(ballot, report, { quorum: 3 });

  assert.equal(qEval.decisiveCount, 3);
  assert.equal(qEval.correlatedMajority, false);
  assert.equal(qEval.distinctProviders.length, 2);
  assert.ok(qEval.distinctProviders.includes("gemini"));
  assert.ok(qEval.distinctProviders.includes("deterministic-rule-engine"));
  assert.equal(qEval.distinctEvidenceSources.length, 2);
  assert.ok(qEval.distinctEvidenceSources.includes("resolution-url-cache"));
  assert.ok(qEval.distinctEvidenceSources.includes("on-chain-pool"));
  assert.equal(qEval.independentQuorumMet, true);
  assert.equal(qEval.status, "diverse_quorum");
  assert.equal(qEval.warning, undefined);
  assert.match(qEval.summary, /multi-provider diversity/);
});

test("quorum independence: below quorum returns below_quorum status", () => {
  const report = buildCouncilIndependenceReport();
  const ballot = [vote("optimist"), vote("contrarian", "DRAW")]; // 1 decisive
  const qEval = evaluateQuorumIndependence(ballot, report, { quorum: 3 });

  assert.equal(qEval.decisiveCount, 1);
  assert.equal(qEval.correlatedMajority, false);
  assert.equal(qEval.independentQuorumMet, false);
  assert.equal(qEval.status, "below_quorum");
  assert.match(qEval.summary, /below quorum: 1 decisive < 3/);
});

// ── evaluateQuorum Integration ────────────────────────────────────────────────

test("evaluateQuorum integration: checkIndependence attaches independence assessment", () => {
  const attempts = [vote("optimist"), vote("pessimist"), vote("statistician")];

  // Without checkIndependence (default backwards compatible)
  const defaultEval = evaluateQuorum(attempts, 3);
  assert.equal(defaultEval.action, "use_council");
  assert.equal(defaultEval.independence, undefined);

  // With checkIndependence: true
  const indepEval = evaluateQuorum(attempts, 3, { checkIndependence: true });
  assert.equal(indepEval.action, "use_council");
  assert.ok(indepEval.independence);
  assert.equal(indepEval.independence?.correlatedMajority, true);
  assert.equal(indepEval.independence?.status, "correlated_majority");
});

// ── Boundary & Failure Cases ──────────────────────────────────────────────────

test("boundary: COUNCIL_PHILOSOPHERS=0 disables philosopher track in report", () => {
  const report = buildCouncilIndependenceReport({
    env: { COUNCIL_PHILOSOPHERS: "0" },
  });

  assert.equal(report.summary.totalPersonas, 10);
  assert.equal(report.summary.activePersonas, 10);
  assert.equal(report.groupings.tracks.philosopher.length, 0);
  assert.equal(report.groupings.tracks.classic.length, 10);
});

test("boundary: COUNCIL_PERSONAS_ACTIVE allowlist limits active report personas", () => {
  const report = buildCouncilIndependenceReport({
    env: { COUNCIL_PERSONAS_ACTIVE: "optimist, contrarian" },
  });

  assert.equal(report.summary.activePersonas, 2);
  assert.equal(report.summary.distinctProviders, 2);
  assert.equal(report.summary.distinctEvidenceSources, 2);
  assert.deepEqual(Object.keys(report.personas).sort(), ["contrarian", "optimist"]);
});

test("failure/boundary: empty custom registry handles gracefully without throwing", () => {
  configureCouncilPersonaRegistry({ listClassicPersonas: () => [] });
  try {
    const report = buildCouncilIndependenceReport({
      philosophers: [],
    });
    assert.equal(report.summary.activePersonas, 0);
    assert.equal(report.summary.distinctProviders, 0);
    assert.equal(report.summary.distinctEvidenceSources, 0);
    assert.equal(report.clusters.length, 0);
  } finally {
    resetCouncilPersonaRegistry();
  }
});

test("provider override: providerOverride sets custom LLM provider across LLM personas", () => {
  const report = buildCouncilIndependenceReport({
    providerOverride: "anthropic",
    modelOverride: "claude-3-5-sonnet",
    env: { COUNCIL_PHILOSOPHERS: "0" },
  });

  assert.ok("anthropic" in report.groupings.providers);
  assert.equal(report.groupings.providers["anthropic"].length, 8);
  assert.equal(report.personas["optimist"].provider, "anthropic");
  assert.equal(report.personas["optimist"].model, "claude-3-5-sonnet");
  // Rule personas remain deterministic
  assert.equal(report.personas["contrarian"].provider, "deterministic-rule-engine");
});

// ── Report Formatting (Plain Text & Markdown) ─────────────────────────────────

test("formatter: plain text format includes all sections and critical disclaimer", () => {
  const report = buildCouncilIndependenceReport({ env: { COUNCIL_PHILOSOPHERS: "0" } });
  const text = formatCouncilIndependenceReport(report);

  assert.match(text, /MIMIR COUNCIL INDEPENDENCE & CORRELATION OPERATOR REPORT/);
  assert.match(text, /--- SUMMARY ---/);
  assert.match(text, /--- PROVIDER GROUPINGS ---/);
  assert.match(text, /--- EVIDENCE SOURCE GROUPINGS ---/);
  assert.match(text, /--- CORRELATION CLUSTERS ---/);
  assert.match(text, /--- INDEPENDENCE ASSUMPTIONS AUDIT ---/);
  assert.match(text, /--- OPERATOR NOTICE ---/);
  assert.match(text, /CRITICAL OPERATOR NOTICE/);
  assert.match(text, /Independent Institutions\s+:\s+FALSE/);
});

test("formatter: markdown format includes tables and alert disclaimer", () => {
  const report = buildCouncilIndependenceReport({ env: { COUNCIL_PHILOSOPHERS: "0" } });
  const md = formatCouncilIndependenceReport(report, { markdown: true });

  assert.match(md, /# Council Independence Assumptions & Correlation Operator Report/);
  assert.match(md, /\| Provider \| Persona Count \| Personas \|/);
  assert.match(md, /\| Source \| Persona Count \| Description \| Personas \|/);
  assert.match(md, /\| Cluster ID \| Provider \| Evidence Source \| Size \| Personas \|/);
  assert.match(md, /> ⚠️ \*\*IMPORTANT:\*\* CRITICAL OPERATOR NOTICE/);
  assert.match(md, /\*\*Presented as Independent Institutions:\*\* `false`/);
});
