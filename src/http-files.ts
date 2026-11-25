/**
 * Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { DownloadError } from "./utils/download-errors.js";
import { secureStreamDownload } from "./utils/download-helpers.js";
import {
  DISK_MAX_FILE_SIZE,
  nameForType,
  validateDownloadPath,
  validateFileType,
} from "./utils/file-validator.js";
import { log } from "./utils/logger.js";

export const FILES_PATH_PREFIX = "/files/";
export const DEFAULT_FILE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_STAGED_BYTES = 500 * 1024 * 1024;
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;

const STAGING_DIR_PREFIX = "brightspace-mcp-files-";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

export interface StagedFileLink {
  downloadUrl: string;
  downloadUrlExpiresAt: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface StagedFileOptions {
  /** Lifetime of each generated download link in ms. Default 30 minutes. */
  fileTtlMs?: number;
  /** Maximum total bytes kept across all staged files. Default 500 MB. */
  maxStagedBytes?: number;
  /** Parent directory where the ephemeral staging folder is created. */
  stagingRootDir?: string;
}

export interface HttpFileStager {
  maxFileSize: number;
  stageBuffer(buffer: Buffer, requestedFilename: string, originalFilename?: string): Promise<StagedFileLink>;
  stageStream(
    body: ReadableStream<Uint8Array>,
    requestedFilename: string,
    originalFilename: string,
    expectedBytes?: number,
  ): Promise<StagedFileLink>;
  stageExistingFile(
    filePath: string,
    requestedFilename: string,
    mimeType: string,
    size: number,
  ): Promise<StagedFileLink>;
}

interface StagedEntry {
  token: string;
  filePath: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

const stagerStorage = new AsyncLocalStorage<HttpFileStager | undefined>();

/** Request-scoped file stager when a tool runs inside an HTTP `/mcp` request. */
export function currentHttpFileStager(): HttpFileStager | undefined {
  return stagerStorage.getStore();
}

/** Bind a file stager for the duration of one HTTP tool call. */
export function runWithHttpFileStager<T>(stager: HttpFileStager, fn: () => T): T {
  return stagerStorage.run(stager, fn);
}

/**
 * Derive the public base URL (`scheme://host`) for generated download links
 * from the incoming HTTP request. When running behind a TLS-terminating
 * reverse proxy (`trustForwardedProto`), honors the first `X-Forwarded-Proto`
 * value (`https` or `http`).
 */
export function resolveRequestBaseUrl(
  req: IncomingMessage,
  fallbackBaseUrl: string,
  trustForwardedProto: boolean,
): string {
  const fallback = new URL(fallbackBaseUrl);
  let scheme = fallback.protocol.replace(/:$/, "");
  if (trustForwardedProto) {
    const forwarded = req.headers["x-forwarded-proto"];
    const rawProto = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const candidate = rawProto?.split(",")[0]?.trim().toLowerCase();
    if (candidate === "https" || candidate === "http") {
      scheme = candidate;
    }
  }
  const rawHost = req.headers.host?.trim();
  const host = rawHost && !/[\s\r\n\0/]/.test(rawHost) ? rawHost : fallback.host;
  return `${scheme}://${host}`;
}

function contentDispositionAttachment(filename: string): string {
  const ascii = filename
    .replace(/[\r\n\0"\\;]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_")
    .trim() || "download";
  const encoded = encodeURIComponent(filename).replace(
    /['()*!]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function cleanupStaleStagingDirs(rootDir: string, maxAgeMs: number): Promise<void> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(STAGING_DIR_PREFIX))
        .map(async (entry) => {
          const full = path.join(rootDir, entry.name);
          try {
            const stat = await fs.stat(full);
            if (now - stat.mtimeMs >= maxAgeMs) {
              await fs.rm(full, { recursive: true, force: true });
            }
          } catch {
            // Best-effort cleanup of orphaned staging dirs.
          }
        }),
    );
  } catch {
    // Ignore unreadable root directories here; mkdtemp will surface real errors.
  }
}

/**
 * Ephemeral staging store that backs short-lived `/files/<token>/<filename>`
 * links with TTL expiration, bounded disk quota eviction, and cleanup on shutdown.
 */
export class StagedFileStore {
  private readonly entries = new Map<string, StagedEntry>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private totalBytes = 0;
  private closed = false;

  private constructor(
    public readonly dir: string,
    private readonly fileTtlMs: number,
    public readonly maxStagedBytes: number,
  ) {
    this.sweepTimer = setInterval(() => {
      void this.purgeExpired();
    }, Math.min(DEFAULT_SWEEP_INTERVAL_MS, Math.max(100, fileTtlMs)));
    this.sweepTimer.unref?.();
  }

  static async create(options: StagedFileOptions = {}): Promise<StagedFileStore> {
    const fileTtlMs = options.fileTtlMs ?? DEFAULT_FILE_TTL_MS;
    const maxStagedBytes = options.maxStagedBytes ?? DEFAULT_MAX_STAGED_BYTES;
    const rootDir = options.stagingRootDir ?? os.tmpdir();
    await fs.mkdir(rootDir, { recursive: true });
    await cleanupStaleStagingDirs(rootDir, Math.max(fileTtlMs * 2, 3_600_000));
    const dir = await fs.mkdtemp(path.join(rootDir, STAGING_DIR_PREFIX));
    await fs.chmod(dir, 0o700).catch(() => {});
    return new StagedFileStore(dir, fileTtlMs, maxStagedBytes);
  }

  createStager(baseUrl: string): HttpFileStager {
    return {
      maxFileSize: Math.min(DISK_MAX_FILE_SIZE, this.maxStagedBytes),
      stageBuffer: (buffer, requestedFilename, originalFilename) =>
        this.stageBuffer(buffer, requestedFilename, originalFilename, baseUrl),
      stageStream: (body, requestedFilename, originalFilename, expectedBytes) =>
        this.stageStream(body, requestedFilename, originalFilename, expectedBytes, baseUrl),
      stageExistingFile: (filePath, requestedFilename, mimeType, size) =>
        this.stageExistingFile(filePath, requestedFilename, mimeType, size, baseUrl),
    };
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    const expired: StagedEntry[] = [];
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(token);
        this.totalBytes = Math.max(0, this.totalBytes - entry.size);
        expired.push(entry);
      }
    }
    await Promise.all(expired.map((entry) => fs.rm(entry.filePath, { force: true }).catch(() => {})));
  }

