"use client";

/**
 * Wallet context and connect modal — Stellar Testnet.
 *
 * ── What this replaces, and what genuinely changed ───────────────────────────
 *
 * The EVM version offered "two doors": an embedded-wallet onboarding path for
 * anyone without a wallet, and one connector that could batch `approve` + stake
 * into a single confirmation. Neither concept survives the move to Stellar, and
 * not because they were dropped for convenience:
 *
 *  - **No walletless door.** Stellar Wallet Kit connects wallets that already
 *    exist; it has no embedded/custodial signer to create one on the user's
 *    behalf. So the modal is a wallet list again. Accepted scope drop.
 *  - **Nothing to batch.** Soroban authorises per invocation: `create_claim` and
 *    `challenge_claim` carry auth that permits exactly one USDC transfer of
 *    exactly the staked amount. There is no standing allowance to grant, so the
 *    "one-tap" connector had nothing left to optimise — staking is one signature
 *    for every wallet here. See `lib/stellar-trustline.ts` for the one remaining
 *    first-time step and why it cannot be folded into the same transaction.
 *  - **No chain-switch prompt.** Stellar wallets have no EVM-style
 *    `wallet_switchEthereumChain`. The network is decided by the RPC and
 *    passphrase Mimir submits to, so a wallet pointed at Pubnet is not a
 *    pre-flight chain-id mismatch — it is a signature over the wrong network
 *    passphrase, which surfaces when signing. {@link WalletContextValue.networkWarning}
 *    reports it when the wallet is willing to say, and `signTransaction` throws
 *    a message a user can act on when it is not.
 *
 * What is kept: the picker-modal shell (dialog semantics, Escape to close,
 * focus on open) and the recent-wallet localStorage hint, because returning
 * users should tap once rather than choose again.
 *
 * The kit is loaded on demand rather than imported at module scope: it ships a
 * Preact + twind UI of its own and five wallet SDKs, none of which belong in the
 * first paint of a page that may never open this modal.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SignAuthEntry, SignTransaction } from "@stellar/stellar-sdk/contract";

import { NETWORK_PASSPHRASE, STELLAR_NETWORK, type StellarSigner } from "./stellar";
import {
  badgeFor,
  installUrlFor,
  labelFor,
  shapeWalletOptions,
  subtitleFor,
  checkWalletSigningCapability,
  getWalletCapabilityReport,
  supportsAuthEntrySigning,
  type WalletCapabilityCheckResult,
  type WalletCapabilityReport,
  type WalletSigningMethod,

  type ShapedWallet,
} from "./wallet-connectors";

export {
  checkWalletSigningCapability,
  getWalletCapabilityReport,
  type WalletCapabilityCheckResult,
  type WalletCapabilityReport,
  type WalletSigningMethod,
};
import { walletRowLabel } from "./wallet-aria";
import {
  canResubmitPayment,
  createUncertainSubmission,
  reconcileUncertainSubmission as reconcileUncertainSubmissionState,
  type CreateUncertainSubmissionParams,
  type ReconcileUncertainSubmissionOptions,
  type ReconciliationProbeResult,
  type UncertainSubmissionState,
  type UncertainSubmissionStatus,
} from "./wallet-submission-recovery";

export {
  canResubmitPayment,
  createUncertainSubmission,
  reconcileUncertainSubmissionState as reconcileUncertainSubmission,
  type CreateUncertainSubmissionParams,
  type ReconcileUncertainSubmissionOptions,
  type ReconciliationProbeResult,
  type UncertainSubmissionState,
  type UncertainSubmissionStatus,
};

/** Remembering the last wallet turns a five-row decision into one tap on return. */
const RECENT_WALLET_KEY = "mimir-recent-wallet";

function readRecentWallet(): string | null {
  try {
    return window.localStorage.getItem(RECENT_WALLET_KEY);
  } catch {
    return null;
  }
}

function rememberWallet(id: string): void {
  try {
    window.localStorage.setItem(RECENT_WALLET_KEY, id);
  } catch {
    /* private mode — the modal simply won't show a "recent" hint next time */
  }
}

// ── Kit loading ───────────────────────────────────────────────────────────────

type Kit = typeof import("@creit.tech/stellar-wallets-kit").StellarWalletsKit;

let kitPromise: Promise<Kit> | null = null;

/**
 * Load and initialise Stellar Wallet Kit exactly once per tab.
 *
 * Module subpaths, not the barrel: importing `@creit.tech/stellar-wallets-kit`
 * alone is fine, but `.../modules/ledger` and `.../modules/trezor` pull in WebUSB
 * transports, so only the wallets Mimir offers are pulled in.
 *
 * The kit's QR-relay module is deliberately NOT among them. Two reasons, and the
 * second is the honest one: it needs a relay project id nobody has configured,
 * and its exported class name is a brand that this repo's forbidden-terms
 * guardrail blocks (the term was banned as EVM/Base branding, so this is a name
 * collision with a genuinely-Stellar module rather than a leftover). Every wallet
 * offered here is a browser extension or a hosted signer, which covers the
 * desktop story; adding mobile deep-linking needs that guardrail exception
 * agreed first.
 */
