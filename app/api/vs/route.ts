import { NextResponse } from "next/server";

import { createApiError } from "@/lib/server/api-validation";
import { getVsFeedSnapshot } from "@/lib/server/vs-index";
import { VS_CACHE_HEADERS } from "@/lib/server/vs-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { authorizeRequest } = await import("@/lib/api/policy");
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
    const gate = authorizeRequest("public_read", { route: "/api/vs", ip });
    if (!gate.allowed && gate.error) {
      return NextResponse.json(gate.error.body, { status: gate.error.status, headers: gate.error.headers });
    }
    const { searchParams } = new URL(request.url);
    const refreshValue = searchParams.get("refresh");
    if (refreshValue && refreshValue !== "1") {
      return NextResponse.json(
        createApiError("invalid_parameter", "refresh must be 1 when provided"),
        {
          status: 400,
        }
      );
    }

    const shouldRefresh = refreshValue === "1";
    const { items, cache } = await getVsFeedSnapshot({ forceRefresh: shouldRefresh });

    return NextResponse.json(
      {
        items,
        count: items.length,
        cache,
      },
      {
        headers: VS_CACHE_HEADERS,
      }
    );
  } catch {
    return NextResponse.json(
      createApiError("internal_error", "Unable to load VS feed"),
      {
        status: 500,
      }
    );
  }
}
