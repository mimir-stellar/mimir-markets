/**
 * Wallet-option shaping for the connect modal — ordering, labels and badges.
 *
 * Pure and separate from the React tree so the rules that decide what a user sees
 * first can be tested without a browser or an installed extension.
 *
 * ── What changed versus the EVM version this replaces ────────────────────────
 *
 * The EVM list was an accident of discovery: a generic injected connector, a
 * vendor-specific one and an EIP-6963 announcement could all describe the same
 * extension, so most of the old logic was dedupe and substring guessing at ids
 * that drifted between library versions.
 *
 * Stellar Wallet Kit hands back a fixed, curated roster instead
 * (`refreshSupportedWallets()`), one entry per product, with a stable `productId`
 * and an authoritative `isAvailable` — so there is nothing to dedupe and no
 * guessing. What remains is genuinely a presentation decision:
 *
 *  - a wallet that is not installed still has to be listed, with somewhere to go
 *    (`url`), or someone holding only Lobstr has no way in;
 *  - being inside a wallet's own in-app browser is the strongest possible signal
 *    and outranks everything, including the wallet used last;
 *  - hardware wallets sort last: they are a deliberate choice, never a default.
 */

/** One row as Stellar Wallet Kit's `ISupportedWallet` describes it. */
export interface WalletOptionInput {
  /** The kit's `productId` — stable across versions, e.g. "freighter". */
  id: string;
  name: string;
  /** Brand mark supplied by the kit (data URI or https URL). */
  icon?: string;
  /** Where to get it, for a wallet that is not installed. */
  url?: string;
  /** The kit's `ModuleType`: "HOT_WALLET", "HW_WALLET", "BRIDGE_WALLET", … */
  type?: string;
  /** The kit probed the wallet and it answered. */
  isAvailable?: boolean;
  /** The page is open inside this wallet's own in-app browser. */
  isPlatformWrapper?: boolean;
}

export type WalletKind = "extension" | "hardware" | "bridge";

export interface ShapedWallet extends WalletOptionInput {
  kind: WalletKind;
  /** Installed / reachable right now: connecting will not need an install first. */
  installed: boolean;
  /** Last wallet this browser connected with. */
  recent: boolean;
  /** The page is running inside this wallet. */
  wrapper: boolean;
  /** Monogram shown when the kit ships no icon for a wallet. */
  monogram: string;
}

/**
 * Module ids whose SEP-43 `signAuthEntry` is a stub that rejects.
 *
 * Mimir's writes are invoker-authorised — the connected account is both the
 * transaction source and the required authoriser, so Soroban encodes its auth with
 * source-account credentials and the envelope signature covers it. `signAuthEntry`
 * is therefore not on the staking path. It is still recorded here so the modal can
 * say so up front for the one case that does need it: co-signing an auth entry for
 * an invocation somebody else submits.
 *
 * Verified against the installed @creit.tech/stellar-wallets-kit 2.5.0 module
 * sources, not from memory — each of these throws
 * `<Wallet> does not support the "signAuthEntry" function`.
 */
export const WALLETS_WITHOUT_AUTH_ENTRY_SIGNING: readonly string[] = [
  "xbull",
  "lobstr",
  "albedo",
];

/** Same, for off-chain attestations (basket subscriptions, agent registration). */
export const WALLETS_WITHOUT_MESSAGE_SIGNING: readonly string[] = ["albedo"];

export function supportsAuthEntrySigning(walletId: string | null | undefined): boolean {
  const normalized = walletId?.trim();
  return Boolean(normalized) && !WALLETS_WITHOUT_AUTH_ENTRY_SIGNING.includes(normalized!);
}

export function supportsMessageSigning(walletId: string | null | undefined): boolean {
  const normalized = walletId?.trim();
  return Boolean(normalized) && !WALLETS_WITHOUT_MESSAGE_SIGNING.includes(normalized!);
}

/**
 * Signing methods a transaction or wallet flow may require before prompting
 * the selected connector.
 */
export type WalletSigningMethod =
  | "signTransaction"
  | "signAuthEntry"
  | "signMessage";

/**
 * Explicit capability snapshot for a selected wallet connector.
 */
export interface WalletCapabilityReport {
  /** Selected connector id (e.g. `"freighter"`, `"albedo"`), or null when disconnected. */
  walletId: string | null;
  /** Human-readable connector name, or null when disconnected. */
  walletName: string | null;
  /** Whether a wallet connector is currently selected/connected. */
  connected: boolean;
  /** Per-method support map for the selected connector. */
  methods: Record<WalletSigningMethod, boolean>;
}

/**
 * Safe pre-flight result returned before starting a transaction or signing flow.
 * When `supported` is false, callers can surface `reason` / `code` without
 * invoking the wallet extension or requesting a signature.
 */
export type WalletCapabilityCheckResult =
  | {
      supported: true;
      method: WalletSigningMethod;
      walletId: string;
      walletName: string | null;
      report: WalletCapabilityReport;
    }
  | {
      supported: false;
      code: "wallet-disconnected" | "unsupported-method";
      method: WalletSigningMethod;
      walletId: string | null;
      walletName: string | null;
      reason: string;
      report: WalletCapabilityReport;
    };

/**
 * Check whether the selected connector supports a specific signing method.
 * Every connected Stellar Wallet Kit module supports `signTransaction`;
 * `signAuthEntry` and `signMessage` depend on the connector's SEP-43 coverage.
 */
