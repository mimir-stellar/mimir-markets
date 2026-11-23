import { Buffer } from "node:buffer";
import {
  buildCopyPermissionReviewDigest, worstCaseCopySpend, type CopyPermission,
} from "@/lib/copy-trading";
import { configuredSpender } from "@/lib/agents/spend-permissions";
import { getUsdcSacId } from "@/lib/stellar";
import { clientIpFrom } from "@/lib/api/origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 16_384;

async function readJsonBody<T>(req: Request, maxBytes = MAX_BODY_BYTES): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  try {
    const reader = req.body?.getReader();
    if (!reader) {
      const text = await req.text();
      if (new TextEncoder().encode(text).length > maxBytes) {
        return { ok: false, status: 413, error: "request body too large" };
      }
      return { ok: true, data: JSON.parse(text) };
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        return { ok: false, status: 413, error: "request body too large" };
      }
      chunks.push(value);
    }
    return { ok: true, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON" };
  }
}

function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const body = JSON.stringify(data, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });
}

type JsonPermission = Omit<CopyPermission, "signedPolicyHash" | "spendPermission"> & {
  spendPermission: Omit<CopyPermission["spendPermission"], "allowanceAtomic"> & { allowanceAtomic: string | bigint };
};

/**
 * Expose a deterministic pre-signature review digest for a copy permission.
 *
 * Binds agent, category, expiry, and all spending limits without requiring a
 * signature or writing any state. If any field changes before the owner signs
 * and submits to `POST /api/copy/permissions`, the review digest is invalidated.
 */
export async function POST(req: Request): Promise<Response> {
  const { authorizeRequest } = await import("@/lib/api/policy");
  const ip = clientIpFrom(req.headers);
  const gate = await authorizeRequest("public_read", { route: "/api/copy/permissions/review", ip });
  if (!gate.allowed && gate.error) {
    return Response.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  const parsedBody = await readJsonBody<{ permission?: JsonPermission }>(req);
  if (!parsedBody.ok) {
    return jsonResponse({ error: parsedBody.error }, { status: parsedBody.status });
  }
  const body = parsedBody.data;
  if (!body.permission) {
    return jsonResponse({ error: "permission required" }, { status: 400 });
  }

  let permission: Omit<CopyPermission, "signedPolicyHash">;
  try {
    permission = {
      ...body.permission,
      spendPermission: {
        ...body.permission.spendPermission,
        allowanceAtomic: BigInt(body.permission.spendPermission.allowanceAtomic),
      },
    };
  } catch {
    return jsonResponse({ error: "invalid_spend_permission" }, { status: 400 });
  }

  const expectedToken = getUsdcSacId();
  if (expectedToken && permission.spendPermission.token.trim() !== expectedToken.trim()) {
    return jsonResponse(
      { error: "wrong_token", detail: "permission token must match configured USDC SAC" },
      { status: 400 },
    );
  }
  const expectedSpender = configuredSpender();
  if (expectedSpender && permission.spendPermission.spender.trim() !== expectedSpender.trim()) {
    return jsonResponse(
      { error: "wrong_spender", detail: "permission spender must match configured spender" },
      { status: 400 },
    );
  }

  const built = buildCopyPermissionReviewDigest(permission);
  if (!built.ok) {
    return jsonResponse({ error: built.error }, { status: 400 });
  }

  return jsonResponse({
    review: built.digest,
    worstCase: worstCaseCopySpend({ ...permission, signedPolicyHash: built.digest.policyHash }),
  });
}
