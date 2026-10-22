import { isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "ip6-localhost" || host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."));
}

/** Accept only a serialized browser origin, never URLs with credentials or paths. */
export function parseBrowserOrigin(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.origin !== "null") return url.origin === value ? url : null;
    // WebViews can use explicitly configured custom schemes (e.g. capacitor).
    return url.host && !url.username && !url.password && !url.pathname && !url.search && !url.hash &&
      `${url.protocol}//${url.host}` === value ? url : null;
  } catch {
    return null;
  }
}

export function isLocalBrowserOrigin(value: string): boolean {
  const url = parseBrowserOrigin(value);
  return url !== null && (url.protocol === "http:" || url.protocol === "https:") &&
    isLoopbackHostname(url.hostname);
}

/** Host is an authority, not a DNS name to resolve or a proxy-provided header. */
function isLocalHostHeader(value: string | undefined): boolean {
  if (!value || /[\s/@\\?#,]/.test(value)) return false;
  const match = /^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::([0-9]+))?$/.exec(value);
  if (!match || !isLoopbackHostname(match[1]!)) return false;
  return match[2] === undefined || (Number(match[2]) > 0 && Number(match[2]) <= 65535);
}

export interface BrowserBoundaryConfig {
  mode: "open" | "token";
  allowedOrigins?: readonly string[];
}

export function isAllowedBrowserOrigin(origin: string, config: BrowserBoundaryConfig): boolean {
  return isLocalBrowserOrigin(origin) || (config.mode === "token" &&
    parseBrowserOrigin(origin) !== null && config.allowedOrigins?.includes(origin) === true);
}

/** Opaque sandbox Pages need static assets, never JSON or a writable endpoint. */
export function isPageResourceRequest(req: FastifyRequest): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const pathname = req.url.split("?", 1)[0]!;
  const dest = req.headers["sec-fetch-dest"];
  const mode = req.headers["sec-fetch-mode"];
  if (pathname === "/v1/plugin-pages/bridge.js") return dest === "script" && (mode === "no-cors" || mode === "cors");
  if (!/^\/v1\/plugins\/(?!\.{1,2}\/)[\w.-]+\/pages\/[\w-]+\/assets\/[^?#]+$/.test(pathname)) return false;
  if (dest === "iframe" || dest === "document") return mode === "navigate";
  if (dest === "script" || dest === "style" || dest === "image" || dest === "font") {
    return mode === "no-cors" || mode === "cors";
  }
  return false;
}

export function isOpaquePageResourceRequest(req: FastifyRequest): boolean {
  return req.headers.origin === "null" && isPageResourceRequest(req);
}

/** Reject before auth, CORS and handlers: withholding ACAO alone does not stop writes. */
export function createBrowserBoundaryHook(config: BrowserBoundaryConfig) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (config.mode === "open" && !isLocalHostHeader(req.headers.host)) {
      reply.code(403).send({ code: "AUTH_HOST_FORBIDDEN", message: "open API requires a loopback Host" });
      return;
    }
    const origin = req.headers.origin;
    if ((origin !== undefined && !isAllowedBrowserOrigin(origin, config) && !isOpaquePageResourceRequest(req)) ||
      (config.mode === "open" && origin === undefined && req.headers["sec-fetch-site"] === "cross-site" && !isPageResourceRequest(req))) {
      reply.code(403).send({ code: "AUTH_ORIGIN_FORBIDDEN", message: "browser origin is not allowed" });
    }
  };
}

/** CORS consumes this OPTIONS request; actual requests still run Bearer authentication. */
export function isCorsPreflight(req: FastifyRequest, config: BrowserBoundaryConfig): boolean {
  const origin = req.headers.origin;
  const method = req.headers["access-control-request-method"];
  return req.method === "OPTIONS" && typeof origin === "string" &&
    isAllowedBrowserOrigin(origin, config) && typeof method === "string" &&
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method);
}