export function supportsSigningMethod(
  walletId: string | null | undefined,
  method: WalletSigningMethod,
): boolean {
  const normalized = walletId?.trim();
  if (!normalized) return false;
  if (method === "signTransaction") return true;
  if (method === "signAuthEntry") return supportsAuthEntrySigning(normalized);
  return supportsMessageSigning(normalized);
}

/**
 * Build an explicit capability report for the selected wallet connector.
 */
export function getWalletCapabilityReport(
  walletId: string | null | undefined,
  walletName?: string | null,
): WalletCapabilityReport {
  const normalizedId = walletId?.trim() || null;
  const normalizedName = normalizedId ? walletName?.trim() || null : null;

  return {
    walletId: normalizedId,
    walletName: normalizedName,
    connected: Boolean(normalizedId),
    methods: {
      signTransaction: supportsSigningMethod(normalizedId, "signTransaction"),
      signAuthEntry: supportsSigningMethod(normalizedId, "signAuthEntry"),
      signMessage: supportsSigningMethod(normalizedId, "signMessage"),
    },
  };
}

/**
 * Pre-flight capability check for a required signing method before starting a
 * transaction. Returns a safe unsupported-method (or disconnected) result
 * without requesting a signature from the wallet.
 */
export function checkWalletSigningCapability(
  walletId: string | null | undefined,
  method: WalletSigningMethod,
  walletName?: string | null,
): WalletCapabilityCheckResult {
  const report = getWalletCapabilityReport(walletId, walletName);

  if (!report.connected || !report.walletId) {
    return {
      supported: false,
      code: "wallet-disconnected",
      method,
      walletId: null,
      walletName: null,
      reason: "Connect a Stellar wallet first.",
      report,
    };
  }

  if (!report.methods[method]) {
    const label = report.walletName ?? report.walletId;
    return {
      supported: false,
      code: "unsupported-method",
      method,
      walletId: report.walletId,
      walletName: report.walletName,
      reason: `${label} does not support ${method}.`,
      report,
    };
  }

  return {
    supported: true,
    method,
    walletId: report.walletId,
    walletName: report.walletName,
    report,
  };
}

export function kindOf(wallet: WalletOptionInput): WalletKind {
  // Matched on the kit's own ModuleType rather than on the product name: the type
  // is part of the module contract, while names are marketing.
  if (wallet.type === "HW_WALLET") return "hardware";
  if (wallet.type === "BRIDGE_WALLET") return "bridge";
  return "extension";
}

function monogramFor(name: string): string {
  const letter = name.trim().replace(/^the\s+/i, "").charAt(0);
  return (letter || "?").toUpperCase();
}

/**
 * Sort weight.
 *
 * Being inside a wallet's in-app browser beats everything: that user has exactly
 * one wallet available and it is this one. Then the wallet they used last, then
 * whatever is installed, then the rest — hardware last, because reaching for a
 * Ledger is never the impulse answer to "connect".
 */
function rank(wallet: ShapedWallet): number {
  if (wallet.wrapper) return 0;
  if (wallet.recent && wallet.installed) return 1;
  if (wallet.recent) return 2;
  if (wallet.kind === "hardware") return wallet.installed ? 5 : 6;
  if (wallet.installed) return 3;
  return 4;
}

/**
 * Shape the kit's supported-wallet list for display.
 *
 * Stable within a rank band: the kit's own module order is curated, and reordering
 * equally-ranked rows between renders makes the modal feel like it is flickering.
 */
export function shapeWalletOptions(
  wallets: readonly WalletOptionInput[],
  opts: { recentId?: string | null } = {},
): ShapedWallet[] {
  return wallets
    .map((wallet, index) => ({
      shaped: {
        ...wallet,
        kind: kindOf(wallet),
        installed: Boolean(wallet.isAvailable),
        recent: Boolean(opts.recentId) && wallet.id === opts.recentId,
        wrapper: Boolean(wallet.isPlatformWrapper),
        monogram: monogramFor(wallet.name),
      } satisfies ShapedWallet,
      index,
    }))
    .sort((a, b) => rank(a.shaped) - rank(b.shaped) || a.index - b.index)
    .map((entry) => entry.shaped);
}

export function labelFor(wallet: ShapedWallet): string {
  return wallet.name;
}

/**
 * Row subtitle. Says the one thing that changes what the user should do next,
 * and nothing when there is nothing to say.
 */
export function subtitleFor(wallet: ShapedWallet): string | null {
  if (wallet.wrapper) return "You are browsing inside this wallet";
  if (!wallet.installed) {
    return wallet.kind === "hardware" ? "Connect the device to continue" : "Not installed";
  }
  if (wallet.kind === "hardware") return "Hardware wallet";
  return null;
}

/** Badge text, or null. `RECENT` wins over `INSTALLED`: it is the stronger hint. */
export function badgeFor(wallet: ShapedWallet): string | null {
  if (wallet.wrapper) return "IN-APP";
  if (wallet.recent) return "RECENT";
  if (wallet.installed) return "INSTALLED";
  return null;
}

/**
 * Where a "get this wallet" link should point, or null when there is nothing to
 * install. An empty string from the kit is treated as absent rather than rendered
 * as a link to the current page.
 */
export function installUrlFor(wallet: ShapedWallet): string | null {
  if (wallet.installed) return null;
  const url = wallet.url?.trim();
  return url ? url : null;
}
