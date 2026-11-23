/**
 * Public API capability discovery endpoint.
 *
 * GET /api/capabilities[?schemaVersion=mimir.capabilities.v1 | ?version=1]
 *
 * Unauthenticated (`public_read` rate-limit tier), cacheable, deterministic,
 * and strictly guarded against secret/admin/internal leakage.
 */

import { NextResponse } from "next/server";

import {
  CAPABILITIES_CACHE_CONTROL,
  CAPABILITIES_ROUTE,
  assertCapabilityJsonSafe,
  buildCapabilityDocument,
  computeCapabilityEtag,
} from "@/lib/api/capabilities";
import { apiError } from "@/lib/api/errors";
import { clientIpFrom } from "@/lib/api/origin";
import { authorizeRequest } from "@/lib/api/policy";
import {
  SCHEMA_VERSION_HEADER,
  resolveCapabilityVersionQuery,
  resolveRequestVersion,
  schemaVersionHeaders,
} from "@/lib/api/schema";
import { tracedRoute } from "@/lib/ops/trace-http";

export const dynamic = "force-dynamic";

function isEtagMatch(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const tokens = ifNoneMatch.split(",").map((token) => token.trim());
  if (tokens.includes("*")) return true;
  const normalize = (value: string) => value.replace(/^W\//, "");
  const target = normalize(etag);
  return tokens.some((token) => normalize(token) === target);
}

function errorJson(
  result: ReturnType<typeof apiError>,
  statusOverride?: number,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(result.body, {
    status: statusOverride ?? result.status,
    headers: {
      ...result.headers,
      "Cache-Control": "no-store",
      ...schemaVersionHeaders(),
      ...extraHeaders,
    },
  });
}

function methodNotAllowedResponse(): NextResponse {
  return errorJson(
    apiError("invalid_request", "Method not allowed; use GET /api/capabilities"),
    405,
    { Allow: "GET, HEAD" },
  );
}

async function handleGet(
  request: Request = new Request("http://localhost/api/capabilities"),
): Promise<NextResponse> {
  if (request.method && request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowedResponse();
  }

  try {
    const ip = clientIpFrom(request.headers);
    const gate = await authorizeRequest("public_read", {
      route: CAPABILITIES_ROUTE,
      ip,
    });
    if (!gate.allowed && gate.error) {
      return errorJson(gate.error);
    }

    const headerVerdict = resolveRequestVersion(
      request.headers.get(SCHEMA_VERSION_HEADER),
      { mutating: false },
    );
    if (!headerVerdict.ok) {
      const code =
        headerVerdict.reason === "unsupported_version"
          ? "unsupported_version"
          : "invalid_request";
      return errorJson(
        apiError(
          code,
          headerVerdict.detail ?? `Invalid ${SCHEMA_VERSION_HEADER} header`,
          { field: SCHEMA_VERSION_HEADER },
        ),
      );
    }

    const url = new URL(request.url, "http://localhost");
    const versionVerdict = resolveCapabilityVersionQuery(url.searchParams);
    if (!versionVerdict.ok || !versionVerdict.schemaVersion) {
      const code =
        versionVerdict.reason === "unsupported_version"
          ? "unsupported_version"
          : "invalid_request";
      return errorJson(
        apiError(
          code,
          versionVerdict.detail ?? "Invalid capability version parameter",
          { field: versionVerdict.field },
        ),
      );
    }

    const doc = buildCapabilityDocument({
      schemaVersion: versionVerdict.schemaVersion,
    });
    const json = JSON.stringify(doc);
    assertCapabilityJsonSafe(json, process.env);

    const etag = computeCapabilityEtag(json, doc.schemaVersion);
    if (isEtagMatch(request.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          "Cache-Control": CAPABILITIES_CACHE_CONTROL,
          ETag: etag,
          ...schemaVersionHeaders(),
        },
      });
    }

    return new NextResponse(json, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": CAPABILITIES_CACHE_CONTROL,
        ETag: etag,
        ...schemaVersionHeaders(),
      },
    });
  } catch {
    return errorJson(
      apiError("internal_error", "Unable to build capability discovery document"),
    );
  }
}

async function handleHead(
  request: Request = new Request("http://localhost/api/capabilities", { method: "HEAD" }),
): Promise<NextResponse> {
  const response = await handleGet(request);
  return new NextResponse(null, {
    status: response.status,
    headers: response.headers,
  });
}

export const GET = tracedRoute("api.capabilities", handleGet);
export const HEAD = tracedRoute("api.capabilities", handleHead);
export const POST = tracedRoute("api.capabilities", async () => methodNotAllowedResponse());
export const PUT = tracedRoute("api.capabilities", async () => methodNotAllowedResponse());
export const PATCH = tracedRoute("api.capabilities", async () => methodNotAllowedResponse());
export const DELETE = tracedRoute("api.capabilities", async () => methodNotAllowedResponse());
