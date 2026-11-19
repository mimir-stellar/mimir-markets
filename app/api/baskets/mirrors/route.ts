/**
 * GET /api/baskets/mirrors?subscriber=G… — positions a follower has not copied yet.
 *
 * Read-only and unauthenticated: it reports what is already public (open markets
 * and who staked on them) filtered by a subscription the caller names. Nothing
 * here can move funds, and requiring a signature to read your own queue would buy
 * privacy that the chain does not offer anyway.
 */

import { NextResponse, type NextRequest } from "next/server";

import { apiError } from "@/lib/api/errors";
import { clientIpFrom } from "@/lib/api/origin";
import { authorizeRequest } from "@/lib/api/policy";
import { listBasketSubscriptions } from "@/lib/db";
import { pendingMirrorsFor, previewFollowerMirror, previewFollowerMirrors } from "@/lib/server/mirror-queue";
import { parseAddressParam } from "@/lib/server/api-validation";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const rawSubscriber = req.nextUrl.searchParams.get("subscriber") ?? "";
  const rawClaimId = req.nextUrl.searchParams.get("claimId");
  const includePreviews = req.nextUrl.searchParams.get("preview") === "true";

  const ip = clientIpFrom(req.headers);
  const gate = await authorizeRequest("public_read", { route: "/api/baskets/mirrors", ip });
  if (!gate.allowed && gate.error) {
    return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
  }

  // Stellar strkey, checked with StrKey and used verbatim.
  const subscriber = parseAddressParam(rawSubscriber);
  if (!subscriber) {
    const err = apiError("invalid_request", "subscriber must be a Stellar address");
    return NextResponse.json(err.body, { status: err.status });
  }

  if (rawClaimId) {
    const claimId = Number.parseInt(rawClaimId, 10);
    if (!Number.isFinite(claimId)) {
      const err = apiError("invalid_request", "claimId must be a valid integer");
      return NextResponse.json(err.body, { status: err.status });
    }
    const preview = await previewFollowerMirror({ subscriber, claimId }).catch(() => null);
    return NextResponse.json(
      { preview },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const [mirrors, subscriptions] = await Promise.all([
    pendingMirrorsFor(subscriber).catch(() => []),
    listBasketSubscriptions(subscriber).catch(() => []),
  ]);

  if (includePreviews) {
    const previews = await previewFollowerMirrors({ subscriber }).catch(() => []);
    return NextResponse.json(
      { mirrors, following: subscriptions, previews },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    { mirrors, following: subscriptions },
    { headers: { "cache-control": "no-store" } },
  );
}