  private async evictToFit(incomingBytes: number): Promise<void> {
    await this.purgeExpired();
    const removed: StagedEntry[] = [];
    while (this.entries.size > 0 && this.totalBytes + incomingBytes > this.maxStagedBytes) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      const [token, entry] = oldest;
      this.entries.delete(token);
      this.totalBytes = Math.max(0, this.totalBytes - entry.size);
      removed.push(entry);
    }
    await Promise.all(removed.map((entry) => fs.rm(entry.filePath, { force: true }).catch(() => {})));
  }

  private safeName(requestedFilename: string): string {
    try {
      return path.basename(validateDownloadPath(this.dir, requestedFilename));
    } catch {
      return "download";
    }
  }

  private async registerStagedFile(
    stagedPath: string,
    safeFilename: string,
    mimeType: string,
    size: number,
    baseUrl: string,
    token: string,
  ): Promise<StagedFileLink> {
    const now = Date.now();
    const expiresAt = now + this.fileTtlMs;
    this.entries.set(token, {
      token,
      filePath: stagedPath,
      filename: safeFilename,
      mimeType,
      size,
      createdAt: now,
      expiresAt,
    });
    this.totalBytes += size;
    const downloadUrl = `${baseUrl}${FILES_PATH_PREFIX}${token}/${encodeURIComponent(safeFilename)}`;
    return {
      downloadUrl,
      downloadUrlExpiresAt: new Date(expiresAt).toISOString(),
      filename: safeFilename,
      mimeType,
      size,
    };
  }

  async stageBuffer(
    buffer: Buffer,
    requestedFilename: string,
    originalFilename: string | undefined,
    baseUrl: string,
  ): Promise<StagedFileLink> {
    if (this.closed) throw new Error("Staging store is closed");
    const type = await validateFileType(buffer, undefined, requestedFilename, originalFilename);
    const safeFilename = nameForType(this.safeName(requestedFilename), type);
    if (buffer.length > this.maxStagedBytes) {
      throw new DownloadError("tooLarge", "File exceeds maximum staging capacity");
    }
    await this.evictToFit(buffer.length);
    const token = crypto.randomBytes(32).toString("base64url");
    const stagedPath = path.join(this.dir, token);
    await fs.writeFile(stagedPath, buffer, { mode: 0o600 });
    return this.registerStagedFile(stagedPath, safeFilename, type.mime, buffer.length, baseUrl, token);
  }

  async stageStream(
    body: ReadableStream<Uint8Array>,
    requestedFilename: string,
    originalFilename: string,
    expectedBytes: number | undefined,
    baseUrl: string,
  ): Promise<StagedFileLink> {
    if (this.closed) throw new Error("Staging store is closed");
    await this.purgeExpired();
    const maxBytes = Math.min(DISK_MAX_FILE_SIZE, this.maxStagedBytes);
    const subDir = path.join(this.dir, `stream-${crypto.randomUUID()}`);
    await fs.mkdir(subDir, { mode: 0o700 });
    try {
      const result = await secureStreamDownload({
        targetDir: subDir,
        filename: requestedFilename,
        originalFilename,
        body,
        maxBytes,
        expectedBytes,
        skipDestinationCheck: true,
      });
      await this.evictToFit(result.size);
      const token = crypto.randomBytes(32).toString("base64url");
      const stagedPath = path.join(this.dir, token);
      await fs.rename(result.path, stagedPath);
      await fs.chmod(stagedPath, 0o600).catch(() => {});
      return this.registerStagedFile(
        stagedPath,
        path.basename(result.path),
        result.mime,
        result.size,
        baseUrl,
        token,
      );
    } finally {
      await fs.rm(subDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async stageExistingFile(
    filePath: string,
    requestedFilename: string,
    mimeType: string,
    size: number,
    baseUrl: string,
  ): Promise<StagedFileLink> {
    if (this.closed) throw new Error("Staging store is closed");
    if (size > this.maxStagedBytes) {
      throw new DownloadError("tooLarge", "File exceeds maximum staging capacity");
    }
    await this.evictToFit(size);
    const token = crypto.randomBytes(32).toString("base64url");
    const stagedPath = path.join(this.dir, token);
    await fs.copyFile(filePath, stagedPath);
    await fs.chmod(stagedPath, 0o600).catch(() => {});
    return this.registerStagedFile(
      stagedPath,
      this.safeName(requestedFilename),
      mimeType,
      size,
      baseUrl,
      token,
    );
  }

  async serve(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawPath = (req.url ?? "").split("?")[0];
    if (!rawPath.startsWith(FILES_PATH_PREFIX)) return false;

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        Allow: "GET, HEAD",
      });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return true;
    }

    const rest = rawPath.slice(FILES_PATH_PREFIX.length);
    const slash = rest.indexOf("/");
    const token = slash === -1 ? rest : rest.slice(0, slash);
    if (!TOKEN_PATTERN.test(token)) {
      res.writeHead(404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify({ error: "File link expired or not found" }));
      return true;
    }

    await this.purgeExpired();
    const entry = this.entries.get(token);
    if (!entry) {
      res.writeHead(404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify({ error: "File link expired or not found" }));
      return true;
    }

    try {
      const stat = await fs.stat(entry.filePath);
      if (!stat.isFile()) throw new Error("Not a regular file");
    } catch {
      this.entries.delete(token);
      this.totalBytes = Math.max(0, this.totalBytes - entry.size);
      res.writeHead(404, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify({ error: "File link expired or not found" }));
      return true;
    }

    res.writeHead(200, {
      "Content-Type": entry.mimeType,
      "Content-Length": String(entry.size),
      "Content-Disposition": contentDispositionAttachment(entry.filename),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
    });

    if (req.method === "HEAD") {
      res.end();
      return true;
    }

    const stream = createReadStream(entry.filePath);
    try {
      await pipeline(stream, res);
    } catch (error) {
      log("DEBUG", "Failed while streaming staged download response", error);
      res.destroy();
    }
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    this.entries.clear();
    this.totalBytes = 0;
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}
