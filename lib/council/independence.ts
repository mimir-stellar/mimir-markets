/**
 * Council Independence & Correlation Assumptions Operator Surface (§council / audit).
 *
 * The Mimir Council aggregates multiple agent viewpoints via quorum voting
 * and peer-reasoning reads. This module provides an operator audit report
 * of council independence assumptions.
 *
 * CRITICAL SAFETY INVARIANT:
 * Council personas share underlying LLM providers (e.g. Gemini), shared
 * resolution-URL evidence cache snapshots, and (when enabled) peer-reasoning
 * reads. They represent heuristic and stylistic diversity, NOT independent
 * external institutions. Operators, UIs, and external protocols must NEVER
 * present correlated council personas as independently verified institutions
 * or decentralized third-party oracles.
 */

import {
  COUNCIL_PERSONAS,
  listCouncilPersonas,
  type PersonaSpec,
} from "../../agents/council/personas";
import {
  PHILOSOPHER_PERSONAS,
  activePhilosophers,
  isPhilosopher,
} from "../../agents/council/philosophers";
import { activeLLMProvider, activeLLMModel } from "../llm";
import {
  getPeerReasoningGroupings,
  describePeerReasoningCorrelation,
} from "../../agents/council/shared/peer-reasoning";
import type { ClassifiedVote } from "./quorum";

export const INSTITUTIONAL_INDEPENDENCE_DISCLAIMER =
  "CRITICAL OPERATOR NOTICE: The Mimir Council consists of internal automated AI personas " +
  "and deterministic rules sharing underlying LLM providers and evidence cache fetches. " +
  "They represent stylistic diversity and heuristic variation, NOT independent external institutions. " +
  "Operators, UIs, and external protocols must NEVER present or advertise the council quorum " +
  "as a consortium of independently verified third-party entities or decentralized institutions.";

export type CorrelationRiskLevel = "high" | "moderate" | "low";
export type AssumptionStatus = "satisfied" | "relaxed" | "violated";

export interface PersonaIndependenceProfile {
  slug: string;
  displayName: string;
  emoji: string;
  track: "classic" | "philosopher";
  archetype: string;
  provider: string;
  model: string;
  evidenceSource: "resolution-url-cache" | "on-chain-pool";
  peerReadsEnabled: boolean;
  peersConsulted: string[];
}

export interface IndependenceGroupings {
  /** Map of provider name -> array of persona slugs */
  providers: Record<string, string[]>;
  /** Map of evidence source name -> array of persona slugs */
  evidenceSources: Record<string, string[]>;
  /** Map of archetype name -> array of persona slugs */
  archetypes: Record<string, string[]>;
  /** Map of jury track -> array of persona slugs */
  tracks: Record<string, string[]>;
  /** Map of buyer persona slug -> array of seller persona slugs read via peer-reasoning */
  peerReasoningDependencies: Record<string, string[]>;
}

export interface CorrelationCluster {
  id: string;
  provider: string;
  evidenceSource: string;
  personaSlugs: string[];
  size: number;
}

export interface IndependenceAssumption {
  id: string;
  title: string;
  status: AssumptionStatus;
  assumption: string;
  reality: string;
  risk: string;
}

export interface CouncilIndependenceSummary {
  totalPersonas: number;
  activePersonas: number;
  distinctProviders: number;
  distinctEvidenceSources: number;
  effectiveIndependentClusters: number;
  peerReasoningActive: boolean;
  /** Explicit guard: NEVER present these agents as independently verified institutions */
  presentedAsIndependentInstitutions: false;
  institutionalIndependenceStatus: "correlated_internal_agents";
  correlationRiskLevel: CorrelationRiskLevel;
}

export interface CouncilIndependenceReport {
  timestamp: string;
  summary: CouncilIndependenceSummary;
  groupings: IndependenceGroupings;
  clusters: CorrelationCluster[];
  assumptions: IndependenceAssumption[];
  personas: Record<string, PersonaIndependenceProfile>;
  disclaimer: string;
}

