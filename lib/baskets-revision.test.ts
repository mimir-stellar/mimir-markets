/**
 * Focused tests for #892 — basket composition revision on pending suggestions.
 */
import { describe, expect, it } from "node:test";
import assert from "node:assert/strict";
import {
  compositionRevision,
  isSuggestionStale,
} from "./baskets";

const A = [
  { agentId: "agent-a", weightBps: 7000 },
  { agentId: "agent-b", weightBps: 3000 },
];
const B = [
  { agentId: "agent-b", weightBps: 3000 },
  { agentId: "agent-a", weightBps: 7000 },
];

describe("compositionRevision", () => {
  it("is stable across reordered input", () => {
    assert.equal(compositionRevision(A), compositionRevision(B));
  });

  it("changes when a member is added", () => {
    const revised = [...A, { agentId: "agent-c", weightBps: 1000 }];
    assert.notEqual(compositionRevision(A), compositionRevision(revised));
  });

  it("changes when a weight changes", () => {
    const revised = [
      { agentId: "agent-a", weightBps: 6000 },
      { agentId: "agent-b", weightBps: 4000 },
    ];
    assert.notEqual(compositionRevision(A), compositionRevision(revised));
  });

  it("changes when a member is removed", () => {
    assert.notEqual(compositionRevision(A), compositionRevision([A[0]]));
  });

  it("is deterministic across repeated calls", () => {
    assert.equal(compositionRevision(A), compositionRevision(A));
  });

  it("returns a bounded, fixed-prefix string", () => {
    assert.match(compositionRevision(A), /^c[0-9a-f]{8}$/);
  });
});

describe("isSuggestionStale", () => {
  it("returns false when revisions match", () => {
    const suggestion = { compositionRevision: compositionRevision(A) };
    assert.equal(isSuggestionStale(suggestion, B), false); // B is reorder of A
  });

  it("returns true when membership changed since suggestion", () => {
    const suggestion = { compositionRevision: compositionRevision(A) };
    const revised = [...A, { agentId: "agent-c", weightBps: 500 }];
    assert.equal(isSuggestionStale(suggestion, revised), true);
  });

  it("returns true when a weight changed since suggestion", () => {
    const suggestion = { compositionRevision: compositionRevision(A) };
    const revised = [
      { agentId: "agent-a", weightBps: 5000 },
      { agentId: "agent-b", weightBps: 5000 },
    ];
    assert.equal(isSuggestionStale(suggestion, revised), true);
  });

  it("returns false when suggestion carries no revision (legacy)", () => {
    assert.equal(isSuggestionStale({}, A), false);
  });
});
