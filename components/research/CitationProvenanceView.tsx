"use client";

import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Info,
  ShieldCheck,
} from "lucide-react";

import type {
  CitationDigestStatus,
  CitationRowStatus,
  CitationSourceAvailability,
  CitationTrustTier,
  ResearchCitationView,
} from "@/lib/research/citations";

export interface CitationProvenanceViewProps {
  citation: ResearchCitationView;
  className?: string;
  id?: string;
}

const AVAILABILITY_CLASSES: Record<CitationSourceAvailability, string> = {
  available: "border-pv-emerald/30 bg-pv-emerald/[0.08] text-pv-emerald",
  stale: "border-pv-danger/35 bg-pv-danger/[0.08] text-pv-danger",
  unavailable: "border-amber-400/35 bg-amber-400/[0.10] text-amber-300",
  unverified: "border-pv-border/50 bg-pv-surface2/40 text-pv-muted",
};

const STATUS_CLASSES: Record<CitationRowStatus, string> = {
  ready: "border-pv-emerald/30 bg-pv-emerald/[0.08] text-pv-emerald",
  stale: "border-pv-danger/35 bg-pv-danger/[0.08] text-pv-danger",
  dependency_failure: "border-amber-400/35 bg-amber-400/[0.10] text-amber-300",
  cancelled: "border-amber-400/35 bg-amber-400/[0.10] text-amber-300",
  invalid: "border-pv-border/50 bg-pv-surface2/40 text-pv-muted",
  duplicated: "border-pv-border/50 bg-pv-surface2/40 text-pv-muted line-through",
};

const TRUST_CLASSES: Record<CitationTrustTier, string> = {
  primary: "border-pv-gold/30 bg-pv-gold/[0.10] text-pv-gold",
  corroborating: "border-pv-cyan/30 bg-pv-cyan/[0.08] text-pv-cyan",
  unverified: "border-pv-border/50 bg-pv-surface2/40 text-pv-muted",
  unknown: "border-pv-border/50 bg-pv-surface2/40 text-pv-muted",
};

export default function CitationProvenanceView({
  citation,
  className = "",
  id,
}: CitationProvenanceViewProps) {
  const t = useTranslations("researchCitations");
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function handleCopy() {
    if (!citation.contentHash) return;
    if (timerRef.current) clearTimeout(timerRef.current);

    try {
      await navigator.clipboard.writeText(citation.contentHash);
      setCopied(true);
      timerRef.current = setTimeout(() => {
        setCopied(false);
        timerRef.current = null;
      }, 1800);
    } catch {
      setCopied(false);
    }
  }

  // Relative freshness string
  let relativeFreshness: string | null = null;
  if (citation.ageSeconds != null && Number.isFinite(citation.ageSeconds)) {
    const s = Math.max(0, citation.ageSeconds);
    if (s < 60) {
      relativeFreshness = t("provenance.relativeSeconds", { value: s });
    } else if (s < 3_600) {
      relativeFreshness = t("provenance.relativeMinutes", {
        value: Math.floor(s / 60),
      });
    } else if (s < 86_400) {
      relativeFreshness = t("provenance.relativeHours", {
        value: Math.floor(s / 3_600),
      });
    } else {
      relativeFreshness = t("provenance.relativeDays", {
        value: Math.floor(s / 86_400),
      });
    }
  }

  return (
    <div
      id={id}
      className={`max-h-60 overflow-y-auto rounded-lg border border-pv-ink/[0.08] bg-pv-surface2/60 p-3 text-xs space-y-2.5 ${className}`.trim()}
      data-testid="citation-provenance-view"
      data-digest-status={citation.digestStatus}
      data-source-availability={citation.sourceAvailability}
    >
      {/* Section 1: Capture Timestamp */}
      <div className="space-y-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
          {t("provenance.captureTime")}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {citation.capturedAtIso ? (
            <>
              <span className="font-mono text-[11px] text-pv-text/90 select-all">
                {citation.capturedAtIso}
              </span>
              {relativeFreshness ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-pv-cyan/30 bg-pv-cyan/[0.08] px-2 py-0.5 text-[10px] font-semibold text-pv-cyan">
                  <Clock size={10} aria-hidden />
                  {relativeFreshness}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-pv-muted italic">
              {t("provenance.unknownCaptureTime")}
            </span>
          )}
        </div>
      </div>

      {/* Section 2: Content Digest (SHA-256) */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
            {t("provenance.contentDigest")}
          </span>
          {citation.contentHash ? (
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-pv-muted hover:text-pv-text hover:bg-pv-ink/[0.05] transition-colors"
              aria-label={copied ? t("provenance.copiedDigest") : t("provenance.copyDigest")}
            >
              {copied ? (
                <>
                  <Check size={11} className="text-pv-emerald" aria-hidden />
                  <span className="text-pv-emerald">{t("provenance.copiedDigest")}</span>
                </>
              ) : (
                <>
                  <Copy size={11} aria-hidden />
                  <span>{t("provenance.copyDigest")}</span>
                </>
              )}
            </button>
          ) : null}
        </div>

        {citation.contentHash ? (
          <div className="rounded border border-pv-ink/[0.08] bg-pv-bg/70 p-2 font-mono text-[11px] text-pv-text/90 break-all select-all">
            {citation.contentHash}
          </div>
        ) : (
          <div className="text-[11px] text-pv-muted italic">
            {t("provenance.noDigest")}
          </div>
        )}

        <div className="pt-0.5">
          {citation.digestStatus === "verified" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-pv-emerald/30 bg-pv-emerald/[0.08] px-2 py-0.5 text-[10px] font-semibold text-pv-emerald">
              <ShieldCheck size={11} aria-hidden />
              {t("provenance.digestVerified")}
            </span>
          ) : citation.digestStatus === "malformed" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-pv-danger/30 bg-pv-danger/[0.08] px-2 py-0.5 text-[10px] font-semibold text-pv-danger">
              <AlertTriangle size={11} aria-hidden />
              {t("provenance.digestMalformed")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/[0.08] px-2 py-0.5 text-[10px] font-semibold text-amber-300">
              <AlertTriangle size={11} aria-hidden />
              {t("provenance.noDigest")}
            </span>
          )}
        </div>
      </div>

      {/* Section 3: Validation Status & Trust Tier & Source Availability */}
      <div className="space-y-1">
        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-pv-muted">
          {t("provenance.validationStatus")}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${STATUS_CLASSES[citation.status]}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
            {t(`rowStatus.${citation.status}`)}
          </span>

          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${TRUST_CLASSES[citation.trustTier]}`}
          >
            {t(`trust.${citation.trustTier}`)}
          </span>

          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${AVAILABILITY_CLASSES[citation.sourceAvailability]}`}
          >
            {t(`provenance.availability_${citation.sourceAvailability}`)}
          </span>
        </div>
      </div>

      {/* Section 4: Source Availability Decoupled Notice */}
      <div
        className="rounded border border-pv-ink/[0.08] bg-pv-ink/[0.03] p-2.5 text-[11px] leading-relaxed text-pv-muted"
        role="note"
      >
        <div className="flex items-start gap-1.5">
          <Info size={13} className="mt-0.5 shrink-0 text-pv-cyan" aria-hidden />
          <span>{t("provenance.truthSeparationNotice")}</span>
        </div>
      </div>
    </div>
  );
}