export interface CouncilIndependenceOptions {
  env?: NodeJS.ProcessEnv;
  classicPersonas?: readonly PersonaSpec[];
  philosophers?: readonly PersonaSpec[];
  providerOverride?: string;
  modelOverride?: string;
  peerReadsEnabledOverride?: boolean;
}

export interface QuorumIndependenceConfig {
  quorum?: number;
  minDistinctProviders?: number;
  minDistinctSources?: number;
}

export interface QuorumIndependenceEvaluation {
  decisiveCount: number;
  decisiveSlugs: string[];
  distinctProviders: string[];
  distinctEvidenceSources: string[];
  distinctClusters: string[];
  correlatedMajority: boolean;
  independentQuorumMet: boolean;
  status: "diverse_quorum" | "correlated_majority" | "below_quorum";
  summary: string;
  warning?: string;
}

function detectConfiguredProvider(env: NodeJS.ProcessEnv): string {
  const forced = env.LLM_PROVIDER?.toLowerCase().trim();
  if (forced) return forced;
  if (env.GEMINI_API_KEY?.trim()) return "gemini";
  if (env.ANTHROPIC_API_KEY?.trim()) return "anthropic";
  if (env.GROQ_API_KEY?.trim() || env.GROQ_API_KEYS?.trim()) return "groq";
  if (env.OPENROUTER_API_KEY?.trim()) return "openrouter";
  try {
    return activeLLMProvider();
  } catch {
    return "gemini"; // Default public baseline provider per docs/COUNCIL.md
  }
}

function detectConfiguredModel(env: NodeJS.ProcessEnv, provider: string): string {
  if (env.ORACLE_LLM_MODEL?.trim()) return env.ORACLE_LLM_MODEL.trim();
  try {
    return activeLLMModel();
  } catch {
    if (provider === "anthropic") return "claude-3-5-sonnet-20241022";
    if (provider === "groq") return "llama-3.3-70b-versatile";
    if (provider === "openrouter") return "google/gemini-2.0-flash-001";
    return "gemini-2.5-flash";
  }
}

function resolveProvider(persona: PersonaSpec, defaultProvider: string): string {
  if (persona.archetype === "rule-based" || persona.ruleEvaluator) {
    return "deterministic-rule-engine";
  }
  return defaultProvider;
}

function resolveModel(persona: PersonaSpec, defaultModel: string): string {
  if (persona.archetype === "rule-based" || persona.ruleEvaluator) {
    return "pure-pool-math";
  }
  return defaultModel;
}

function resolveEvidenceSource(persona: PersonaSpec): "resolution-url-cache" | "on-chain-pool" {
  if (persona.archetype === "rule-based" || persona.ruleEvaluator) {
    return "on-chain-pool";
  }
  return "resolution-url-cache";
}

/**
 * Build a complete operator report of council independence and correlation assumptions
 * based on public configuration.
 */
