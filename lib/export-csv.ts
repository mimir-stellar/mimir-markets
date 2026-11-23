import { AgentTradeResult } from "@/lib/agents/performance";

/**
 * Escapes a field for CSV, neutralizing spreadsheet formulas that could execute
 * on load (e.g. starting with =, +, -, @).
 */
function escapeCsvField(field: string): string {
  const neutralized = field.replace(/^[=+\-@]/, "'$&");
  if (/[",\n\r]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

export function generatePerformanceCsv(results: AgentTradeResult[]): string {
  const headers = [
    "Market ID",
    "Question",
    "Category",
    "State",
    "Role",
    "Outcome",
    "Stake (Atomic)",
    "P&L (Atomic)",
    "Settled At (ISO)",
  ];

  const rows = results.map((r) =>
    [
      r.claimId.toString(),
      r.question,
      r.category,
      r.state,
      r.role,
      r.outcome,
      r.stakeAtomic.toString(),
      r.pnlAtomic.toString(),
      r.settledAt ? new Date(r.settledAt).toISOString() : "",
    ].map(escapeCsvField).join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}
