import assert from "node:assert/strict";
import test from "node:test";

import {
  badgeFor,
  checkWalletSigningCapability,
  getWalletCapabilityReport,
  supportsSigningMethod,
  installUrlFor,
  kindOf,
  shapeWalletOptions,
  subtitleFor,
  supportsAuthEntrySigning,
  supportsMessageSigning,
} from "../../lib/wallet-connectors";

// Shapes as @creit.tech/stellar-wallets-kit 2.5.0 reports them from
// refreshSupportedWallets(), productIds included.
const FREIGHTER = {
  id: "freighter",
  name: "Freighter",
  type: "HOT_WALLET",
  url: "https://freighter.app",
  icon: "data:image/svg+xml,fr",
  isAvailable: true,
};
const XBULL = {
  id: "xbull",
  name: "xBull",
  type: "HOT_WALLET",
  url: "https://xbull.app",
  isAvailable: true,
};
const ALBEDO = {
  id: "albedo",
  name: "Albedo",
  type: "HOT_WALLET",
  url: "https://albedo.link",
  isAvailable: true,
};
const LOBSTR = {
  id: "lobstr",
  name: "Lobstr",
  type: "HOT_WALLET",
  url: "https://lobstr.co",
  isAvailable: false,
};
const HANA = {
  id: "hana",
  name: "Hana",
  type: "HOT_WALLET",
  url: "https://hanawallet.io",
  isAvailable: false,
};
const LEDGER = {
  id: "LEDGER",
  name: "Ledger",
  type: "HW_WALLET",
  url: "https://ledger.com",
  isAvailable: true,
};

test("an installed wallet outranks one that has to be installed first", () => {
  const order = shapeWalletOptions([LOBSTR, HANA, FREIGHTER]).map((w) => w.id);
  assert.equal(order[0], "freighter");
});

test("the wallet used last is promoted above other installed wallets", () => {
  const order = shapeWalletOptions([FREIGHTER, XBULL, ALBEDO], {
    recentId: "albedo",
  }).map((w) => w.id);
  assert.equal(order[0], "albedo");
});

test("an in-app browser outranks even the wallet used last", () => {
  // Inside Lobstr's own browser there is exactly one wallet available, and it is
  // this one — offering Freighter first would be offering something unreachable.
  const inApp = { ...LOBSTR, isAvailable: true, isPlatformWrapper: true };
  const order = shapeWalletOptions([FREIGHTER, inApp], { recentId: "freighter" }).map(
    (w) => w.id,
  );
  assert.equal(order[0], "lobstr");
});

test("hardware wallets sort below every installed hot wallet", () => {
  const order = shapeWalletOptions([LEDGER, FREIGHTER, XBULL]).map((w) => w.id);
  assert.equal(order.at(-1), "LEDGER");
});

test("ordering is stable within a rank band", () => {
  // Equally-ranked rows keep the kit's curated order; reshuffling them between
  // renders makes the modal look like it is flickering.
  const first = shapeWalletOptions([FREIGHTER, XBULL, ALBEDO]).map((w) => w.id);
  const again = shapeWalletOptions([FREIGHTER, XBULL, ALBEDO]).map((w) => w.id);
  assert.deepEqual(first, ["freighter", "xbull", "albedo"]);
  assert.deepEqual(again, first);
});

test("kinds come from the kit's module type, not from the product name", () => {
  assert.equal(kindOf(LEDGER), "hardware");
  assert.equal(kindOf(FREIGHTER), "extension");
  assert.equal(kindOf({ id: "x", name: "Bridge", type: "BRIDGE_WALLET" }), "bridge");
  // An unknown/absent type degrades to the common case rather than throwing.
  assert.equal(kindOf({ id: "x", name: "Mystery" }), "extension");
});

test("a wallet that is not installed offers somewhere to get it", () => {
  const [lobstr] = shapeWalletOptions([LOBSTR]);
  assert.equal(installUrlFor(lobstr), "https://lobstr.co");
  assert.equal(subtitleFor(lobstr), "Not installed");
});

test("an installed wallet offers no install link", () => {
  const [freighter] = shapeWalletOptions([FREIGHTER]);
  assert.equal(installUrlFor(freighter), null);
  // Nothing actionable to say about a plain, ready extension.
  assert.equal(subtitleFor(freighter), null);
});

test("an empty url is treated as absent, not rendered as a link", () => {
  const [row] = shapeWalletOptions([{ ...LOBSTR, url: "   " }]);
  assert.equal(installUrlFor(row), null);
});

test("badges rank RECENT above INSTALLED, and IN-APP above both", () => {
  const [recent] = shapeWalletOptions([FREIGHTER], { recentId: "freighter" });
  assert.equal(badgeFor(recent), "RECENT");
  const [installed] = shapeWalletOptions([FREIGHTER]);
  assert.equal(badgeFor(installed), "INSTALLED");
  const [inApp] = shapeWalletOptions([{ ...FREIGHTER, isPlatformWrapper: true }]);
  assert.equal(badgeFor(inApp), "IN-APP");
  const [absent] = shapeWalletOptions([LOBSTR]);
  assert.equal(badgeFor(absent), null);
});