export function buildCouncilIndependenceReport(
  options: CouncilIndependenceOptions = {},
): CouncilIndependenceReport {
  const env = options.env ?? process.env;

  const detectedProvider = detectConfiguredProvider(env);
  const defaultProvider = options.providerOverride ?? detectedProvider;
  const defaultModel =
    options.modelOverride ?? detectConfiguredModel(env, defaultProvider);
  const peerReadsEnabled =
    options.peerReadsEnabledOverride ?? env.COUNCIL_PEER_READS === "1";

  // Gather classic personas from registry / public spec
  const classic = options.classicPersonas ?? listCouncilPersonas();

  // Gather philosophers unless explicitly disabled (COUNCIL_PHILOSOPHERS=0)
  const philosophersEnabled = env.COUNCIL_PHILOSOPHERS !== "0";
  const philosophers = options.philosophers
    ? options.philosophers
    : philosophersEnabled
      ? activePhilosophers()
      : [];

  const allPersonas = [...classic, ...philosophers];

  // Optional active allowlist filter (COUNCIL_PERSONAS_ACTIVE)
  const allowlistRaw = env.COUNCIL_PERSONAS_ACTIVE?.trim();
  const allowlist = allowlistRaw
    ? new Set(allowlistRaw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))
    : null;

  const active = allowlist
    ? allPersonas.filter((p) => allowlist.has(p.slug.toLowerCase()))
    : allPersonas;

  // Peer reasoning dependencies
  const peerDependencies = peerReadsEnabled
    ? getPeerReasoningGroupings(active)
    : Object.fromEntries(active.map((p) => [p.slug, []]));

  // Build groupings
  const providersGroup: Record<string, string[]> = {};
  const evidenceSourcesGroup: Record<string, string[]> = {};
  const archetypesGroup: Record<string, string[]> = {};
  const tracksGroup: Record<string, string[]> = {
    classic: [],
    philosopher: [],
  };

  const personaProfiles: Record<string, PersonaIndependenceProfile> = {};

  for (const p of active) {
    const isPhil = isPhilosopher(p.slug) || (p as { track?: string }).track === "philosopher";
    const track = isPhil ? "philosopher" : "classic";
    tracksGroup[track].push(p.slug);

    const provider = resolveProvider(p, defaultProvider);
    const model = resolveModel(p, defaultModel);
    const evidenceSource = resolveEvidenceSource(p);

    if (!providersGroup[provider]) providersGroup[provider] = [];
    providersGroup[provider].push(p.slug);

    if (!evidenceSourcesGroup[evidenceSource]) evidenceSourcesGroup[evidenceSource] = [];
    evidenceSourcesGroup[evidenceSource].push(p.slug);

    const archetype = p.archetype ?? "unknown";
    if (!archetypesGroup[archetype]) archetypesGroup[archetype] = [];
    archetypesGroup[archetype].push(p.slug);

    personaProfiles[p.slug] = {
      slug: p.slug,
      displayName: p.displayName,
      emoji: p.emoji,
      track,
      archetype,
      provider,
      model,
      evidenceSource,
      peerReadsEnabled,
      peersConsulted: peerDependencies[p.slug] ?? [],
    };
  }

  // Clusters by composite key (provider + evidenceSource)
  const clusterMap = new Map<string, string[]>();
  for (const p of active) {
    const profile = personaProfiles[p.slug];
    const key = `${profile.provider}::${profile.evidenceSource}`;
    const list = clusterMap.get(key) ?? [];
    list.push(p.slug);
    clusterMap.set(key, list);
  }

  const clusters: CorrelationCluster[] = Array.from(clusterMap.entries()).map(
    ([id, slugs]) => {
      const [provider, evidenceSource] = id.split("::");
      return {
        id,
        provider,
        evidenceSource,
        personaSlugs: slugs,
        size: slugs.length,
      };
    },
  );

  const distinctProvidersCount = Object.keys(providersGroup).length;
  const distinctSourcesCount = Object.keys(evidenceSourcesGroup).length;
  const clusterCount = clusters.length;

  // Independence assumptions evaluation
  const assumptions: IndependenceAssumption[] = [
    {
      id: "provider_diversity",
      title: "Independent Provider Diversity",
      status: distinctProvidersCount > 2 ? "satisfied" : distinctProvidersCount === 2 ? "relaxed" : "violated",
      assumption: "Council personas execute across independent foundation model vendors without shared infrastructure failure.",
      reality:
        `${distinctProvidersCount} execution engine(s) across ${active.length} active personas. ` +
        `All LLM personas rely on the '${defaultProvider}' provider backend.`,
      risk: "A single upstream provider outage, prompt filter, or systematic bias impacts all LLM jurors simultaneously.",
    },
    {
      id: "evidence_independence",
      title: "Isolated Evidence Corroboration",
      status: distinctSourcesCount > 2 ? "satisfied" : distinctSourcesCount === 2 ? "relaxed" : "violated",
      assumption: "Each juror independently discovers and corroborates evidence from distinct primary sources.",
      reality:
        `All LLM personas share a single per-cycle HTTP snapshot from the shared evidence cache. ` +
        `Only rule-based personas read independent on-chain market pool data.`,
      risk: "A poisoned, stale, or malformed resolution URL payload uniformly misleads all LLM jurors without independent verification.",
    },
    {
      id: "reasoning_isolation",
      title: "Independent Reasoning Isolation",
      status: peerReadsEnabled ? "violated" : "satisfied",
      assumption: "Jurors deliberate in complete isolation without peer persuasion, cascade, or herd influence.",
      reality: peerReadsEnabled
        ? `Peer reasoning is ACTIVE: personas purchase public takes from peers before making settlement decisions.`
        : `Peer reasoning is INACTIVE: personas evaluate independently from their own prompt bias and rubric.`,
      risk: peerReadsEnabled
        ? "Early juror takes cause information cascades and correlation cascades, reducing effective jury size."
        : "None; reasoning isolation holds within the bounds of shared provider prompts.",
    },
    {
      id: "institutional_independence",
      title: "Institutional Separation of Power",
      status: "violated",
      assumption: "Council members are decentralized third-party organizations with separate operational custody.",
      reality:
        "All personas are automated agents managed by the same operator worker with local Stellar keypairs.",
      risk: "Operators and external users must not treat council consensus as independently verified decentralized truth.",
    },
  ];

  // Determine overall correlation risk level
  let correlationRiskLevel: CorrelationRiskLevel = "low";
  if (distinctProvidersCount <= 2 && clusters.some((c) => c.size >= active.length * 0.7)) {
    correlationRiskLevel = "high";
  } else if (distinctProvidersCount <= 3 || peerReadsEnabled) {
    correlationRiskLevel = "moderate";
  }

  const summary: CouncilIndependenceSummary = {
    totalPersonas: allPersonas.length,
    activePersonas: active.length,
    distinctProviders: distinctProvidersCount,
    distinctEvidenceSources: distinctSourcesCount,
    effectiveIndependentClusters: clusterCount,
    peerReasoningActive: peerReadsEnabled,
    presentedAsIndependentInstitutions: false,
    institutionalIndependenceStatus: "correlated_internal_agents",
    correlationRiskLevel,
  };

  return {
    timestamp: new Date().toISOString(),
    summary,
    groupings: {
      providers: providersGroup,
      evidenceSources: evidenceSourcesGroup,
      archetypes: archetypesGroup,
      tracks: tracksGroup,
      peerReasoningDependencies: peerDependencies,
    },
    clusters,
    assumptions,
    personas: personaProfiles,
    disclaimer: INSTITUTIONAL_INDEPENDENCE_DISCLAIMER,
  };
}

