"use client";

import React from "react";
import { formatAtomicUsdc } from "@/lib/usdc";
import type { CopyPermissionFeedbackView, CopyPermissionStatus } from "@/lib/copy-permission-feedback";
import { ShieldAlert, ShieldCheck, Clock, AlertTriangle, Unlink, Activity, RefreshCw } from "lucide-react";

const STATUS_THEME: Record<CopyPermissionStatus, { label: string; tone: string; icon: React.ComponentType<{ className?: string }> }> = {
  ready: { label: "Contract Backed", tone: "border-pv-emerald/40 bg-pv-emerald/10 text-pv-emerald", icon: ShieldCheck },
  loading: { label: "Verifying Contract", tone: "border-pv-gold/40 bg-pv-gold/10 text-pv-gold", icon: Clock },
  invalid: { label: "Constraint Violation", tone: "border-pv-danger/40 bg-pv-danger/10 text-pv-danger", icon: ShieldAlert },
  stale: { label: "Stale Snapshot", tone: "border-amber-400/40 bg-amber-400/10 text-amber-300", icon: RefreshCw },
  disconnected: { label: "Wallet Disconnected", tone: "border-pv-muted/40 bg-pv-surface text-pv-muted", icon: Unlink },
  dependency_failure: { label: "Chain RPC Error", tone: "border-pv-danger/40 bg-pv-danger/10 text-pv-danger", icon: AlertTriangle },
  paused: { label: "Policy Paused", tone: "border-amber-400/40 bg-amber-400/10 text-amber-300", icon: Clock },
  revoked: { label: "Revoked", tone: "border-pv-danger/40 bg-pv-danger/10 text-pv-danger", icon: ShieldAlert },
  expired: { label: "Expired", tone: "border-pv-muted/40 bg-pv-surface text-pv-muted", icon: Clock },
};

export function CopyPermissionCard({
  feedback,
  onRevoke,
  isRevoking,
}: {
  feedback: CopyPermissionFeedbackView;
  onRevoke?: (permissionId: string) => void;
  isRevoking?: boolean;
}) {
  const theme = STATUS_THEME[feedback.status] ?? STATUS_THEME.invalid;
  const Icon = theme.icon;
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const dialogRef = React.useRef<HTMLHTMLElement | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);

  const closeConfirm = React.useCallback(() => {
    setConfirmOpen(false);
    // Return focus to the trigger after the dialog unmounts.
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const confirmRevoke = React.useCallback(() => {
    const permissionId = feedback.permissionId;
    setConfirmOpen(false);
    if (permissionId){
      onRevoke?.(permissionId);
    }
  }, [feedback.permissionId, onRevoke]);

  // Focus trap + Escape handling for the confirmation dialog.
  React.useEffect(() => {
    if (!confirmOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeConfirm();
        return;
      }
      if (event.key !== "Tab") return;
      const node = dialogRef.current;
      if (!node) return;
      const focusable = Array.from(
        node.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([-tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || !active || !node.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !active || !node.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [confirmOpen, closeConfirm]);

  return (
    <section
      role="region"
      aria-label={`Copy trading permission ${feedback.permissionId ?? ""}`}
      className="rounded-2xl border border-pv-ink/10 bg-pv-surface/30 p-5 transition-colors"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-pv-ink/10 pb-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-semibold text-pv-text">
              {feedback.permissionId ? `Permission: ${feedback.permissionId}` : "Copy Permission"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-pv-muted">
            Follows <span className="font-mono text-pv-text">{feedback.signalAgentId ?? "—"}</span> via,{" "}
            <span className="font-mono text-pv-text">{feedback.executionAgentId ?? "—"}</span>
          </p>
        </div>

        <div
          role="status"
          aria-live="polite"
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider ${theme.tone}`}
        >
          <Icon className="h-w-3 w-3 shrink-0" />
          <span>{theme.label}</span>
        </div>
      </header>

      {/* Contract-backed feedback detail notice */}
      <div
        className="mt-3 rounded-lg border border-pv-ink/10 bg-pv-surface2/40 px-3.5 py-2 text-xs text-pv-muted"
        aria-live="polite"
      >
        <span className="font-medium text-pv-text">Feedback:</span> {feedback.detail}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
        <div className="rounded-lg border border-pv-ink/10 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Max Position</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-pv-text">
            {feedback.maxPerPositionAtomic ? `${formatAtomicUsdc(feedback.maxPerPositionAtomic)} USDC` : "—"}
          </div>
        </div>

        <div className="rounded-lg border border-pv-ink/10 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Daily Cap</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-pv-text">
            {feedback.dailyCapAtomic ? `${formatAtomicUsdc(feedback.dailyCapAtomic)} USDC` : "—"}
          </div>
        </div>

        <div className="rounded-lg border border-pv-ink/10 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">On-Chain Allowance</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-pv-text">
            {feedback.onchainAllowanceAtomic !== null
              ? `${formatAtomicUsdc(feedback.onchainAllowanceAtomic)} USDC`
              : "Unread"}
          </div>
        </div>

        <div className="rounded-lg border border-pv-ink/10 p-2.5">
          <div className="font-mono text-[10px] uppercase tracking-wider text-pv-muted">Max Realized Loss</div>
          <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-pv-text">
            {feedback.maxRealizedLossAtomic ? `${formatAtomicUsdc(feedback.maxRealizedLossAtomic)} USDC` : "—"}
          </div>
        </div>
      </div>

      {onRevoke && feedback.permissionId && !feedback.isRevoked && (
        <div className="mt-4 flex justify-end">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={isRevoking}
            className="rounded border border-pv-danger/40 bg-pv-danger/10 px-3 py-1.5 font-mono text-xs font-semibold text-pv-danger transition-colors hover:bg-pv-danger/20 disabled:opacity-50"
            aria-label={`Revoke copy permission ${feedback.permissionId}`}
          >
            {isRevoking ? "Revoking…" : "Revoke Permission"}
          </button>
        </div>
      )}

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeConfirm();
          }}
        >
          <div
            ref={dialogRef}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="copy-revoke-title"
            aria-describedby="copy-revoke-description"
            className="w-full max-w-lg rounded-2xl border border-pv-ink/10 bg-pv-surface p-5 shadow-xl text-pv-text"
          >
            <h2 id="copy-revoke-title" className="text-base font-semibold">
              Revoke copy permission
            </h2>
            <div id="copy-revoke-description" className="mt-3 space-y-3 text-sm text-pv-muted">
              <p>
                This will stop Mimir from executing further copies for permission <span className="font-mono text-pv-text">{feedback.permissionId}</span>. You will be asked to sign the revocation with your wallet.
              </p>
              <p className="rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-amber-300">
                <strong>It does not</strong> revoke on-chain spend allowances. To stop token spending entirely, revoke the spend permission separately — see the spend-permission explanation in the copy permission feedback guide.
              </p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={closeConfirm}
                className="rounded border border-pv-ink/10 bg-pv-surface2 px-3 py-1.5 font-mono text-xs font-semibold text-pv-text hover:bg-pv-surface2/80"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmRevoke}
                disabled={isRevoking}
                className="rounded border border-pv-danger/40 bg-pv-danger/10 px-3 py-1.5 font-mono text-xs font-semibold text-pv-danger transition-colors hover:bg-pv-danger/20 disabled:opacity-50"
              >
                {isRevoking ? "Revoking…" : "Confirm revoke"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}