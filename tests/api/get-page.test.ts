import { describe, it, expect, vi, afterEach } from "vitest";
import { D2LApiClient } from "../../src/api/client.js";
import { NetworkError } from "../../src/api/errors.js";
import type { TokenManager } from "../../src/auth/token-manager.js";
import type { TokenData } from "../../src/types/index.js";

/**
 * Brightspace web pages (an LTI quickLink, a tool launch) check the session
 * cookie and ignore a Bearer token, so getPage() sends the stored cookie.
 * A read-only page fetch is never worth an MFA prompt, so it never logs in.
 */

const SESSION_COOKIE = "d2lSessionVal=abc; d2lSecureSessionVal=def";
const EXPIRED_STUB =
  '<html><head><script>window.location.replace("/d2l/login?sessionExpired=1");</script></head></html>';

const browserToken = (overrides: Partial<TokenData> = {}): TokenData => ({
  accessToken: "eyJ.jwt.sig",
  capturedAt: Date.now(),
  expiresAt: Date.now() + 3_600_000,
  source: "browser",
  cookieHeader: SESSION_COOKIE,
  ...overrides,
});

function makeClient(token: TokenData, maxAttempts?: number) {
  const fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  const tokenManager = { getToken: vi.fn(async () => token) } as unknown as TokenManager;
  const onAuthExpired = vi.fn(async () => true);
  const client = new D2LApiClient({
    baseUrl: "https://purdue.brightspace.com",
    tokenManager,
    onAuthExpired,
    retry: maxAttempts !== undefined ? { maxAttempts } : undefined,
  });
  return { client, fetchMock, onAuthExpired };
}

const html = (body: string) => new Response(body, { status: 200, headers: { "content-type": "text/html" } });