/**
 * Evaluate whether an evaluated council ballot met quorum through diverse providers
 * or solely through a correlated majority cluster.
 */
export function evaluateQuorumIndependence(
  ballot: ClassifiedVote[],
  report: CouncilIndependenceReport = buildCouncilIndependenceReport(),
  config: QuorumIndependenceConfig = {},
): QuorumIndependenceEvaluation {
  const quorum = config.quorum ?? 3;
  const minDistinctProviders = config.minDistinctProviders ?? 2;
  const minDistinctSources = config.minDistinctSources ?? 2;

  const decisiveVotes = ballot.filter((v) => v.decisive);
  const decisiveSlugs = decisiveVotes.map((v) => v.slug.toLowerCase());

  const providers = new Set<string>();
  const evidenceSources = new Set<string>();
  const clusters = new Set<string>();

  for (const slug of decisiveSlugs) {
    const profile = report.personas[slug];
    if (profile) {
      providers.add(profile.provider);
      evidenceSources.add(profile.evidenceSource);
      clusters.add(`${profile.provider}::${profile.evidenceSource}`);
    } else {
      providers.add("unknown");
      evidenceSources.add("unknown");
      clusters.add("unknown::unknown");
    }
  }

  const distinctProviders = Array.from(providers);
  const distinctEvidenceSources = Array.from(evidenceSources);
  const distinctClusters = Array.from(clusters);

  const decisiveCount = decisiveVotes.length;
  const quorumMet = decisiveCount >= quorum;

  // Correlated majority: quorum is met, but all decisive votes share the same provider or cluster
  const correlatedMajority = quorumMet && (distinctProviders.length === 1 || distinctClusters.length === 1);
  const independentQuorumMet =
    quorumMet &&
    distinctProviders.length >= minDistinctProviders &&
    distinctEvidenceSources.length >= minDistinctSources;

  let status: QuorumIndependenceEvaluation["status"] = "below_quorum";
  let summary = `below quorum: ${decisiveCount} decisive < ${quorum}`;
  let warning: string | undefined;

  if (quorumMet) {
    if (correlatedMajority) {
      status = "correlated_majority";
      summary =
        `quorum met (${decisiveCount} decisive ≥ ${quorum}), but all votes originated from ` +
        `a single correlated cluster ('${distinctClusters[0]}')`;
      warning =
        `CORRELATED MAJORITY: Quorum reached without provider/source diversity. ` +
        `Do not present this verdict as independently verified institutional consensus.`;
    } else if (independentQuorumMet) {
      status = "diverse_quorum";
      summary =
        `quorum met (${decisiveCount} decisive ≥ ${quorum}) with multi-provider diversity ` +
        `(${distinctProviders.length} providers, ${distinctEvidenceSources.length} evidence sources)`;
    } else {
      status = "diverse_quorum";
      summary =
        `quorum met (${decisiveCount} decisive ≥ ${quorum}) with partial diversity ` +
        `(${distinctProviders.length} providers, ${distinctEvidenceSources.length} sources)`;
    }
  }

  return {
    decisiveCount,
    decisiveSlugs,
    distinctProviders,
    distinctEvidenceSources,
    distinctClusters,
    correlatedMajority,
    independentQuorumMet,
    status,
    summary,
    warning,
  };
}