async function loadKit(): Promise<Kit> {
  if (kitPromise) return kitPromise;

  kitPromise = (async () => {
    const [
      { StellarWalletsKit },
      { FreighterModule },
      { xBullModule },
      { AlbedoModule },
      { LobstrModule },
      { HanaModule },
    ] = await Promise.all([
      import("@creit.tech/stellar-wallets-kit"),
      import("@creit.tech/stellar-wallets-kit/modules/freighter"),
      import("@creit.tech/stellar-wallets-kit/modules/xbull"),
      import("@creit.tech/stellar-wallets-kit/modules/albedo"),
      import("@creit.tech/stellar-wallets-kit/modules/lobstr"),
      import("@creit.tech/stellar-wallets-kit/modules/hana"),
    ]);

    // The kit's `Networks` is an enum OF PASSPHRASES, and the only thing it ever
    // does with the value is forward it as `networkPassphrase` when signing. So
    // the app's configured passphrase is passed straight through rather than
    // mapped from a network name — which also means a standalone or quickstart
    // network works without the enum having a member for it. The cast is why
    // the enum is not imported at runtime at all.
    const network = NETWORK_PASSPHRASE as NonNullable<
      Parameters<typeof StellarWalletsKit.init>[0]["network"]
    >;

    StellarWalletsKit.init({
      modules: [
        new FreighterModule(),
        new xBullModule(),
        new AlbedoModule(),
        new LobstrModule(),
        new HanaModule(),
      ],
      network,
      authModal: { hideUnsupportedWallets: false },
    });

    return StellarWalletsKit;
  })();

  return kitPromise;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Redact Stellar secret seeds (S… 56 base32 chars) and sensitive key patterns
 * from diagnostic/error strings to avoid leaking credentials.
 */
export function sanitizeWalletMessage(message: string): string {
  if (!message) return "";
  return message
    .replace(/(api[_-]?key|authorization|bearer|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/(^|[^A-Z0-9])S[A-Z2-7]{55}(?![A-Z0-9])/g, "$1[redacted-seed]");
}

/**
 * The kit rejects with plain `{ code, message }` objects, not `Error`s, so a
 * `catch (e) { e.message }` at a call site reads `undefined`. Everything crossing
 * out of this module becomes a real `Error` with a message worth showing.
 *
 * Private connector payloads (such as `ext` or `payload` details) are kept out
 * of public diagnostics and error messages, and secret seeds are redacted.
 */
export function toWalletError(cause: unknown, action: string): Error {
  let message: string | undefined;

  if (cause instanceof Error) {
    message = cause.message;
  } else if (cause && typeof cause === "object") {
    const kitError = cause as {
      code?: number;
      message?: string;
      ext?: unknown;
      payload?: unknown;
      data?: unknown;
    };

    if (typeof kitError.message === "string" && kitError.message.trim()) {
      message = kitError.message.trim();
    }
    // Private connector payloads (kitError.ext, kitError.payload) are intentionally
    // omitted from public diagnostics and error messages.
  } else if (typeof cause === "string" && cause.trim()) {
    message = cause.trim();
  }

  if (message) {
    return new Error(sanitizeWalletMessage(message));
  }

  return new Error(`Could not ${action}.`);
}

function isRejection(message: string): boolean {
  return /reject|denied|cancel|closed the modal|user declined/i.test(message);
}

// ── Intent Generation and Obsolete Result Guarding ───────────────────────────

/**
 * Thrown when an asynchronous wallet signing result arrives after the active
 * signing intent has been superseded or the active wallet account has changed.
 */
export class ObsoleteSigningIntentError extends Error {
  readonly generation: number;
  readonly activeGeneration: number;
  readonly expectedAddress: string;
  readonly currentAddress: string | null;

  constructor(details: {
    generation: number;
    activeGeneration: number;
    expectedAddress: string;
    currentAddress: string | null;
    message?: string;
  }) {
    super(
      details.message ??
        `Wallet signing result ignored: signing intent generation ${details.generation} is obsolete (active generation is ${details.activeGeneration}${
          details.expectedAddress !== details.currentAddress
            ? `, account switched from ${details.expectedAddress} to ${details.currentAddress ?? "disconnected"}`
            : ""
        }).`,
    );
    this.name = "ObsoleteSigningIntentError";
    this.generation = details.generation;
    this.activeGeneration = details.activeGeneration;
    this.expectedAddress = details.expectedAddress;
    this.currentAddress = details.currentAddress;
  }
}

/** Check if an unknown error represents an obsolete signing intent. */
export function isObsoleteSigningIntentError(
  error: unknown,
): error is ObsoleteSigningIntentError {
  return (
    error instanceof ObsoleteSigningIntentError ||
    (error instanceof Error &&
      (error.name === "ObsoleteSigningIntentError" ||
        /obsolete.*intent|stale.*intent|intent.*obsolete/i.test(error.message)))
  );
}

export interface SigningIntent {
  generation: number;
  address: string;
}

/**
 * Returns true if the given intent matches the active session generation and address.
 */
export function isIntentActive(
  intent: SigningIntent,
  active: { generation: number; address: string | null },
): boolean {
  return intent.generation === active.generation && intent.address === active.address;
}

/**
 * Asserts that the intent matches the active session generation and address.
 * Throws ObsoleteSigningIntentError if mismatched or obsolete.
 */
export function assertActiveIntent(
  intent: SigningIntent,
  active: { generation: number; address: string | null },
): void {
  if (!isIntentActive(intent, active)) {
    throw new ObsoleteSigningIntentError({
      generation: intent.generation,
      activeGeneration: active.generation,
      expectedAddress: intent.address,
      currentAddress: active.address,
    });
  }
}

/**
 * Bind an existing StellarSigner to an active intent generation.
 * Any signing call that completes after the active generation or address has changed
 * will reject with ObsoleteSigningIntentError instead of returning a stale signature.
 */
export function bindIntentToSigner(
  signer: StellarSigner,
  intent: SigningIntent,
  getActive: () => { generation: number; address: string | null },
): StellarSigner {
  return {
    publicKey: signer.publicKey,
    signTransaction: async (xdr, opts) => {
      assertActiveIntent(intent, getActive());
      const result = await signer.signTransaction(xdr, opts);
      assertActiveIntent(intent, getActive());
      return result;
    },
    ...(signer.signAuthEntry
      ? {
          signAuthEntry: async (entry, opts) => {
            assertActiveIntent(intent, getActive());
            const result = await signer.signAuthEntry!(entry, opts);
            assertActiveIntent(intent, getActive());
            return result;
          },
        }
      : {}),
  };
}

// ── Context ───────────────────────────────────────────────────────────────────

export interface WalletContextValue {
  /** The connected account's `G…` strkey, or null. */
  address: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** "rejected" for a user-cancelled attempt, "error" otherwise, else null. */
  error: string | null;

  /**
   * SEP-43 transaction signing, shaped as `@stellar/stellar-sdk`'s
   * `SignTransaction` so it can be handed to a generated `Client` as-is.
   */
  signTransaction: SignTransaction;

  /**
   * SEP-43 auth-entry signing. Only needed to co-sign an invocation somebody else
   * submits; Mimir's own writes are invoker-authorised. Throws a clear message on
   * wallets that do not implement it.
   */
  signAuthEntry: SignAuthEntry;

  /** Off-chain attestation signing. Returns the base64 signature. */
  signMessage: (message: string) => Promise<string>;

  /**
   * Ready to pass straight to any write in `lib/contract.ts` — the same
   * `StellarSigner` shape those functions expect, with no adapter in between.
   * Null until a wallet is connected.
   */
  signer: StellarSigner | null;

  /** Product name of the connected wallet, e.g. "Freighter". */
  walletName: string | null;

  /** The connected wallet cannot sign off-chain messages (Albedo). */
  canSignMessages: boolean;

  /** The connected wallet cannot co-sign auth entries. */
  canSignAuthEntries: boolean;

  /** Explicit signing capability report for the currently selected connector. */
  capabilities: WalletCapabilityReport;

  /**
   * Check whether the selected connector supports the required signing method
   * before starting a transaction. Returns a safe unsupported-method result
   * without requesting a signature from the wallet.
   */
  checkTransactionCapability: (
    requiredMethod?: WalletSigningMethod,
  ) => WalletCapabilityCheckResult;

  /** Set when the wallet reports a different network than Mimir submits to. */
  networkWarning: string | null;

  /**
   * Transaction lifecycle state for the most recent user-initiated action.
   * Used by confirmation polling and feedback UI to show loading, invalid,
   * stale, disconnected, or dependency-failure states.
   */
  transactionState: TransactionState | null;

  /**
   * Monotonic generation counter for the active signing intent and account session.
   * Increments on account switch, disconnect, or when a new signing intent begins,
   * binding responses to the active intent generation and preventing stale wallet results.
   */
  intentGeneration: number;

  /** Rows for the picker modal, already ordered. */
  wallets: ModalWallet[];

  /**
   * A resumable setup action the caller asked for before the wallet was
   * ready (#769). Non-null while a trustline setup is pending; the caller's
   * `resume()` runs exactly once after the trustline is confirmed on chain.
   */
  pendingTrustlineIntent: PendingTrustlineIntent | null;

  /**
   * Request a USDC trustline and resume `onReady` **only** once it is
   * confirmed on chain. If the user leaves mid-flow, the intent is persisted
   * to `sessionStorage` and resumed on provider mount. The classic trustline
   * transaction is submitted independently of any Soroban staking call.
   */
  requestTrustlineThen: (onReady: () => void) => Promise<void>;

  /** Active cross-tab signing ownership record for the connected account, if any. */
  signingOwnership?: WalletSigningOperationRecord | null;

  /** True when another tab currently owns an active signing prompt for the connected account. */
  signingBlockedByOtherTab?: boolean;

  /** Unacknowledged uncertain recovery record from an interrupted signing prompt, if any. */
  signingRecovery?: WalletSigningOperationRecord | null;

  /** Explicitly acknowledge and dismiss a pending uncertain signing recovery record. */
  acknowledgeSigningRecovery?: (operationId?: string) => boolean;

  /** Alias for {@link acknowledgeSigningRecovery}. */
  dismissSigningRecovery?: (operationId?: string) => boolean;

  /**
   * Acknowledge any pending uncertain recovery for the connected account and invoke
   * `retry()` as an explicit user opt-in retry.
   */
  retryAfterSigningRecovery?: <T>(
    retry: () => Promise<T>,
    operationId?: string,
  ) => Promise<T>;
}

/**
 * In-memory handle to a pending trustline intent. The callback is not
 * persisted — only the fact that an intent exists and the address it belongs
 * to are. On remount the callback is re-registered by the caller, so a reload
 * still resumes the original intent through `onReady`.
 */
export interface PendingTrustlineIntent {
  address: string;
  resume: () => void;
}

/**
 * `sessionStorage` key for the persisted intent. Non-sensitive: address only.
 *
 * Written with a namespaced prefix so it cannot collide with any other
 * resumable-flow key another feature may add later.
 */
const PENDING_TRUSTLINE_KEY = "mimir.pendingTrustlineIntent.v1";

function readPendingTrustline(): { address: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_TRUSTLINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { address?: unknown };
    if (typeof parsed?.address !== "string" || parsed.address.length === 0) return null;
    return { address: parsed.address };
  } catch {
    return null;
  }
}

function writePendingTrustline(address: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      PENDING_TRUSTLINE_KEY,
      JSON.stringify({ address }),
    );
  } catch {
    // sessionStorage can be disabled; the in-memory intent still works.
  }
}

