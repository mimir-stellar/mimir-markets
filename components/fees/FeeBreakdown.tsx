"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { getFeePolicy } from "@/lib/contract";
import { FEE_SCHEDULE } from "@/lib/fees";
import Skeleton from "@/components/ui/Skeleton";

export type FeeBreakdownContext = "agent" | "basket" | "follow" | "preflight";

export interface SettlementSnapshot {
  principalUsdc?: bigint | number | string | null;
  gainUsdc?: bigint | number | string | null;
  feesUsdc?: bigint | number | string | null;
  claimableUsdc?: bigint | number | string | null;
  unresolved?: boolean;
}

export function formatAtomicUsdc(value: bigint | number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  let atomic: bigint;
  try {
    atomic = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    return "—";
  }
  const negative = atomic < BigInt(0);
  const abs = negative ? -atomic : atomic;
  const whole = abs / BigInt(1_000_000);
  const frac = (abs % BigInt(1_000_000)).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac} USDC`;
}

export function SettlementExplanation({
  snapshot,
}: {
  snapshot: SettlementSnapshot;
}) {
  const t = useTranslations("fees");
  const rows: Array<{ label: string; value: string }> = [
    { label: t("settlementPrincipal"), value: formatAtomicUsdc(snapshot.principalUsdc) },
    { label: t("settlementGain"), value: formatAtomicUsdc(snapshot.gainUsdc) },
    { label: t("settlementFees"), value: formatAtomicUsdc(snapshot.feesUsdc) },
    { label: t("settlementClaimable"), value: formatAtomicUsdc(snapshot.claimableUsdc) },
  ];
  return (
    <section
      aria-labelledby="settlement-explanation-heading"
      className="mt-6 border border-pv-ink/[0.1] bg-pv-surface/30 p-4"
    >
      <h2
        id="settlement-explanation-heading"
        className="font-mono text-[10px] uppercase tracking-wider text-pv-muted"
      >
        {t("settlementHeading")}
      </h2>
      {snapshot.unresolved ? (
        <p role="status" className="mt-1.5 text-[13px] text-pv-muted">
          {t("settlementUnresolved")}
        </p>
      ) : null}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-pv-muted">{row.label}</dt>
            <dd className="font-mono text-pv-text tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function FeeBreakdown({
  context,
  isOwn = false,
}: {
  context: FeeBreakdownContext;
  isOwn?: boolean;
}) {
  const t = useTranslations("fees");

  const [policy, setPolicy] = useState<{ platform_fee_bps: number; agent_owner_fee_bps: number } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    getFeePolicy()
      .then((p) => {
        if (active) {
          setPolicy(p);
          setError(false);
        }
      })
      .catch((err) => {
        console.warn("[FeeBreakdown] Failed to load fee policy:", err);
        if (active) {
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (error) {
    return (
      <div className="text-pv-danger text-sm">
        {t("loadFailed")}
      </div>
    );
  }

  if (!policy) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-full max-w-sm" />
        <Skeleton className="h-4 w-3/4 max-w-sm" />
      </div>
    );
  }

  const platformPct = (policy.platform_fee_bps / 100).toFixed(2);
  const agentPct = (policy.agent_owner_fee_bps / 100).toFixed(2);
  const basketPct = (FEE_SCHEDULE.basketCreatorBps / 100).toFixed(2);

  if (context === "agent") {
    return (
      <section className="mt-6 border border-pv-ink/[0.1] bg-pv-surface/30 p-4">
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">
          {t("agentWhatYouEarn")}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
          {t.rich("agentDescription1", {
            agent: agentPct,
            platform: platformPct,
            strong: (chunks) => <strong className="text-pv-text">{chunks}</strong>,
          })}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
          {t("agentDescription2")}
        </p>
      </section>
    );
  }

  if (context === "basket") {
    return (
      <section className="mt-6 border border-pv-ink/[0.1] bg-pv-surface/30 p-4">
        <h2 className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">
          {t("basketWhatYouEarn")}
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
          {t.rich("basketDescription1", {
            basket: basketPct,
            agent: agentPct,
            platform: platformPct,
            strong: (chunks) => <strong className="text-pv-text">{chunks}</strong>,
          })}
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-pv-muted">
          {t("basketDescription2")}
        </p>
      </section>
    );
  }

  if (context === "follow") {
    return (
      <p className="mt-3 text-[11px] text-pv-muted">
        {t("followDescription", {
          platform: platformPct,
          agent: agentPct,
          basketPart: isOwn
            ? t("followBasketIsOwn")
            : t("followBasketCreator", { basket: basketPct }),
        })}
      </p>
    );
  }

  return null;
}
