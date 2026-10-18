/**
 * Whoever is behind an address.
 *
 * Every address on Mimir is one of three things and the page has to say which:
 * an agent's own wallet, the wallet of someone who owns agents, or a person
 * trading for themselves. They are not exclusive — an owner trades too — so this
 * resolves all of it at once rather than making the caller guess.
 *
 * Addresses used to link straight to the block explorer, which answers "what
 * transactions has this address sent" when the question on a market page is
 * "who is this, and are they any good".
 */

import "server-only";

import {
  computeAgentPerformance, windowSinceMs,
  type AgentPerformance, type AgentTradeResult, type TimeWindow,
} from "@/lib/agents/performance";
import {
  getAgentRecord, getAgentTradeRows, listAgentRecordsByOwner,
} from "@/lib/db";
import type { AgentRecord } from "@/lib/agents/registry";
import { listDirectoryAgents, type DirectoryAgent } from "./agent-directory";
import { parseAddressParam } from "./api-validation";

export interface OwnedAgentView extends DirectoryAgent {
  performance: AgentPerformance;
}

export interface ProfileView {
  /** A Stellar strkey — `G…` account or `C…` contract — exactly as validated. */
  address: string;
  /** Set when this address IS an agent rather than a person. */
  agent: DirectoryAgent | null;
  /** Agents registered to this address as owner. */
  ownedAgents: OwnedAgentView[];
  /** This address's own trading, whether it is a person or an agent. */
  performance: AgentPerformance;
  results: AgentTradeResult[];
  /** Everything the owned agents realised, summed. */
  agentsRealisedPnlAtomic: bigint;
  agentsSettled: number;
}

export interface ProfileDataSources {
  listDirectoryAgents: typeof listDirectoryAgents;
  listAgentRecordsByOwner: typeof listAgentRecordsByOwner;
  getAgentRecord: typeof getAgentRecord;
  getAgentTradeRows: typeof getAgentTradeRows;
}

const defaultDataSources: ProfileDataSources = {
  listDirectoryAgents,
  listAgentRecordsByOwner,
  getAgentRecord,
  getAgentTradeRows,
};

function ownedDirectoryAgent(record: AgentRecord): DirectoryAgent | null {
  if (!parseAddressParam(record.operatorWallet)) return null;
  return {
    id: record.agentId,
    displayName: record.displayName || record.agentId,
    emoji: "🤖",
    description: record.description,
    track: "byoa",
    address: record.operatorWallet,
    authorityLevel: record.authorityLevel,
    capabilities: record.capabilities,
    status: record.status,
    ownerWallet: record.ownerWallet,
    createdAt: record.createdAt,
  };
}

export async function buildProfile(
  rawAddress: string, window: TimeWindow = "all", nowMs = Date.now(),
  dataSources: ProfileDataSources = defaultDataSources,
): Promise<ProfileView | null> {
  // A Stellar strkey, used verbatim from here on. The `/^0x…{40}$/` guard this
  // replaced rejected every real address, so every profile page returned null;
  // the `toLowerCase()` next to it would then have matched no stored row anyway.
  const address = parseAddressParam(rawAddress);
  if (!address) return null;
  const sinceMs = windowSinceMs(window, nowMs);

  const [directory, ownerRecords, ownRows] = await Promise.all([
    dataSources.listDirectoryAgents().catch(() => []),
    dataSources.listAgentRecordsByOwner(address).catch(() => []),
    dataSources.getAgentTradeRows(address).catch(() => []),
  ]);

  const agent = directory.find((candidate) => candidate.address === address) ?? null;

  // An owner's agents operate from their own wallets, so their P&L is looked up
  // per agent rather than rolled into the owner's own trading.
  const owned = ownerRecords
    .filter((record) => record.ownerWallet === address)
    .map(ownedDirectoryAgent)
    .filter((candidate): candidate is DirectoryAgent => candidate !== null);
  const ownedRows = await Promise.all(
    owned.map((candidate) => dataSources.getAgentTradeRows(candidate.address).catch(() => [])),
  );

  let agentsRealisedPnlAtomic = 0n;
  let agentsSettled = 0;
  const ownedAgents: OwnedAgentView[] = owned.map((candidate, index) => {
    const { performance } = computeAgentPerformance(ownedRows[index], { sinceMs });
    agentsRealisedPnlAtomic += performance.realisedPnlAtomic;
    agentsSettled += performance.settled;
    return { ...candidate, performance };
  });

  const { performance, results } = computeAgentPerformance(ownRows, { sinceMs });

  return {
    address,
    agent,
    ownedAgents,
    performance,
    results: results.sort((a, b) => b.claimId - a.claimId),
    agentsRealisedPnlAtomic,
    agentsSettled,
  };
}

/** Owner wallet for an agent id, for the "created by" line on an agent page. */
export async function findAgentOwner(
  agentId: string,
  getRecord: typeof getAgentRecord = defaultDataSources.getAgentRecord,
): Promise<string | null> {
  return (await getRecord(agentId).catch(() => null))?.ownerWallet ?? null;
}
