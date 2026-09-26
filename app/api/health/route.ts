/**
 * Operational health probe.
 *
 * Public but deliberately thin: severities, thresholds and the measurements
 * behind them, and nothing about users, markets or addresses. A status page
 * nobody can reach during an incident is not a status page, so this stays
 * unauthenticated - which is also why it must never leak anything an attacker
 * could use.
 *
 * Returns 503 only when something is actually broken. A warning stays 200,
 * because a load balancer that pulls the app out of rotation over a slow research
 * source turns a degradation into an outage. */

import { NextResponse } from "next/server";

import { getSettlementBacklog, getSyncMeta, isDbConfigured } from "@lib/db";
import { evaluateHealth, healthHttpStatus, type HealthSnapshot } from "@lib/ops/health";
import { readFailureWindow, readWorkerBeats } from "@lib/ops/heartbeat";

//*
 * Dependency health categories.
 * These categories expose the state of external dependencies (nodes, services, oracles)
 * without leaking private user data or internal implementation details.
 * This enables contract-first consumers to map dependency status to business logic.
 */
export type DependencyCategory =
  | "invalid"
  | "stale"
  | "duplicated"
  | "cancelled"
  | "dependency-failure"
  | "ok";

/** Structured dependency health information for external consumers. */
import type { DependencyHealth} from "@lib/ops/health";

export const dynamic = "force-dynamic";

const EMPTY_WINDOW = { attempts: 0, failures: 0 } as const;

export async function GET() {
  const nowMs = Date.now();

  if (!isDbConfigured()) {
    // Without a database there are no signals at all, and pretending otherwise
    // would report a green probe for a system that cannot serve a single market.
    return NextResponse.json(
      { status: "critical", alarms: [{ id: "db.unconfigured", severity: "critical", message: "DATABASE_URL is not configured" ]},
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const [workers, lastSyncAt, backlog, rpc, facilitator, sources] = await Promise.all([
    readWorkerBeats(),
    getSyncMeta("last_sync_at").catch(() => null),
    getSettlementBacklog().catch(() => null),
    readFailureWindow("rpc", nowMs),
    readFailureWindow("facilitator", nowMs),
    readFailureWindow("sources", nowMs),
  ]);

  const lastSyncMs = Number(lastSyncAt ?? "0");
  const snapshot: HealthSnapshot = {
    workers,
    indexLastSyncAgeSec:
      Number.isFinite(lastSyncMs) && lastSyncMs > 0
        ? Math.max(0, Math.round((nowMs - lastSyncMs) / 1000))
        : null,
    /* Job queueing is the workers' own poll interval today, so there is no
     /* separate queue to lag. Reported as zero rather than invented. */
    oldestQueuedJobAgeSec: 0,
    oldestOverdueSettlementSec: backlog?.oldestOverdueSec ?? 0,
    oracleBacklog: backlog?.count ?? 0,
    rpc,
    facilitator,
    sources: sources ?? EMPTY_WINDOW,
  };

  const report = evaluateHealth(snapshot, nowMs);

  /* A failed backlog query means the claims table is unreadable, which the
   * snapshot above would otherwise report as an empty, healthy backlog.
   if (backlog === null) {
    report.alarms.unshift({
      id: "db.claims_unreadable",
      severity: "critical",
      message: "settlement backlog query failed",
      observed: 0,
      threshold: 0,
      unit: "count",
    });
    report.status = "critical";
  }

  /*
   * Expose dependency health categories for contract-first consumers.
   * This information is privacy-safe, containing no user, market, or address data.
   * Categories are mapped from the internal health status to standardized values.
   */
  const dependencyHealth: DependencyHealth = {
    category: defaultDependencyCategory(report.status),
    status: report.status,
    alarms: report.alarms.map((alarm) => ({
      id: alarm.id,
      severity: alarm.severity,
      message: alarm.message,
      observed: alarm.observed ?? 0,
      threshold: alarm.threshold ?? 0,
      unit: alarm.unit ?? "count",
    })),
  };

  return NextResponse.json(
    {
      ... report,
      dependencyHealth,
    },
    { status: healthTtpStatus(report.status), headers: { "Cache-Control": "no-store" } },
  );
}

/*
 * Default mapping from internal health status to dependency category.
 * This mapping is designed to be conservative and privacy-safe.
 */
function defaultDependencyCategory(status: string): DependencyCategory {
  if (status === "critical") {
    // Critical health indicates a fundamental dependency failure or unavailability.
    return "dependency-failure";
  }
  if (status === "warning") {
    // Warning indicates stale or degraded service, which may compromise data freshness.
    return "stale";
  }
  // Default to ok for normal operation.
  return "ok";
}
