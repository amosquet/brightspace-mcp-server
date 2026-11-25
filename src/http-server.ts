/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, type ServerRuntime } from "./server.js";
import { resolveRequestBaseUrl, runWithHttpFileStager, StagedFileStore } from "./http-files.js";
import { readEnvSecret } from "./utils/config.js";
import { log } from "./utils/logger.js";
import { configureDestinationPolicy, getDestinationPolicy } from "./utils/sensitive-paths.js";

/** The default loopback address the local shared server listens on. */
export const HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 18765;
export const MCP_PATH = "/mcp";
export const HEALTH_PATHS = new Set(["/healthz", "/health"]);
/** A tools/call body is a few hundred bytes; this leaves ample room. */
export const MAX_BODY_BYTES = 1024 * 1024;
/** 32 characters of hex is 128 bits, which no one guesses. */
export const MIN_TOKEN_LENGTH = 32;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

const TOKEN_HINT =
  `Set D2L_HTTP_TOKEN to a random secret of at least ${MIN_TOKEN_LENGTH} characters, for example the output of ` +
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

/**
 * The bearer token every request must carry. Required: this server answers
 * with private grades and rosters, and any local program (or web page that
 * got past the Host and Origin checks) could otherwise read them.
 */
export function resolveHttpToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = readEnvSecret(env.D2L_HTTP_TOKEN, "D2L_HTTP_TOKEN");
  if (!token) throw new Error(`D2L_HTTP_TOKEN is not set. ${TOKEN_HINT}`);
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`D2L_HTTP_TOKEN is too short. ${TOKEN_HINT}`);
  return token;
}

/** `--host H` or `--host=H`, then D2L_HTTP_HOST, then the loopback default (127.0.0.1). */
export function resolveHttpHost(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--host") raw = argv[i + 1] ?? "";
    else if (argv[i].startsWith("--host=")) raw = argv[i].slice("--host=".length);
  }
  raw ??= env.D2L_HTTP_HOST || undefined;
  if (raw === undefined) return HTTP_HOST;
  const trimmed = raw.trim();
  const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (!host || /[\s\r\n\0/[\]]/.test(host)) {
    throw new Error(`Invalid host ${JSON.stringify(raw)}: expected a hostname or IP address.`);
  }
  return host;
}

/** `--port N` or `--port=N`, then D2L_HTTP_PORT, then PORT, then the default. */
export function resolveHttpPort(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): number {
  let raw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") raw = argv[i + 1] ?? "";
    else if (argv[i].startsWith("--port=")) raw = argv[i].slice("--port=".length);
  }
  raw ??= env.D2L_HTTP_PORT || env.PORT || undefined;
  if (raw === undefined) return DEFAULT_HTTP_PORT;
  const port = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port ${JSON.stringify(raw)}: expected a whole number from 1 to 65535.`);
  }
  return port;
}

/** Comma-separated Host header allowlist, or "*" for any host (D2L_HTTP_ALLOWED_HOSTS). */
export function resolveAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] | "*" | undefined {
  const raw = env.D2L_HTTP_ALLOWED_HOSTS?.trim();
  if (!raw) return undefined;
  if (raw === "*") return "*";
  const entries = raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  for (const entry of entries) {
    if (/[\s\r\n\0/]/.test(entry)) {
      throw new Error(`Invalid D2L_HTTP_ALLOWED_HOSTS entry ${JSON.stringify(entry)}: expected a hostname or host:port.`);
    }
  }
  return entries.length > 0 ? entries : undefined;
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

/** Comma-separated Origin header allowlist, or "*" for any origin (D2L_HTTP_ALLOWED_ORIGINS). */
export function resolveAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] | "*" | undefined {
  const raw = env.D2L_HTTP_ALLOWED_ORIGINS?.trim();
  if (!raw) return undefined;
  if (raw === "*") return "*";
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (!isHttpOrigin(entry)) {
      throw new Error(`Invalid D2L_HTTP_ALLOWED_ORIGINS entry ${JSON.stringify(entry)}: expected an http:// or https:// origin.`);
    }
  }
  return entries.length > 0 ? entries : undefined;
}

export interface HttpServerOptions {
  runtime: ServerRuntime;
  token: string;
  /** Interface to listen on; defaults to 127.0.0.1. Use 0.0.0.0 in containers/cloud. */
  host?: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Allowed Host header values, or "*" for any host behind a reverse proxy. Defaults to "*" when bound to a non-loopback host. */
  allowedHosts?: readonly string[] | "*";
  /** Allowed Origin header values, or "*" for any origin. Defaults to "*" when bound to a non-loopback host. */
  allowedOrigins?: readonly string[] | "*";
  /** Told how many requests are in progress whenever that number changes. */
  onActiveChange?: (active: number) => void;
  /** Ephemeral `/files/<token>/<filename>` TTL in ms (default 30 minutes). */
  fileTtlMs?: number;
  /** Maximum total bytes retained in the HTTP file staging directory (default 500 MB). */
  maxStagedBytes?: number;
  /** Parent directory for temporary staged files (defaults to os.tmpdir()). */
  stagingRootDir?: string;
}

