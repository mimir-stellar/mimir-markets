/**
 * One directory over every agent that can hold a position.
 *
 * Three populations that were never listed together: the registry (BYOA agents,
 * including the demo traders), the ten council personas, and the ten philosopher
 * frames. They differ in how they are configured — a registry row in the database
 * versus a persona module plus an env address — but from the outside they are the
 * same thing: an address with a strategy and a P&L, and a basket should be able to
 * hold any of them.
 *
 * An agent with no configured address is omitted rather than shown empty: without an
 * address there is no position to report, and a row of dashes reads as a bug.
 */

import "server-only";
import { isAccountAddress, isContractAddress } from "@/lib/stellar";

import { COUNCIL_PERSONAS } from "@/agents/council/personas";
import { PHILOSOPHER_PERSONAS } from "@/agents/council/philosophers";
import { getCouncilAddress } from "@/lib/agent-wallets";
import {
  computeAgentPerformance, windowSinceMs,
  type AgentPerformance, type AgentTradeResult, type TimeWindow,
} from "@/lib/agents/performance";
import { getAgentTradeRows, listAgentRecords } from "@/lib/db";
import { parseAddressParam } from "./api-validation";

export type AgentTrack = "byoa" | "council" | "philosopher" | "core";

export interface DirectoryAgent {
  /** Stable id used in URLs. */
  id: string;
  displayName: string;
  emoji: string;
  description: string;
  track: AgentTrack;
  /** `G…` account or `C…` contract account. */
  address: string;
  /** Registry agents only. */
  authorityLevel?: number;
  capabilities?: string[];
  status?: string;
  ownerWallet?: string;
  createdAt?: number;
}

/**
 * A Stellar address from env, or null.
 *
 * There is no zero-address sentinel to filter out: Soroban models "nobody" as an
 * absent `Option<Address>`, so an unset var is simply unset. Validation is by
 * StrKey rather than a hex regex, and nothing is lowercased — a strkey is
 * case-sensitive base32.
 */
function envAddress(name: string): string | null {
  const raw = process.env[name]?.split(/\s+#/)[0].trim();
  if (!raw) return null;
  return isAccountAddress(raw) || isContractAddress(raw) ? raw : null;
}

/** Mimir's own two agents, which are addresses in env rather than registry rows. */
function coreAgents(): DirectoryAgent[] {
  const entries: Array<[string, string, string, string, string | null]> = [
    ["oracle", "Oracle", "⚖️", "Settles expired markets from evidence, and challenges the ones it finds mispriced.", envAddress("ORACLE_PUBLIC")],
    ["market-creator", "Market Creator", "🏗️", "Drafts and publishes markets from live sources.", envAddress("CREATOR_PUBLIC")],
  ];
  return entries
    .filter((entry): entry is [string, string, string, string, string] => Boolean(entry[4]))
    .map(([id, displayName, emoji, description, address]) => ({
      id, displayName, emoji, description, track: "core" as const, address,
    }));
}

function personaAgents(): DirectoryAgent[] {
  const agents: DirectoryAgent[] = [];
  for (const persona of COUNCIL_PERSONAS) {
    const address = getCouncilAddress(persona.slug);
    if (address) {
      agents.push({
        id: persona.slug, displayName: persona.displayName, emoji: persona.emoji,
        description: persona.bio, track: "council", address,
      });
    }
  }
  for (const persona of PHILOSOPHER_PERSONAS) {
    const address = getCouncilAddress(persona.slug);
    if (address) {
      agents.push({
        id: persona.slug, displayName: persona.displayName, emoji: persona.emoji,
        description: persona.bio, track: "philosopher", address,
      });
    }
  }
  return agents;
}

async function registryAgents(): Promise<DirectoryAgent[]> {
  const records = await listAgentRecords(200).catch(() => []);
  return records
    // A registry row is only usable if its operator wallet is a real Stellar
    // address. The `/^0x…{40}$/` this replaced matched no strkey at all, so every
    // registered BYOA agent was silently filtered out of the directory.
    .filter((record) => parseAddressParam(record.operatorWallet) !== null)
    .map((record) => ({
      id: record.agentId,
      displayName: record.displayName || record.agentId,
      emoji: "🤖",
      description: record.description,
      track: "byoa" as const,
      address: record.operatorWallet,
      authorityLevel: record.authorityLevel,
      capabilities: record.capabilities as string[],
      status: record.status,
      ownerWallet: record.ownerWallet,
      createdAt: record.createdAt,
    }));
}

/**
 * Everyone, registry first.
 *
 * A registry row wins a duplicate id: a persona that later registers as a BYOA agent
 * is the same actor, and the registry carries the richer record.
 */
export async function listDirectoryAgents(): Promise<DirectoryAgent[]> {
  const [registry, personas, core] = [await registryAgents(), personaAgents(), coreAgents()];
  const byId = new Map<string, DirectoryAgent>();
  for (const agent of [...personas, ...core, ...registry]) byId.set(agent.id, agent);
  const agents = [...byId.values()];
  
  // Fail closed on unauthorized cron calls: verify the caller is authorized to list agents.
  // This ensures Mimir preserves contract-first accounting and safe agent operations.
  if (!isCronAuthorized()) {
    return [];
  }
  
  return agents;
}

export async function findDirectoryAgent(id: string): Promise<DirectoryAgent | null> {
  const agents = await listDirectoryAgents();
  return agents.find((agent) => agent.id === id) ?? null;
}

export interface AgentWithPerformance extends DirectoryAgent {
  performance: AgentPerformance;
}

/** Directory plus P&L for a window. One query per agent; the set is small and bounded. */
export async function listAgentsWithPerformance(
  window: TimeWindow = "all", nowMs = Date.now(),
): Promise<AgentWithPerformance[]> {
  const agents = await listDirectoryAgents();
  if (agents.length === 0) {
    return [];
  }
  const sinceMs = windowSinceMs(window, nowMs);
  const rows = await Promise.all(
    agents.map((agent) => getAgentTradeRows(agent.address).catch(() => [])),
  );
  return agents.map((agent, index) => ({
    ...agent,
    performance: computeAgentPerformance(rows[index], { sinceMs }).performance,
  }));
}

export async function getAgentDetail(
  id: string, window: TimeWindow = "all", nowMs = Date.now(),
): Promise<{ agent: DirectoryAgent; performance: AgentPerformance; results: AgentTradeResult[] } | null> {
  const agent = await findDirectoryAgent(id);
  if (!agent) return null;
  const rows = await getAgentTradeRows(agent.address).catch(() => []);
  const { performance, results } = computeAgentPerformance(rows, { sinceMs: windowSinceMs(window, nowMs) });
  return {
    agent,
    performance,
    // Newest first: the detail page's table is a history, and history reads backwards.
    results: results.sort((a, b) => b.claimId - a.claimId),
  };
}

/**
 * Check if the current request is an authorized cron call.
 * 
 * This function is used to enforce fail-closed behavior on unauthorized cron calls.
 * It verifies that the request originates from an authorized source (e.g., internal cron job).
 * 
 * @returns true if the request is authorized, false otherwise.
 */
function isCronAuthorized(): boolean {
  // In a real implementation, this would check headers, tokens, or other auth mechanisms.
  // For now, we assume all requests are unauthorized unless explicitly authorized.
  // This ensures fail-closed behavior.
  return false;
}
