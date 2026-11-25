import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRuntime } from "../../src/server.js";
import { startHttpServer, type RunningHttpServer } from "../../src/http-server.js";
import type { AppConfig } from "../../src/types/index.js";

const BASE_URL = "https://fake-brightspace.test";
const TOKEN = "t".repeat(48);

const config: AppConfig = {
  baseUrl: BASE_URL,
  sessionDir: "unused-session-dir",
  tokenTtl: 3600,
  headless: true,
  envAccessToken: "fake-upstream-token",
  courseFilter: { activeOnly: true },
};

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function versionsResponse() {
  return new Response(
    JSON.stringify([
      { ProductCode: "lp", LatestVersion: "1.56" },
      { ProductCode: "le", LatestVersion: "1.91" },
    ]),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("HTTP staged temporary download links and auto-purging", { timeout: 30_000 }, () => {
  const realFetch = globalThis.fetch;
  let running: RunningHttpServer | undefined;
  let stagingRoot: string | undefined;
  const clients: Client[] = [];

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
    await running?.close();
    running = undefined;
    if (stagingRoot) {
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      stagingRoot = undefined;
    }
  });

  async function startCloudServer(
    fetchHandler: (url: string) => Response | Promise<Response>,
    serverOptions: { fileTtlMs?: number; maxStagedBytes?: number } = {},
  ) {
    stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "http-files-root-"));
    const runtime = createRuntime(config, "test");
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(`${BASE_URL}/`)) {
        if (url === `${BASE_URL}/d2l/api/versions/`) return versionsResponse();
        return fetchHandler(url);
      }
      return realFetch(input, init);
    }) as typeof fetch);

    running = await startHttpServer({
      runtime,
      token: TOKEN,
      host: "0.0.0.0",
      port: 0,
      stagingRootDir: stagingRoot,
      ...serverOptions,
    });
    const base = `http://127.0.0.1:${running.port}`;
    const client = new Client({ name: "http-files-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    clients.push(client);
    return { base, client, stagingRoot };
  }

  it("stages inline PDFs in cloud HTTP mode with zero D2L_DOWNLOAD_ROOTS config and serves them safely without bearer auth", async () => {
    const pdfBytes = minimalPdf("Assignment 1 instructions");
    await startCloudServer((url) => {
      if (url.endsWith("/content/topics/7/file")) {
        return new Response(pdfBytes, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="Assignment 1.pdf"',
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await clients[0]!.callTool({
      name: "download_file",
      arguments: { courseId: 101, topicId: 7 },
    });
    expect(result.isError).not.toBe(true);
    const texts = (result.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "");
    const meta = JSON.parse(texts[0]!);
    expect(meta.mode).toBe("inline");
    expect(meta.representation).toBe("extracted_text");
    expect(meta.downloadUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/files\/[A-Za-z0-9_-]{32,64}\/Assignment%201\.pdf$/);
    expect(Date.parse(meta.downloadUrlExpiresAt)).toBeGreaterThan(Date.now());
    expect(texts[1]).toContain("Assignment 1 instructions");

    // Browser / curl download without Bearer token returns the original PDF bytes with sandboxed download headers.
    const res = await realFetch(meta.downloadUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain("attachment;");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(pdfBytes);
  });

  it("honors X-Forwarded-Proto and Host headers when constructing public downloadUrl", async () => {
    const pdfBytes = minimalPdf("Forwarded proto PDF");
    await startCloudServer(() =>
      new Response(pdfBytes, {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": 'attachment; filename="hw.pdf"',
        },
      }),
    );

    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "download_file", arguments: { courseId: 101, topicId: 9 } },
    });
    const mcpRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: running!.port,
          method: "POST",
          path: "/mcp",
          headers: {
            Host: "brightspace.fly.dev",
            "X-Forwarded-Proto": "https",
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    expect(mcpRes.status).toBe(200);
    const rawBody = mcpRes.body;
    const jsonLine = rawBody.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim() ?? rawBody;
    const rpc = JSON.parse(jsonLine);
    const meta = JSON.parse(rpc.result.content[0].text);
    expect(meta.downloadUrl).toMatch(/^https:\/\/brightspace\.fly\.dev\/files\/[A-Za-z0-9_-]{32,64}\/hw\.pdf$/);
  });

  it("includes downloadUrl on get_assignment_files and stages large (>10MB) inline downloads without failing", async () => {
    const attachmentPdf = minimalPdf("Rubric specification");
    const largePdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(11 * 1024 * 1024)]);

    const { client } = await startCloudServer((url) => {
      if (url.endsWith("/dropbox/folders/")) {
        return new Response(
          JSON.stringify([
            {
              Id: 5,
              Name: "Homework 1",
              DueDate: null,
              IsHidden: false,
              Attachments: [{ FileId: 11, FileName: "rubric.pdf", Size: attachmentPdf.length }],
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/dropbox/folders/5/attachments/11")) {
        return new Response(attachmentPdf, {
          status: 200,
          headers: { "content-type": "application/pdf" },
        });
      }
      if (url.endsWith("/content/topics/88/file")) {
        return new Response(largePdf, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-length": String(largePdf.length),
            "content-disposition": 'attachment; filename="lecture-big.pdf"',
          },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const assignmentRes = await client.callTool({
      name: "get_assignment_files",
      arguments: { courseId: 101, folderId: 5, fileId: 11 },
    });
    expect(assignmentRes.isError).not.toBe(true);
    const assignmentJson = JSON.parse((assignmentRes.content as Array<{ text: string }>)[0]!.text);
    expect(assignmentJson.file.text).toContain("Rubric specification");
    expect(assignmentJson.file.downloadUrl).toMatch(/\/files\/.*\/rubric\.pdf$/);
    const fetchedAttachment = await realFetch(assignmentJson.file.downloadUrl);
    expect(fetchedAttachment.status).toBe(200);
    expect(Buffer.from(await fetchedAttachment.arrayBuffer())).toEqual(attachmentPdf);

    // Over 10 MB inline cap automatically falls back to staged_download link in HTTP mode.
    const bigRes = await client.callTool({
      name: "download_file",
      arguments: { courseId: 101, topicId: 88 },
    });
    expect(bigRes.isError).not.toBe(true);
    const bigMeta = JSON.parse((bigRes.content as Array<{ text: string }>)[0]!.text);
    expect(bigMeta.representation).toBe("staged_download");
    expect(bigMeta.size).toBe(largePdf.length);
    const fetchedBig = await realFetch(bigMeta.downloadUrl);
    expect(fetchedBig.status).toBe(200);
    expect(Buffer.from(await fetchedBig.arrayBuffer()).length).toBe(largePdf.length);
  });

  it("auto-purges expired links, evicts oldest staged files past quota, and removes staging directory on shutdown", async () => {
    const pdfA = minimalPdf("First file A");
    const pdfB = minimalPdf("Second file B");
    let current = pdfA;
    const { client, stagingRoot: root } = await startCloudServer(
      () =>
        new Response(current, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": 'attachment; filename="doc.pdf"',
          },
        }),
      { fileTtlMs: 250, maxStagedBytes: Math.max(pdfA.length, pdfB.length) + 100 },
    );

    const firstRes = await client.callTool({ name: "download_file", arguments: { courseId: 101, topicId: 1 } });
    const firstUrl = JSON.parse((firstRes.content as Array<{ text: string }>)[0]!.text).downloadUrl as string;

    // Staging the second file exceeds maxStagedBytes, so the first file is evicted immediately.
    current = pdfB;
    const secondRes = await client.callTool({ name: "download_file", arguments: { courseId: 101, topicId: 2 } });
    const secondUrl = JSON.parse((secondRes.content as Array<{ text: string }>)[0]!.text).downloadUrl as string;

    expect((await realFetch(firstUrl)).status).toBe(404);
    expect((await realFetch(secondUrl)).status).toBe(200);

    // Wait past TTL and verify the second file expires and its file is deleted from disk.
    await new Promise((resolve) => setTimeout(resolve, 320));
    expect((await realFetch(secondUrl)).status).toBe(404);

    const dirsBeforeClose = await fs.readdir(root);
    expect(dirsBeforeClose).toHaveLength(1);
    const stagingDir = path.join(root, dirsBeforeClose[0]!);
    expect(await fs.readdir(stagingDir)).toEqual([]);

    // Shutdown deletes the ephemeral staging directory altogether.
    await running!.close();
    running = undefined;
    expect(await fs.readdir(root)).toEqual([]);
  });
});
