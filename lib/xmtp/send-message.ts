export type XmtpTextTransport = {
  sendText: (text: string, isOptimistic: boolean) => Promise<unknown>;
};

export type XmtpTextSendResult =
  | { status: "accepted"; serverMessageId?: string }
  | { status: "failed"; error: unknown };

/** Resolves as accepted only after the transport's send promise acknowledges it. */
export async function sendXmtpTextWithAck(
  transport: XmtpTextTransport,
  text: string,
): Promise<XmtpTextSendResult> {
  try {
    const rawId = await transport.sendText(text, true);
    return {
      status: "accepted",
      serverMessageId: rawId == null ? undefined : String(rawId),
    };
  } catch (error) {
    return { status: "failed", error };
  }
}