export interface RunningHttpServer {
  url: string;
  host: string;
  port: number;
  server: Server;
  /**
   * Stop accepting connections and resolve once every request already in
   * progress has been answered. Calls in progress are never cut off.
   */
  close(): Promise<void>;
}

function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: status === 400 ? -32700 : -32000, message }, id: null }));
}

class BodyTooLarge extends Error {}

/** The request body, refusing anything over MAX_BODY_BYTES as it arrives. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      reject(new BodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off("data", onData);
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.once("error", reject);
  });
}

/**
 * Serve MCP over Streamable HTTP on 127.0.0.1, for every client on this
 * computer at once.
 *
 * Each POST gets its own McpServer and stateless transport, as the SDK
 * requires (a stateless transport refuses a second request), but they all
 * share the one runtime: the saved session, the single sign-in, and the API
 * cache and rate limiter. There are no MCP sessions to track. GET (a
 * standalone notification stream) and DELETE (ending a session) have nothing
 * to do in stateless mode and answer 405, which clients treat as "not
 * offered".
 *
 * Before any MCP handling, a request must name this server in Host (a web
 * page reaching 127.0.0.1 through DNS rebinding carries its own host name),
 * carry no Origin other than this server's own (a page in a browser always
 * sends one), and present the bearer token.
 */