/**
 * Format the operator report as plain text or Markdown for inspection in CLI or pull requests.
 */
export function formatCouncilIndependenceReport(
  report: CouncilIndependenceReport,
  options: { markdown?: boolean } = {},
): string {
  const isMd = options.markdown ?? false;
  const lines: string[] = [];

  if (isMd) {
    lines.push("# Council Independence Assumptions & Correlation Operator Report");
    lines.push("");
    lines.push(`**Generated:** \`${report.timestamp}\`  `);
    lines.push(`**Institutional Status:** \`${report.summary.institutionalIndependenceStatus}\`  `);
    lines.push(`**Correlation Risk:** \`${report.summary.correlationRiskLevel.toUpperCase()}\`  `);
    lines.push(`**Presented as Independent Institutions:** \`${report.summary.presentedAsIndependentInstitutions}\`  `);
    lines.push("");
    lines.push("## Summary");
    lines.push("");
    lines.push(`- **Total Personas:** ${report.summary.totalPersonas}`);
    lines.push(`- **Active Personas:** ${report.summary.activePersonas}`);
    lines.push(`- **Distinct Execution Providers:** ${report.summary.distinctProviders}`);
    lines.push(`- **Distinct Evidence Sources:** ${report.summary.distinctEvidenceSources}`);
    lines.push(`- **Effective Independent Clusters:** ${report.summary.effectiveIndependentClusters}`);
    lines.push(`- **Peer-Reasoning Information Contagion:** ${report.summary.peerReasoningActive ? "Active" : "Disabled"}`);
    lines.push("");
    lines.push("## Provider Groupings");
    lines.push("");
    lines.push("| Provider | Persona Count | Personas |");
    lines.push("|---|---|---|");
    for (const [provider, slugs] of Object.entries(report.groupings.providers)) {
      lines.push(`| \`${provider}\` | ${slugs.length} | ${slugs.map((s) => `\`${s}\``).join(", ")} |`);
    }
    lines.push("");
    lines.push("## Evidence-Source Groupings");
    lines.push("");
    lines.push("| Source | Persona Count | Description | Personas |");
    lines.push("|---|---|---|---|");
    for (const [src, slugs] of Object.entries(report.groupings.evidenceSources)) {
      const desc =
        src === "resolution-url-cache"
          ? "Shared per-cycle HTTP snapshot of resolution URL"
          : "On-chain pool ratios and stake distribution";
      lines.push(`| \`${src}\` | ${slugs.length} | ${desc} | ${slugs.map((s) => `\`${s}\``).join(", ")} |`);
    }
    lines.push("");
    lines.push("## Correlation Clusters");
    lines.push("");
    lines.push("| Cluster ID | Provider | Evidence Source | Size | Personas |");
    lines.push("|---|---|---|---|---|");
    for (const c of report.clusters) {
      lines.push(`| \`${c.id}\` | \`${c.provider}\` | \`${c.evidenceSource}\` | ${c.size} | ${c.personaSlugs.map((s) => `\`${s}\``).join(", ")} |`);
    }
    lines.push("");
    lines.push("## Independence Assumptions Audit");
    lines.push("");
    for (const a of report.assumptions) {
      lines.push(`### [${a.status.toUpperCase()}] ${a.title}`);
      lines.push(`- **Assumption:** ${a.assumption}`);
      lines.push(`- **Reality:** ${a.reality}`);
      lines.push(`- **Risk:** ${a.risk}`);
      lines.push("");
    }
    lines.push("## Operator Institutional Notice");
    lines.push("");
    lines.push(`> ⚠️ **IMPORTANT:** ${report.disclaimer}`);
  } else {
    lines.push("================================================================================");
    lines.push("           MIMIR COUNCIL INDEPENDENCE & CORRELATION OPERATOR REPORT             ");
    lines.push("================================================================================");
    lines.push(`Generated: ${report.timestamp}`);
    lines.push(`Status   : CORRELATED INTERNAL AGENTS (NOT INDEPENDENT INSTITUTIONS)`);
    lines.push(`Risk     : ${report.summary.correlationRiskLevel.toUpperCase()} CORRELATION RISK`);
    lines.push("");
    lines.push("--- SUMMARY --------------------------------------------------------------------");
    lines.push(`  Total Personas               : ${report.summary.totalPersonas}`);
    lines.push(`  Active Personas              : ${report.summary.activePersonas}`);
    lines.push(`  Distinct Providers           : ${report.summary.distinctProviders}`);
    lines.push(`  Distinct Evidence Sources    : ${report.summary.distinctEvidenceSources}`);
    lines.push(`  Effective Clusters           : ${report.summary.effectiveIndependentClusters}`);
    lines.push(`  Peer-Reasoning Sharing       : ${report.summary.peerReasoningActive ? "Active" : "Disabled"}`);
    lines.push(`  Independent Institutions     : ${String(report.summary.presentedAsIndependentInstitutions).toUpperCase()}`);
    lines.push("");
    lines.push("--- PROVIDER GROUPINGS ---------------------------------------------------------");
    for (const [provider, slugs] of Object.entries(report.groupings.providers)) {
      lines.push(`  [${provider}] (${slugs.length} personas):`);
      lines.push(`    ${slugs.join(", ")}`);
    }
    lines.push("");
    lines.push("--- EVIDENCE SOURCE GROUPINGS --------------------------------------------------");
    for (const [src, slugs] of Object.entries(report.groupings.evidenceSources)) {
      lines.push(`  [${src}] (${slugs.length} personas):`);
      lines.push(`    ${slugs.join(", ")}`);
    }
    lines.push("");
    lines.push("--- CORRELATION CLUSTERS -------------------------------------------------------");
    for (const c of report.clusters) {
      lines.push(`  * ${c.id} (${c.size} personas):`);
      lines.push(`    ${c.personaSlugs.join(", ")}`);
    }
    lines.push("");
    lines.push("--- INDEPENDENCE ASSUMPTIONS AUDIT ---------------------------------------------");
    for (const a of report.assumptions) {
      lines.push(`  [${a.status.toUpperCase()}] ${a.title}`);
      lines.push(`    Assumption: ${a.assumption}`);
      lines.push(`    Reality   : ${a.reality}`);
      lines.push(`    Risk      : ${a.risk}`);
    }
    lines.push("");
    lines.push("--- OPERATOR NOTICE ------------------------------------------------------------");
    lines.push(`  ${report.disclaimer}`);
    lines.push("================================================================================");
  }

  return lines.join("\n");
}