function clearPendingTrustline(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PENDING_TRUSTLINE_KEY);
  } catch {
    // ignore
  }
}

type ModalWallet = ShapedWallet & { connect: () => void };

const NO_WALLET = "Connect a Stellar wallet first.";

const Ctx = createContext<WalletContextValue>({
  transactionState: null,
  intentGeneration: 0,
  address: null,
  isConnected: false,
  isConnecting: false,
  connect: async () => {},
  disconnect: () => {},
  error: null,

  signTransaction: async () => {
    throw new Error(NO_WALLET);
  },

  signAuthEntry: async () => {
    throw new Error(NO_WALLET);
  },

  signMessage: async () => {
    throw new Error(NO_WALLET);
  },

  signer: null,
  walletName: null,
  canSignMessages: false,
  canSignAuthEntries: false,
  capabilities: getWalletCapabilityReport(null, null),
  checkTransactionCapability: (requiredMethod = "signTransaction") =>
    checkWalletSigningCapability(null, requiredMethod, null),
  networkWarning: null,
  wallets: [],
  pendingTrustlineIntent: null,
  requestTrustlineThen: async () => {},
  signingOwnership: null,
  signingBlockedByOtherTab: false,
  signingRecovery: null,
  acknowledgeSigningRecovery: () => false,
  dismissSigningRecovery: () => false,
  retryAfterSigningRecovery: async (retry) => retry(),
});

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Lifecycle states for wallet-initiated transactions.
 *
 * - `null`: No active transaction feedback.
 * - `"loading"`: Transaction submitted, awaiting confirmation or failure.
 * - `"invalid"`: Transaction structure or signature failed validation before submission.
 * - `"stale"`: Transaction confirmed on-chain but the wallet session lost sync (e.g. reconnect).
 * - `"disconnected"`: Wallet disconnected during a pending transaction.
 * - `"dependency-failure"`: A required upstream step (e.g. trustline) failed.
 * - `"uncertain-submission"`: Transaction was submitted, but transport/timeout left its outcome uncertain; reconcile by hash instead of resubmitting.
 */