export async function startHttpServer({
  runtime,
  token,
  host,
  port,
  allowedHosts,
  allowedOrigins,
  onActiveChange,
  fileTtlMs,
  maxStagedBytes,
  stagingRootDir,
}: HttpServerOptions): Promise<RunningHttpServer> {
  if (!token || token.length < MIN_TOKEN_LENGTH || /[\r\n\0]/.test(token) || token !== token.trim()) {
    throw new Error(`Invalid D2L_HTTP_TOKEN. ${TOKEN_HINT}`);
  }
  const bindHost = host ?? HTTP_HOST;
  const loopback = isLoopbackHost(bindHost);
  const effectiveAllowedHosts = allowedHosts ?? (loopback ? undefined : "*");
  const effectiveAllowedOrigins = allowedOrigins ?? (loopback ? undefined : "*");

  const previousDestinationPolicy = getDestinationPolicy();
  const previousAllowVisible = runtime.authRunner?.canOpenVisibleBrowser?.();
  if (!loopback) {
    runtime.authRunner?.setAllowVisibleBrowser?.(false);
    configureDestinationPolicy({
      ...previousDestinationPolicy,
      restrictToRoots: true,
      sessionDir: runtime.config.sessionRoot ?? runtime.config.sessionDir,
    });
  }
  const fileStore = await StagedFileStore.create({ fileTtlMs, maxStagedBytes, stagingRootDir });
  const restoreRuntimePolicy = () => {
    configureDestinationPolicy(previousDestinationPolicy);
    if (previousAllowVisible !== undefined) runtime.authRunner?.setAllowVisibleBrowser?.(previousAllowVisible);
  };

  const expectedToken = createHash("sha256").update(token).digest();
  const authorized = (header: string | undefined): boolean => {
    const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header ?? "");
    return match !== null && timingSafeEqual(createHash("sha256").update(match[1]).digest(), expectedToken);
  };
  let allowedHostsExact = new Set<string>();
  let allowedHostNames = new Set<string>();
  let allowedOriginsExact = new Set<string>();
  let fallbackBaseUrl = `http://127.0.0.1:${port}`;
  let closing = false;
  let active = 0;

  const hostAllowed = (header: string | undefined): boolean => {
    if (!header || /[\r\n\0]/.test(header)) return false;
    if (effectiveAllowedHosts === "*") return true;
    const normalized = header.trim().toLowerCase();
    if (allowedHostsExact.has(normalized)) return true;
    const hostOnly = normalized.startsWith("[")
      ? normalized.slice(0, normalized.indexOf("]") + 1)
      : normalized.split(":")[0];
    return allowedHostNames.has(hostOnly);
  };

  const originAllowed = (origin: string | undefined): boolean => {
    if (origin === undefined) return true;
    if (!isHttpOrigin(origin)) return false;
    if (effectiveAllowedOrigins === "*") return true;
    return allowedOriginsExact.has(origin);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const path = (req.url ?? "").split("?")[0];
    if (HEALTH_PATHS.has(path)) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return sendError(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
      }
      res.writeHead(closing ? 503 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify({ status: closing ? "shutting_down" : "ok" }));
      return;
    }

    if (!hostAllowed(req.headers.host)) return sendError(res, 403, "Forbidden: unexpected Host header", { Connection: "close" });
    const origin = req.headers.origin;
    if (!originAllowed(origin)) return sendError(res, 403, "Forbidden: unexpected Origin header", { Connection: "close" });
    if (origin !== undefined) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
      );
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");
    }

    if (await fileStore.serve(req, res)) return;

    if (path !== MCP_PATH) return sendError(res, 404, "Not found");
    if (req.method === "OPTIONS") {
      res.writeHead(204, { Allow: "POST, OPTIONS" });
      res.end();
      return;
    }
    if (!authorized(req.headers.authorization)) {
      return sendError(res, 401, "Unauthorized: missing or wrong bearer token", {
        "WWW-Authenticate": "Bearer",
        Connection: "close",
      });
    }
    if (req.method !== "POST") return sendError(res, 405, "Method not allowed", { Allow: "POST" });
    if (closing) return sendError(res, 503, "The server is shutting down", { Connection: "close" });
    const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") return sendError(res, 415, "Unsupported Media Type: expected application/json");

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        // Discard only briefly so legitimate clients can finish writing their
        // in-flight buffer and read the 413 without EPIPE, then destroy any
        // unbounded stream after 1 second.
        req.removeAllListeners("data");
        req.resume();
        const timer = setTimeout(() => req.destroy(), 1_000);
        timer.unref?.();
        req.once("end", () => clearTimeout(timer));
        res.once("close", () => clearTimeout(timer));
        return sendError(res, 413, `Request body exceeds ${MAX_BODY_BYTES} bytes`);
      }
      return sendError(res, 400, "Parse error: the body is not valid JSON");
    }

    const baseUrl = resolveRequestBaseUrl(req, fallbackBaseUrl, !loopback);
    const server = createMcpServer(runtime);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });
    await server.connect(transport);
    await runWithHttpFileStager(
      fileStore.createStager(baseUrl),
      () => transport.handleRequest(req, res, body),
    );
  };

  const httpServer = createServer((req, res) => {
    active += 1;
    onActiveChange?.(active);
    res.once("close", () => {
      active -= 1;
      onActiveChange?.(active);
      // A keep-alive connection that just finished its last request would
      // otherwise hold a closing server open until it timed out.
      if (closing) setImmediate(() => httpServer.closeIdleConnections());
    });
    handle(req, res).catch((error) => {
      log("ERROR", "Shared HTTP server failed to handle a request", error);
      sendError(res, 500, "Internal server error");
    });
  });
  httpServer.headersTimeout = 15_000;
  httpServer.keepAliveTimeout = 5_000;

  return new Promise((resolve, reject) => {
    httpServer.once("error", (error: NodeJS.ErrnoException) => {
      void fileStore.close();
      restoreRuntimePolicy();
      reject(error.code === "EADDRINUSE"
        ? new Error(
            `Port ${port} on ${bindHost} is already in use. If the Brightspace HTTP server is already running, ` +
            `connect to it instead of starting another; otherwise choose a different port with --port or D2L_HTTP_PORT.`,
          )
        : error);
    });
    httpServer.listen({ host: bindHost, port, exclusive: true }, () => {
      const bound = (httpServer.address() as AddressInfo).port;
      const formattedHost = bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost;
      fallbackBaseUrl = `http://${formattedHost}:${bound}`;
      const hostKey = formattedHost.toLowerCase();
      allowedHostsExact = new Set([`${hostKey}:${bound}`, `127.0.0.1:${bound}`, `localhost:${bound}`]);
      allowedHostNames = new Set<string>();
      if (Array.isArray(effectiveAllowedHosts)) {
        for (const entry of effectiveAllowedHosts) {
          const lower = entry.toLowerCase();
          if ((lower.includes(":") && !lower.startsWith("[")) || (lower.startsWith("[") && lower.includes("]:"))) {
            allowedHostsExact.add(lower);
          } else {
            allowedHostNames.add(lower);
          }
        }
      }
      allowedOriginsExact = new Set([
        `http://${formattedHost}:${bound}`,
        `http://127.0.0.1:${bound}`,
        `http://localhost:${bound}`,
        ...(Array.isArray(effectiveAllowedOrigins) ? effectiveAllowedOrigins : []),
      ]);
      httpServer.on("error", (error) => log("ERROR", "Shared HTTP server error", error));
      resolve({
        url: `http://${formattedHost}:${bound}${MCP_PATH}`,
        host: bindHost,
        port: bound,
        server: httpServer,
        close: () => new Promise<void>((done) => {
          closing = true;
          if (active > 0) log("INFO", `Waiting for ${active} request(s) in progress to finish`);
          httpServer.close(() => {
            void fileStore.close().finally(() => {
              restoreRuntimePolicy();
              done();
            });
          });
          httpServer.closeIdleConnections();
        }),
      });
    });
  });
}