test("a wallet with no icon still gets a monogram", () => {
  const [xbull] = shapeWalletOptions([XBULL]);
  assert.equal(xbull.icon, undefined);
  assert.equal(xbull.monogram, "X");
});

test("capability gaps match the kit's real module implementations", () => {
  // Verified against the installed module sources: these reject signAuthEntry.
  assert.equal(supportsAuthEntrySigning("freighter"), true);
  assert.equal(supportsAuthEntrySigning("hana"), true);
  assert.equal(supportsAuthEntrySigning("xbull"), false);
  assert.equal(supportsAuthEntrySigning("lobstr"), false);
  assert.equal(supportsAuthEntrySigning("albedo"), false);
  // Albedo's message signing predates SEP-43 and the kit refuses it.
  assert.equal(supportsMessageSigning("albedo"), false);
  assert.equal(supportsMessageSigning("xbull"), true);
  // No wallet connected: nothing is supported.
  assert.equal(supportsAuthEntrySigning(null), false);
  assert.equal(supportsMessageSigning(undefined), false);
});

test("getWalletCapabilityReport returns an explicit per-method capability snapshot", () => {
  assert.deepEqual(getWalletCapabilityReport("freighter", "Freighter"), {
    walletId: "freighter",
    walletName: "Freighter",
    connected: true,
    methods: {
      signTransaction: true,
      signAuthEntry: true,
      signMessage: true,
    },
  });

  assert.deepEqual(getWalletCapabilityReport("xbull", "xBull"), {
    walletId: "xbull",
    walletName: "xBull",
    connected: true,
    methods: {
      signTransaction: true,
      signAuthEntry: false,
      signMessage: true,
    },
  });

  assert.deepEqual(getWalletCapabilityReport("albedo", "Albedo"), {
    walletId: "albedo",
    walletName: "Albedo",
    connected: true,
    methods: {
      signTransaction: true,
      signAuthEntry: false,
      signMessage: false,
    },
  });

  // Disconnected and whitespace-only ids report no capabilities.
  for (const disconnected of [null, undefined, "", "   "]) {
    assert.deepEqual(getWalletCapabilityReport(disconnected, "Ignored"), {
      walletId: null,
      walletName: null,
      connected: false,
      methods: {
        signTransaction: false,
        signAuthEntry: false,
        signMessage: false,
      },
    });
  }
});

test("checkWalletSigningCapability returns a safe unsupported-method result without requesting a signature", async () => {
  let signCalls = 0;
  const fakeSign = async () => {
    signCalls += 1;
    return "signed-payload";
  };

  // Unsupported method: Albedo does not support signMessage.
  const unsupportedMessage = checkWalletSigningCapability("albedo", "signMessage", "Albedo");
  assert.equal(unsupportedMessage.supported, false);
  if (!unsupportedMessage.supported) {
    assert.equal(unsupportedMessage.code, "unsupported-method");
    assert.equal(unsupportedMessage.method, "signMessage");
    assert.equal(unsupportedMessage.walletId, "albedo");
    assert.equal(unsupportedMessage.walletName, "Albedo");
    assert.match(unsupportedMessage.reason, /Albedo does not support signMessage/);
  }
  if (unsupportedMessage.supported) {
    await fakeSign();
  }
  assert.equal(signCalls, 0, "must not request a signature when the method is unsupported");

  // Unsupported method: Lobstr does not support signAuthEntry.
  const unsupportedAuth = checkWalletSigningCapability("lobstr", "signAuthEntry", "Lobstr");
  assert.equal(unsupportedAuth.supported, false);
  if (!unsupportedAuth.supported) {
    assert.equal(unsupportedAuth.code, "unsupported-method");
    assert.equal(unsupportedAuth.method, "signAuthEntry");
    assert.match(unsupportedAuth.reason, /Lobstr does not support signAuthEntry/);
  }

  // Disconnected boundary case: returns wallet-disconnected without requesting a signature.
  const disconnected = checkWalletSigningCapability(null, "signTransaction");
  assert.equal(disconnected.supported, false);
  if (!disconnected.supported) {
    assert.equal(disconnected.code, "wallet-disconnected");
    assert.equal(disconnected.walletId, null);
    assert.match(disconnected.reason, /Connect a Stellar wallet first/);
  }
  if (disconnected.supported) {
    await fakeSign();
  }
  assert.equal(signCalls, 0, "must not request a signature when disconnected");

  // Supported method proceeds normally.
  const supported = checkWalletSigningCapability("freighter", "signTransaction", "Freighter");
  assert.equal(supported.supported, true);
  assert.equal(supportsSigningMethod("freighter", "signTransaction"), true);
  if (supported.supported) {
    await fakeSign();
  }
  assert.equal(signCalls, 1);
});
