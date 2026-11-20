export type MessagesHubTransportState =
  | "not_started"
  | "connecting"
  | "ready"
  | "unavailable";

export type MessagesHubConnectionState = {
  signingSupported: boolean;
  transport: MessagesHubTransportState;
};

type MessagesHubConnectionInput = {
  canSignMessages: boolean;
  status: "idle" | "disabled" | "initializing" | "ready" | "error" | "blocked_by_tab";
  failureKind?: string | null;
};

export function getMessagesHubConnectionState({
  canSignMessages,
  status,
  failureKind,
}: MessagesHubConnectionInput): MessagesHubConnectionState {
  const signingSupported =
    canSignMessages && failureKind !== "unsupported_wallet";

  if (!signingSupported) {
    return { signingSupported, transport: "not_started" };
  }

  if (
    failureKind === "signature_declined" ||
    failureKind === "invalid_identity"
  ) {
    return { signingSupported, transport: "not_started" };
  }

  if (status === "ready") {
    return { signingSupported, transport: "ready" };
  }

  if (status === "idle" || status === "initializing") {
    return { signingSupported, transport: "connecting" };
  }

  return { signingSupported, transport: "unavailable" };
}