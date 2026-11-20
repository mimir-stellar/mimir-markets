import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { getMessagesHubConnectionState } from "../../lib/xmtp/messages-hub-state.ts";
import { sendXmtpTextWithAck } from "../../lib/xmtp/send-message.ts";

test("unsupported signing is distinct from an unavailable XMTP transport", () => {
  assert.deepEqual(
    getMessagesHubConnectionState({
      canSignMessages: false,
      status: "error",
      failureKind: "unsupported_wallet",
    }),
    { signingSupported: false, transport: "not_started" },
  );

  assert.deepEqual(
    getMessagesHubConnectionState({
      canSignMessages: true,
      status: "error",
      failureKind: "network",
    }),
    { signingSupported: true, transport: "unavailable" },
  );

  assert.deepEqual(
    getMessagesHubConnectionState({
      canSignMessages: true,
      status: "error",
      failureKind: "signature_declined",
    }),
    { signingSupported: true, transport: "not_started" },
  );
});

test("the hub labels signing, transport, and privacy boundaries separately", () => {
  const root = process.cwd();
  const hub = readFileSync(join(root, "components/xmtp/MessagesHub.tsx"), "utf8");
  const panel = readFileSync(join(root, "components/xmtp/VsXmtpPanel.tsx"), "utf8");
  const messages = JSON.parse(
    readFileSync(join(root, "messages/en.json"), "utf8"),
  ) as { messagesHub: Record<string, string>; xmtpVs: Record<string, string> };

  assert.match(hub, /getMessagesHubConnectionState/);
  assert.match(hub, /t\("signingUnsupported"\)/);
  assert.match(hub, /t\("transportUnavailable"\)/);
  assert.match(hub, /t\("privacyBoundary"\)/);
  assert.match(panel, /t\("messageAccepted"\)/);
  assert.equal(messages.messagesHub.signingUnsupported.includes("not a messaging transport outage"), true);
  assert.equal(messages.xmtpVs.messageAccepted.includes("Accepted by XMTP"), true);
  assert.equal(messages.messagesHub.privacyBoundary.includes("Mimir servers do not receive or store it"), true);
});

test("a fake transport is not reported accepted before its acknowledgement", async () => {
  let acknowledge!: (messageId: string) => void;
  const transport = {
    sendText: () =>
      new Promise<string>((resolve) => {
        acknowledge = resolve;
      }),
  };

  let settled = false;
  const resultPromise = sendXmtpTextWithAck(transport, "hello").then((result) => {
    settled = true;
    return result;
  });

  await Promise.resolve();
  assert.equal(settled, false);

  acknowledge("message-1");
  assert.deepEqual(await resultPromise, {
    status: "accepted",
    serverMessageId: "message-1",
  });
});

test("a transport rejection never produces an accepted send result", async () => {
  const error = new Error("offline");
  const result = await sendXmtpTextWithAck(
    { sendText: async () => Promise.reject(error) },
    "hello",
  );

  assert.deepEqual(result, { status: "failed", error });
});