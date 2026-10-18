import assert from "node:assert/strict";
import test from "node:test";

import { buildProfile, findAgentOwner, type ProfileDataSources } from "../../lib/server/profile";
import { REGISTRY_SCHEMA_VERSION, type AgentRecord } from "../../lib/agents/registry";

const OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const OPERATOR = "GDZCBCIU6EI5FM5UC5IAWRT5ZY76OK4QDX5BEELC5V3NTNGAUIX5X4UH";
const NOW = 1_780_000_000_000;

function record(index: number, ownerWallet = OWNER): AgentRecord {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    agentId: `agent-${index}`,
    ownerWallet,
    operatorWallet: OPERATOR,
    payoutWallet: OWNER,
    displayName: `Agent ${index}`,
    description: "Test agent",
    capabilities: [],
    authorityLevel: 0,
    limits: {
      maxRequestsPerHour: 1,
      maxActiveMarkets: 1,
      maxDailyExposureUsdc: 1,
      maxPositionUsdc: 1,
      maxDailyExposureAtomic: "1",
      maxPositionAtomic: "1",
      allowedCategories: [],
      allowedSettlementModes: [],
    },
    status: "active",
    reputationBps: 0,
    createdAt: NOW + index,
    updatedAt: NOW + index,
  };
}

const dataSources: ProfileDataSources = {
  listDirectoryAgents: async () => [],
  listAgentRecordsByOwner: async () => [],
  getAgentRecord: async () => null,
  getAgentTradeRows: async () => [],
};

test("findAgentOwner reads the requested agent directly, without a registry limit", async () => {
  const target = record(250);
  const lookedUp: string[] = [];
  const owner = await findAgentOwner(target.agentId, async (agentId) => {
    lookedUp.push(agentId);
    return target;
  });

  assert.deepEqual(lookedUp, [target.agentId]);
  assert.equal(owner, OWNER);
});

test("profiles include every exact-case owned agent beyond the first 200", async () => {
  const records = Array.from({ length: 205 }, (_, index) => record(index));
  records.push(record(205, OWNER.toLowerCase()));
  const calls: string[] = [];

  const profile = await buildProfile(OWNER, "all", NOW, {
    ...dataSources,
    listAgentRecordsByOwner: async (ownerWallet) => {
      calls.push(ownerWallet);
      return records;
    },
  });

  assert.deepEqual(calls, [OWNER]);
  assert.equal(profile?.ownedAgents.length, 205);
  assert.equal(profile?.ownedAgents.at(-1)?.id, "agent-204");
  assert.ok(profile?.ownedAgents.every((agent) => agent.ownerWallet === OWNER));
});