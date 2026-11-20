/**
 * Fusión de mensajes decodificados del SDK con envíos optimistas (Paso 7).
 * Solo cliente.
 */

import type { DecodedMessage } from "@xmtp/browser-sdk";
import { getDecodedMessageText } from "@/lib/xmtp/chat-thread";

/** Mensaje local hasta que el hilo remoto confirma el `serverMessageId`. */
export type OptimisticPendingMessage = {
  clientTempId: string;
  text: string;
  sentAt: Date;
  /** ID devuelto por `sendText` tras enviar (dedupe con `DecodedMessage.id`). */
  serverMessageId?: string;
  status: "sending" | "accepted";
};

export type ThreadDisplayRow =
  | { kind: "decoded"; message: DecodedMessage }
  | { kind: "pending"; pending: OptimisticPendingMessage };

/** Normaliza IDs del SDK (string / bigint / number) para comparar de forma estable. */
export function normalizeXmtpMessageId(id: unknown): string {
  if (id == null) return "";
  if (typeof id === "bigint") return id.toString();
  return String(id);
}

export type PendingMatchOptions = {
  /** Inbox del viewer; permite fallback cuando el ID no coincide pero el mensaje ya llegó por stream. */
  myInboxId?: string | null;
};

/**
 * True si el mensaje decodificado corresponde al envío optimista (mismo envío real).
 * - Primero: igualdad de ID normalizada (corrige mismatch string/bigint).
 * - Fallback: mensaje propio, mismo texto y ventana temporal corta (el stream puede usar otro id).
 */
export function decodedMessageMatchesPending(
  m: DecodedMessage,
  p: OptimisticPendingMessage,
  opts?: PendingMatchOptions
): boolean {
  if (!p.serverMessageId) return false;

  if (
    normalizeXmtpMessageId(m.id) === normalizeXmtpMessageId(p.serverMessageId)
  ) {
    return true;
  }

  const my = opts?.myInboxId;
  if (my && m.senderInboxId === my) {
    const body = getDecodedMessageText(m).trim();
    if (body === p.text.trim()) {
      const dt = Math.abs(m.sentAt.getTime() - p.sentAt.getTime());
      if (dt < 5 * 60 * 1000) {
        return true;
      }
    }
  }

  return false;
}

export type MergeThreadRowsOptions = PendingMatchOptions;

/**
 * Combina mensajes remotos con pendientes optimistas, ordenados por `sentAt`.
 * Oculta un pendiente si ya existe un `DecodedMessage` que lo representa (id o fallback).
 */
export function mergeThreadDisplayRows(
  decoded: DecodedMessage[],
  pending: OptimisticPendingMessage[],
  matchOpts?: MergeThreadRowsOptions
): ThreadDisplayRow[] {
  const pendingVisible = pending.filter((p) => {
    if (!p.serverMessageId) return true;
    return !decoded.some((m) =>
      decodedMessageMatchesPending(m, p, matchOpts)
    );
  });

  const decodedRows: ThreadDisplayRow[] = decoded.map((m) => ({
    kind: "decoded",
    message: m,
  }));

  const pendingRows: ThreadDisplayRow[] = pendingVisible.map((p) => ({
    kind: "pending",
    pending: p,
  }));

  const merged = [...decodedRows, ...pendingRows];
  merged.sort((a, b) => {
    const ta =
      a.kind === "decoded"
        ? a.message.sentAt.getTime()
        : a.pending.sentAt.getTime();
    const tb =
      b.kind === "decoded"
        ? b.message.sentAt.getTime()
        : b.pending.sentAt.getTime();
    return ta - tb;
  });
  return merged;
}