describe("D2LApiClient.getPage", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("sends the session cookie and no Bearer token", async () => {
    const { client, fetchMock } = makeClient(browserToken());
    fetchMock.mockResolvedValue(html("<html>launch</html>"));

    const page = await client.getPage("/d2l/common/dialogs/quickLink/quickLink.d2l?rcode=X");

    expect(page).toBe("<html>launch</html>");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://purdue.brightspace.com/d2l/common/dialogs/quickLink/quickLink.d2l?rcode=X");
    expect(init.headers.Cookie).toBe(SESSION_COOKIE);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("returns null without a request when no session cookie is stored", async () => {
    const { client, fetchMock } = makeClient(browserToken({ cookieHeader: undefined }));

    expect(await client.getPage("/d2l/le/lti/101/toolLaunch/77")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on the login redirect instead of opening a browser login", async () => {
    const { client, fetchMock, onAuthExpired } = makeClient(browserToken());
    fetchMock.mockResolvedValue(html(EXPIRED_STUB));

    expect(await client.getPage("/d2l/le/lti/101/toolLaunch/77")).toBeNull();
    expect(onAuthExpired).not.toHaveBeenCalled();
  });

  it.each([
    "@evil.example/d2l/home",
    ".evil.example/d2l/home",
    ":8443/d2l/home",
    "//evil.example/d2l/home",
    "/\\evil.example/d2l/home",
    "https://evil.example/d2l/home",
  ])("refuses %s without reading the cookie or sending a request", async path => {
    const { client, fetchMock } = makeClient(browserToken());

    expect(await client.getPage(path)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes the configured origin", () => {
    const { client } = makeClient(browserToken());
    expect(client.origin).toBe("https://purdue.brightspace.com");
  });
});

describe("D2LApiClient.getPageRaw", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const pdf = () =>
    new Response(Buffer.from("%PDF-1.4 body"), { status: 200, headers: { "content-type": "application/pdf" } });

  it("returns the binary response, sending the session cookie and no Bearer token", async () => {
    const { client, fetchMock } = makeClient(browserToken());
    fetchMock.mockResolvedValue(pdf());

    const response = await client.getPageRaw("/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=coursefile&fileId=Notes%2fa.pdf");

    expect(Buffer.from(await response!.arrayBuffer()).toString()).toBe("%PDF-1.4 body");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://purdue.brightspace.com/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=coursefile&fileId=Notes%2fa.pdf");
    expect(init.headers.Cookie).toBe(SESSION_COOKIE);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("returns null without a request when no session cookie is stored", async () => {
    const { client, fetchMock } = makeClient(browserToken({ cookieHeader: undefined }));

    expect(await client.getPageRaw("/content/enforced/101-X/Notes/a.pdf")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on the login redirect instead of handing back the stub as a file", async () => {
    const { client, fetchMock, onAuthExpired } = makeClient(browserToken());
    fetchMock.mockResolvedValue(html(EXPIRED_STUB));

    expect(await client.getPageRaw("/content/enforced/101-X/Notes/a.pdf")).toBeNull();
    expect(onAuthExpired).not.toHaveBeenCalled();
  });

  it("returns null when a dead cookie is redirected to the sign-in page, instead of handing back that page as a file", async () => {
    const { client, fetchMock, onAuthExpired } = makeClient(browserToken());
    // fetch follows the 302 itself; the final URL is all that shows it happened.
    const loginPage = html("<html><body><form action='/d2l/lp/auth/login/login.d2l'>Sign in</form></body></html>");
    Object.defineProperty(loginPage, "url", { value: "https://purdue.brightspace.com/d2l/login?target=%2fd2l%2fhome" });
    fetchMock.mockResolvedValue(loginPage);

    expect(await client.getPageRaw("/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=coursefile&fileId=Notes%2fa.pdf")).toBeNull();
    expect(onAuthExpired).not.toHaveBeenCalled();
  });

  it("keeps an HTML page whose final URL only resembles the sign-in page", async () => {
    const { client, fetchMock } = makeClient(browserToken());
    const page = html("<html>handout</html>");
    Object.defineProperty(page, "url", { value: "https://purdue.brightspace.com/d2l/loginhelp" });
    fetchMock.mockResolvedValue(page);

    const response = await client.getPageRaw("/content/enforced/101-X/Labs/handout.html");

    expect(await response!.text()).toBe("<html>handout</html>");
  });

  it.each(["@evil.example/a.pdf", "//evil.example/a.pdf", "https://evil.example/a.pdf"])(
    "refuses %s without reading the cookie or sending a request",
    async path => {
      const { client, fetchMock } = makeClient(browserToken());

      expect(await client.getPageRaw(path)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("redirect handling in getPage and getPageRaw", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("follows a same-origin HTTPS redirect in getPage and rejects cross-origin or http downgrades", async () => {
    const sameOrigin = makeClient(browserToken(), 1);
    sameOrigin.fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/content/enforced/101-X/real.html" } }))
      .mockResolvedValueOnce(html("<html>final</html>"));
    expect(await sameOrigin.client.getPage("/content/enforced/101-X/start.html")).toBe("<html>final</html>");
    expect(sameOrigin.fetchMock).toHaveBeenCalledTimes(2);
    expect(sameOrigin.fetchMock.mock.calls[1]?.[0]).toBe("https://purdue.brightspace.com/content/enforced/101-X/real.html");

    const crossOrigin = makeClient(browserToken(), 1);
    crossOrigin.fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://evil.example/page.html" } }));
    await expect(crossOrigin.client.getPage("/content/enforced/101-X/start.html")).rejects.toBeInstanceOf(NetworkError);
    expect(crossOrigin.fetchMock).toHaveBeenCalledTimes(1);

    const downgrade = makeClient(browserToken(), 1);
    downgrade.fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://purdue.brightspace.com/content/enforced/101-X/real.html" } }));
    await expect(downgrade.client.getPage("/content/enforced/101-X/start.html")).rejects.toBeInstanceOf(NetworkError);
    expect(downgrade.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/secret",
    "https://10.0.0.1/internal",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://[::ffff:169.254.169.254]/latest",
  ])("blocks getPageRaw redirect to forbidden internal target %s", async (target) => {
    const { client, fetchMock } = makeClient(browserToken(), 1);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: target } }));
    await expect(client.getPageRaw("/content/enforced/101-X/file.pdf")).rejects.toBeInstanceOf(NetworkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("strips Cookie and Authorization headers when getPageRaw follows a cross-origin HTTPS CDN redirect", async () => {
    const { client, fetchMock } = makeClient(browserToken(), 1);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "https://cdn.brightspace.com/file.pdf" } }))
      .mockResolvedValueOnce(new Response("pdf-bytes", { status: 200 }));

    const res = await client.getPageRaw("/content/enforced/101-X/file.pdf");
    expect(await res!.text()).toBe("pdf-bytes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondInit = fetchMock.mock.calls[1]?.[1] as { headers: Record<string, string>; redirect?: string };
    expect(secondInit.redirect).toBe("manual");
    expect(secondInit.headers["Cookie"]).toBeUndefined();
    expect(secondInit.headers["Authorization"]).toBeUndefined();
  });
});