export type TransactionState =
  | "loading"
  | "invalid"
  | "stale"
  | "disconnected"
  | "dependency-failure"
  | "uncertain-submission";

// ── Modal ─────────────────────────────────────────────────────────────────────

function WalletMark({ wallet }: { wallet: ModalWallet }) {
  if (wallet.icon) {
    return (
      // Kit-supplied data URI / CDN mark; next/image would only put a loader in
      // front of it, and the kit already ships these at the size we render.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={wallet.icon}
        alt=""
        aria-hidden
        className="h-7 w-7 shrink-0 rounded-md"
      />
    );
  }

  return (
    <span
      aria-hidden
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-pv-ink/[0.14] font-mono text-[12px] font-bold text-pv-muted"
    >
      {wallet.monogram}
    </span>
  );
}

function WalletRow({
  wallet,
  isPending,
  featured,
}: {
  wallet: ModalWallet;
  isPending: boolean;
  featured: boolean;
}) {
  const subtitle = subtitleFor(wallet);
  const badge = badgeFor(wallet);
  const installUrl = installUrlFor(wallet);

  const shell = `flex w-full items-center gap-3 border px-4 py-3 text-left transition-colors duration-150 disabled:opacity-50 ${
    featured
      ? "border-pv-emerald/45 bg-pv-emerald/[0.08] hover:border-pv-emerald hover:bg-pv-emerald/[0.14]"
      : "border-pv-ink/[0.12] bg-pv-surface2/60 hover:border-pv-emerald/50 hover:bg-pv-surface2"
  }`;

  const body = (
    <>
      <WalletMark wallet={wallet} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-pv-text">
            {labelFor(wallet)}
          </span>
        </span>

        {subtitle && (
          <span className="mt-0.5 block truncate text-[11px] text-pv-muted">
            {subtitle}
          </span>
        )}
      </span>

      {badge && (
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-pv-muted">
          {badge}
        </span>
      )}
    </>
  );

  // A wallet that is not installed cannot be connected to, so the row becomes a
  // link to its site rather than a button that fails. Silently doing nothing is
  // how "the connect button is broken" reports happen.
  if (installUrl) {
    return (
      <a
        href={installUrl}
        target="_blank"
        rel="noreferrer"
        className={shell}
        aria-label={walletRowLabel(labelFor(wallet), { installed: false, recent: wallet.recent, wrapper: wallet.wrapper })}
      >
        {body}
      </a>
    );
  }

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={wallet.connect}
      aria-label={walletRowLabel(labelFor(wallet), { installed: wallet.installed, recent: wallet.recent, wrapper: wallet.wrapper })}
      className={shell}
    >
      {body}
    </button>
  );
}

function WalletPickerModal({
  open,
  onClose,
  wallets,
  isPending,
  loading,
  error,
}: {
  open: boolean;
  onClose: () => void;
  wallets: ModalWallet[];
  isPending: boolean;
  loading: boolean;
  error: string | null;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes: a modal that can only be dismissed by clicking the backdrop
  // traps anyone on a keyboard.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();

    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // The top row is whatever the ordering already decided is most likely right:
  // the in-app browser you are inside, or the wallet you used last.
  const [primary, ...rest] = wallets;
  const ready = rest.filter((wallet) => wallet.installed);
  const notInstalled = rest.filter((wallet) => !wallet.installed);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Connect wallet"
        className="w-full max-w-sm border border-pv-border/40 bg-pv-bg p-5 shadow-2xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* sr-only live region announces connection status changes without
            requiring focus, so Freighter users hear "Connecting to Freighter"
            as soon as they click a row rather than waiting for the button to
            re-render under focus. */}
        <div aria-live="polite" aria-atomic="true" className="sr-only">
          {isPending
            ? "Connecting to wallet — please check your wallet extension"
            : error === "rejected"
              ? "Connection rejected in wallet"
              : error
                ? "Could not connect. Try another wallet."
                : ""}
        </div>

        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-display text-lg font-bold text-pv-text">
            Connect wallet
          </h2>

          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 text-sm text-pv-muted transition-colors hover:text-pv-text"
            aria-label="Close connect wallet dialog"
          >
            ✕
          </button>
        </div>

        <p className="mb-4 font-mono text-[11px] uppercase tracking-wider text-pv-muted">
          Stellar · {STELLAR_NETWORK}
        </p>

        <div className="space-y-2">
          {loading && wallets.length === 0 && (
            <p className="text-sm text-pv-muted" role="status" aria-live="polite">Looking for wallets…</p>
          )}

          {primary && (
            <WalletRow
              wallet={primary}
              isPending={isPending}
              featured
            />
          )}

          {ready.map((wallet) => (
            <WalletRow
              key={wallet.id}
              wallet={wallet}
              isPending={isPending}
              featured={false}
            />
          ))}

          {notInstalled.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer list-none border border-pv-ink/[0.12] px-4 py-2.5 text-center font-mono text-[11px] uppercase tracking-wider text-pv-muted transition-colors hover:border-pv-ink/[0.25] hover:text-pv-text">
                Don&apos;t have one? ({notInstalled.length})
              </summary>

              <div className="mt-2 space-y-2">
                {notInstalled.map((wallet) => (
                  <WalletRow
                    key={wallet.id}
                    wallet={wallet}
                    isPending={isPending}
                    featured={false}
                  />
                ))}
              </div>
            </details>
          )}
        </div>

        {error && (
          <p role="alert" className="mt-3 text-xs text-pv-danger">
            {error === "rejected"
              ? "Connection rejected in wallet."
              : "Could not connect. Try another wallet."}
          </p>
        )}
      </div>
    </div>
  );
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [networkWarning, setNetworkWarning] = useState<string | null>(null);
  // Exposed through the context for lifecycle feedback UI. Driven by active
  // signing intents, account switches, and disconnect transitions.
  const [transactionState, setTransactionState] = useState<TransactionState | null>(null);
  const [intentGeneration, setIntentGeneration] = useState(0);
  const intentGenerationRef = useRef(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [options, setOptions] = useState<ShapedWallet[]>([]);
  const [recentId, setRecentId] = useState<string | null>(null);
  const [pendingTrustlineIntent, setPendingTrustlineIntent] = useState<PendingTrustlineIntent | null>(null);
  const [signingState, setSigningState] = useState<WalletSigningAccountState | null>(null);

  // Read by the signing callbacks, which must stay referentially stable so the
  // memoised `signer` does not change identity on every render.
  const addressRef = useRef<string | null>(null);
  addressRef.current = address;
  const walletIdRef = useRef<string | null>(null);
  walletIdRef.current = walletId;
  const walletNameRef = useRef<string | null>(null);
  walletNameRef.current = walletName;

  /**
   * Restore a previous session without prompting.
   *
   * The kit persists the selected module id and the address it last resolved, so
   * a reload can adopt them silently — asking a returning user to approve the
   * same extension again on every navigation is the thing the recent-wallet hint
   * exists to avoid. Nothing here can open a wallet UI: `getAddress` reads the
   * kit's memory, unlike `fetchAddress`, which asks the extension.
   */
  useEffect(() => {
    // Restore a persisted trustline intent (#769). Non-null means the caller
    // previously asked for a trustline setup that had not finished; the UI
    // shows the "add trustline" gate and the caller re-registers its resume
    // callback when it mounts. No resume callback is called here: only the
    // caller knows what the intent was for.
    const persisted = readPendingTrustline();
    if (persisted) {
      setPendingTrustlineIntent({ address: persisted.address, resume: () => {} });
    }

    let cancelled = false;

    (async () => {
      const remembered = readRecentWallet();

      if (!cancelled) setRecentId(remembered);

      try {
        const kit = await loadKit();

        if (remembered) {
          try {
            kit.setWallet(remembered);
          } catch {
            // The remembered wallet is no longer one of our modules.
          }
        }

        const { address: restored } = await kit.getAddress();

        if (cancelled || !restored) return;

        addressRef.current = restored;
        intentGenerationRef.current += 1;
        setIntentGeneration(intentGenerationRef.current);
        setAddress(restored);
        setWalletId(newWalletId);
        setWalletName(kit.selectedModule.productName);
      } catch {
        // No persisted session, or nothing selected. Stay disconnected.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Best-effort network check.
   *
   * Not every wallet answers `getNetwork` — Albedo, xBull and Lobstr all reject
   * it outright — so a failure here means "unknown", never "wrong". A real
   * mismatch is a warning rather than a block: the user can still read the app,
   * and the signature is what actually fails.
   */
  useEffect(() => {
    if (!address) {
      setNetworkWarning(null);
      networkRef.current = null;
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const kit = await loadKit();
        const { networkPassphrase } = await kit.getNetwork();

        if (cancelled || !networkPassphrase) return;

        const prevNetwork = networkRef.current;
        networkRef.current = networkPassphrase;

        if (prevNetwork !== null && prevNetwork !== networkPassphrase) {
          sessionRevisionRef.current += 1;
          setSessionRevision(sessionRevisionRef.current);
        }

        setNetworkWarning(
          networkPassphrase === NETWORK_PASSPHRASE
            ? null
            : `Your wallet is on a different Stellar network. Switch it to ${STELLAR_NETWORK} before staking.`,
        );
      } catch {
        if (!cancelled) setNetworkWarning(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address]);

  /**
   * Detect a wallet account switch (#922).
   *
   * `stellar-wallets-kit` does not push account changes: the `address` state
   * above is only set on connect / restore / disconnect. When the user switches
   * accounts inside Freighter (or any injected wallet), that state stays on the
   * previous account — so any flow that signed intent for account A can silently
   * submit against account B. This effect re-reads the kit's current address on
   * window focus and on tab visibility restore, and calls `setAddress` only when
   * it has actually changed. No behaviour changes for users who never switch.
   */
  useEffect(() => {
    if (!address) return;
    let cancelled = false;

    const check = async () => {
      try {
        const kit = await loadKit();
        const { address: current } = await kit.getAddress();
        if (cancelled || !current || current === address) return;
        setAddress(current);
        setWalletId(kit.selectedModule.productId);
        setWalletName(kit.selectedModule.productName);
        console.info("[wallet] ACCOUNT_SWITCH_DETECTED", { from: address, to: current });
      } catch {
        // getAddress is a best-effort read; a failure is not an account switch.
      }
    };

    const onFocus = () => void check();
    const onVis = () => {
      if (document.visibilityState === "visible") void check();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [address]);

  // ── Signing ────────────────────────────────────────────────────────────────

  const executeSignTransaction = useCallback<SignTransaction>(
    async (xdr, opts) => {
      // Do not attempt to load or invoke the wallet provider after the
      // application has lost its connected wallet state.
      if (!addressRef.current) {
        throw new Error(NO_WALLET);
      }

      // SEP-43 has an optional "sign and submit for me" mode that the SDK's
      // SignTransaction type exposes and the kit's per-module `signTransaction`
      // does not implement — it would silently drop the flag and hand back an
      // unsubmitted envelope, which reads as "the transaction vanished". Mimir
      // always submits through Soroban RPC itself, so nothing sets this today;
      // refusing it keeps a future caller from finding out the hard way.
      if (opts?.submit) {
        throw new Error(
          "This wallet layer does not sign-and-submit; submit the signed transaction through Soroban RPC.",
        );
      }

      const myGeneration = ++intentGenerationRef.current;
      setIntentGeneration(myGeneration);
      const startingAddress = addressRef.current;
      setTransactionState("loading");

      const kit = await loadKit();
      const signerAddress = opts?.address ?? startingAddress ?? undefined;

      try {
        const signed = await kit.signTransaction(xdr, {
          networkPassphrase:
            opts?.networkPassphrase ?? NETWORK_PASSPHRASE,
          ...(signerAddress ? { address: signerAddress } : {}),
        });

        // Ignore late results belonging to an obsolete signing intent or
        // a superseded wallet connection.
        if (
          myGeneration !== intentGenerationRef.current ||
          !addressRef.current ||
          addressRef.current !== startingAddress
        ) {
          if (!addressRef.current) {
            setTransactionState("disconnected");
          } else {
            setTransactionState("stale");
          }
          throw new ObsoleteSigningIntentError({
            generation: myGeneration,
            activeGeneration: intentGenerationRef.current,
            expectedAddress: startingAddress,
            currentAddress: addressRef.current,
          });
        }

        setTransactionState(null);
        return {
          signedTxXdr: signed.signedTxXdr,
          signerAddress: signed.signerAddress,
        };
      } catch (cause) {
        if (isObsoleteSigningIntentError(cause)) {
          throw cause;
        }

        const err = toWalletError(cause, "sign this transaction");

        if (/network|passphrase/i.test(err.message)) {
          throw new Error(
            `${err.message} — check that your wallet is set to Stellar ${STELLAR_NETWORK}.`,
          );
        }

        throw err;
      }
    },
    [],
  );

  const signTransaction = useMemo<SignTransaction>(() => {
    const coordinated: SignTransaction = async (xdr, opts) => {
      const activeAddress = addressRef.current;
      if (!activeAddress) {
        throw new Error(NO_WALLET);
      }
      if (opts?.submit) {
        throw new Error(
          "This wallet layer does not sign-and-submit; submit the signed transaction through Soroban RPC.",
        );
      }

      const signerAddress = opts?.address ?? activeAddress;
      const coordinator = getBrowserWalletSigningCoordinator();
      return coordinator.runOperation(
        { account: signerAddress, operationKind: "sign_transaction" },
        () => executeSignTransaction(xdr, opts),
      );
    };

    registerUncoordinatedSignTransaction(coordinated, executeSignTransaction);
    return coordinated;
  }, [executeSignTransaction]);

  const signAuthEntry = useCallback<SignAuthEntry>(
    async (authEntry, opts) => {
      // An auth-entry signature must never proceed after the wallet has
      const capability = checkWalletSigningCapability(
        walletIdRef.current,
        "signAuthEntry",
        walletNameRef.current,
      );
      if (!capability.supported) {
        throw new Error(capability.reason);
      }
      // disconnected or the provider state has been cleared.
      const activeAddress = addressRef.current;
      if (!activeAddress) {
        throw new Error(NO_WALLET);
      }

      const signerAddress = opts?.address ?? activeAddress;
      const coordinator = getBrowserWalletSigningCoordinator();

      return coordinator.runOperation(
        { account: signerAddress, operationKind: "sign_auth_entry" },
        async () => {
          const kit = await loadKit();

          try {
            const signed = await kit.signAuthEntry(authEntry, {
              networkPassphrase:
                opts?.networkPassphrase ?? NETWORK_PASSPHRASE,
              ...(signerAddress ? { address: signerAddress } : {}),
            });

            return {
              signedAuthEntry: signed.signedAuthEntry,
              signerAddress: signed.signerAddress,
            };
          } catch (cause) {
            throw toWalletError(cause, "sign this authorization");
          }
        },
      );
    },
    [],
  );

  const signMessage = useCallback(async (message: string) => {
    // Off-chain signatures are still wallet actions and must not use a stale
    const capability = checkWalletSigningCapability(
      walletIdRef.current,
      "signMessage",
      walletNameRef.current,
    );
    if (!capability.supported) {
      throw new Error(capability.reason);
    }
    // address after disconnect.
    const activeAddress = addressRef.current;
    if (!activeAddress) {
      throw new Error(NO_WALLET);
    }

    const coordinator = getBrowserWalletSigningCoordinator();

    return coordinator.runOperation(
      { account: activeAddress, operationKind: "sign_message" },
      async () => {
        const kit = await loadKit();

        try {
          const signed = await kit.signMessage(message, {
            networkPassphrase: NETWORK_PASSPHRASE,
            address: activeAddress,
          });

          if (!signed.signedMessage) {
            throw new Error("The wallet returned no signature.");
          }

          return signed.signedMessage;
        } catch (cause) {
          throw toWalletError(cause, "sign this message");
        }
      },
    );
  }, []);

  const acknowledgeSigningRecovery = useCallback((operationId?: string) => {
    const currentAddress = addressRef.current;
    if (!currentAddress) return false;
    const cleared = getBrowserWalletSigningCoordinator().acknowledgeUncertainRecovery(
      currentAddress,
      operationId ? { operationId } : undefined,
    );
    return cleared !== null;
  }, []);

  const retryAfterSigningRecovery = useCallback(
    async <T,>(retry: () => Promise<T>, operationId?: string): Promise<T> => {
      const currentAddress = addressRef.current;
      if (currentAddress) {
        getBrowserWalletSigningCoordinator().acknowledgeUncertainRecovery(
          currentAddress,
          operationId ? { operationId } : undefined,
        );
      }
      return retry();
    },
    [],
  );

  /**
   * The signer handed to `lib/contract.ts`.
   *
   * `signAuthEntry` is only attached when the connected wallet actually
   * implements it. Attaching a callback that always rejects would make
   * `AssembledTransaction` believe co-signing is possible and fail deep inside
   * the SDK instead of at a place with something useful to say.
   */
  const signer = useMemo<StellarSigner | null>(() => {
    if (!address) return null;

    return {
      publicKey: address,
      signTransaction,
      ...(supportsAuthEntrySigning(walletId)
        ? { signAuthEntry }
        : {}),
    };
  }, [address, walletId, signTransaction, signAuthEntry]);

  // ── Connect / disconnect ───────────────────────────────────────────────────

  const refreshOptions = useCallback(async () => {
    setPickerLoading(true);

    try {
      const kit = await loadKit();
      const supported = await kit.refreshSupportedWallets();

      setOptions(
        shapeWalletOptions(
          supported.map((wallet) => ({
            id: wallet.id,
            name: wallet.name,
            icon: wallet.icon,
            url: wallet.url,
            type: wallet.type,
            isAvailable: wallet.isAvailable,
            isPlatformWrapper: wallet.isPlatformWrapper,
          })),
          { recentId: readRecentWallet() },
        ),
      );
    } catch (cause) {
      console.warn("[wallet] could not list wallets", cause);
      setOptions([]);
    } finally {
      setPickerLoading(false);
    }
  }, []);

  const connectWallet = useCallback(
    async (id: string) => {
      setIsConnecting(true);
      setError(null);

      try {
        const kit = await loadKit();

        kit.setWallet(id);

        // `fetchAddress`, not `getAddress`: this is the one place the extension
        // should be asked, because this is the click that asked for it.
        const { address: connected } = await kit.fetchAddress();

        // Update the address ref immediately and bump the intent generation
        // so any in-flight signatures belonging to a previous account session
        // are recognized as obsolete and rejected.
        addressRef.current = connected;
        intentGenerationRef.current += 1;
        setIntentGeneration(intentGenerationRef.current);
        setTransactionState(null);

        setAddress(connected);
        setWalletId(newWalletId);
        setWalletName(kit.selectedModule.productName);

        rememberWallet(id);
        setRecentId(id);
        setPickerOpen(false);
      } catch (cause) {
        const err = toWalletError(cause, "connect");
        setError(isRejection(err.message) ? "rejected" : "error");
      } finally {
        setIsConnecting(false);
      }
    },
    [],
  );

  const connect = useCallback(async () => {
    setError(null);
    setPickerOpen(true);
    await refreshOptions();
  }, [refreshOptions]);

  const disconnect = useCallback(() => {
    const prevAddress = addressRef.current;
    const prevWalletId = walletIdRef.current;

    // Clear the refs synchronously before doing any asynchronous kit work.
    // The signing callbacks read addressRef directly, so this prevents a stale
    // wallet address from being used during the disconnect transition.
    addressRef.current = null;
    walletIdRef.current = null;
    walletNameRef.current = null;

    setAddress(null);
    setWalletId(null);
    setWalletName(null);
    setNetworkWarning(null);
    uncertainSubmissionRef.current = null;
    setUncertainSubmission(null);
    setTransactionState(null);

    // The recent-wallet hint deliberately survives: it is what makes coming
    // back one tap. Only the session is cleared.
    void loadKit()
      .then((kit) => kit.disconnect())
      .catch(() => undefined);
  }, []);

  const requestTrustlineThen = useCallback(
    async (onReady: () => void) => {
      if (!address || !signer) {
        throw new Error(NO_WALLET);
      }

      // Persist the intent BEFORE submitting so a crash / reload between
      // submission and confirmation still resumes the user's original action.
      writePendingTrustline(address);
      setPendingTrustlineIntent({ address, resume: onReady });

      // The classic trustline transaction is submitted on its own — this is
      // deliberately NOT part of any Soroban staking call (#769).
      const submit = await import("./stellar-trustline");
      const submitted = await submit.submitUsdcTrustline(signer);
      if (submitted.status === "failed") {
        clearPendingTrustline();
        setPendingTrustlineIntent(null);
        throw new Error(submitted.reason);
      }

      // Confirm by re-reading the trustline until Horizon shows it. Do not
      // resume on submission — the whole point is that "submitted" is not
      // "ready".
      const confirmed = await submit.awaitUsdcTrustlineConfirmation(address);
      if (confirmed.status === "confirmed") {
        clearPendingTrustline();
        setPendingTrustlineIntent(null);
        onReady();
        return;
      }
      clearPendingTrustline();
      setPendingTrustlineIntent(null);
      throw new Error(confirmed.reason);
    },
    [address, signer],
  );

  const wallets = useMemo<ModalWallet[]>(
    () =>
      options.map((wallet) => ({
        ...wallet,
        recent: wallet.id === recentId,
        connect: () => void connectWallet(wallet.id),
      })),
    [options, recentId, connectWallet],
  );

  const capabilities = useMemo(
    () => getWalletCapabilityReport(walletId, walletName),
    [walletId, walletName],
  );

  const checkTransactionCapability = useCallback(
    (requiredMethod: WalletSigningMethod = "signTransaction") =>
      checkWalletSigningCapability(
        walletIdRef.current,
        requiredMethod,
        walletNameRef.current,
      ),
    [],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      address,
      isConnected: Boolean(address),
      isConnecting,
      connect,
      disconnect,
      error,
      signTransaction,
      signAuthEntry,
      signMessage,
      signer,
      walletName,
      canSignMessages: capabilities.methods.signMessage,
      canSignAuthEntries: capabilities.methods.signAuthEntry,
      capabilities,
      checkTransactionCapability,
      networkWarning,
      transactionState,
      intentGeneration,
      wallets,
      pendingTrustlineIntent,
      requestTrustlineThen,
      signingOwnership: signingState?.activeOperation ?? null,
      signingBlockedByOtherTab: signingState?.isBlockedByOtherTab ?? false,
      signingRecovery: signingState?.uncertainRecovery ?? null,
      acknowledgeSigningRecovery,
      dismissSigningRecovery: acknowledgeSigningRecovery,
      retryAfterSigningRecovery,
    }),
    [
      address,
      isConnecting,
      connect,
      disconnect,
      error,
      signTransaction,
      signAuthEntry,
      signMessage,
      signer,
      walletName,
      capabilities,
      checkTransactionCapability,
      networkWarning,
      transactionState,
      intentGeneration,
      wallets,
      pendingTrustlineIntent,
      requestTrustlineThen,
      signingState,
      acknowledgeSigningRecovery,
      retryAfterSigningRecovery,
    ],
  );

  return (
    <Ctx.Provider value={value}>
      {children}

      <WalletPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        wallets={wallets}
        isPending={isConnecting}
        loading={pickerLoading}
        error={error}
      />
    </Ctx.Provider>
  );
}

export function useWallet(): WalletContextValue {
  return useContext(Ctx);
}

/**
 * Hook returning the active nonsecret wallet session revision.
 * Dependent balance and read hooks can include this in their dependency array
 * to automatically invalidate reads whenever the connected account, network,
 * or connector changes.
 */
export function useWalletSessionRevision(): number {
  return useWallet().sessionRevision;
}

export interface WalletSession {
  revision: number;
  address: string | null;
  walletId: string | null;
  network: string;
}

/**
 * Hook returning a high-level representation of the active wallet session.
 */
export function useWalletSession(): WalletSession {
  const { sessionRevision, address, walletName } = useWallet();
  return useMemo(
    () => ({
      revision: sessionRevision,
      address,
      walletId: walletName,
      network: STELLAR_NETWORK,
    }),
    [sessionRevision, address, walletName],
  );
}
