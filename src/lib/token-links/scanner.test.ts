import { describe, expect, it } from "vitest";
import {
  isLinkScanner,
  isTokenLinkPath,
  scannerResponse,
} from "@/lib/token-links/scanner";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("isLinkScanner", () => {
  it.each([
    "Mozilla/5.0 BingPreview/1.0b",
    "MicrosoftPreview/2.0",
    "Microsoft Office Word 2016",
    "ms-office; MSOffice 16",
    "Microsoft-WebDAV-MiniRedir/10.0",
    "Barracuda Sentinel",
    "Proofpoint URL Defense",
    "Mimecast",
    "Slackbot-LinkExpanding 1.0",
    "Discordbot/2.0",
    "facebookexternalhit/1.1",
    "Twitterbot/1.0",
    "LinkedInBot/1.0",
    "WhatsApp/2.23",
    "TelegramBot (like TwitterBot)",
    "Googlebot/2.1",
    "Google-Read-Aloud",
    "bingpreview",
  ])("treats %s as a scanner", (agent) => {
    expect(isLinkScanner(agent)).toBe(true);
  });

  it.each([CHROME, SAFARI])(
    "treats an ordinary browser as a person",
    (agent) => {
      expect(isLinkScanner(agent)).toBe(false);
    },
  );

  it.each([null, undefined, "", "   "])(
    "does not treat a missing User-Agent (%j) as a scanner",
    (agent) => {
      expect(isLinkScanner(agent)).toBe(false);
    },
  );
});

describe("isTokenLinkPath", () => {
  it("matches a token link, with or without a trailing slash", () => {
    expect(isTokenLinkPath("/verify-email")).toBe(true);
    expect(isTokenLinkPath("/verify-email/")).toBe(true);
    expect(isTokenLinkPath("/admin/transfer/accept")).toBe(true);
  });

  it("is an exact match", () => {
    expect(isTokenLinkPath("/verify-email/confirm")).toBe(false);
    expect(isTokenLinkPath("/other")).toBe(false);
    expect(isTokenLinkPath("/")).toBe(false);
  });
});

describe("scannerResponse", () => {
  it("answers HEAD with an empty 200", async () => {
    const response = scannerResponse("HEAD", "/verify-email", CHROME);
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("");
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("answers a scanner GET with the static body", async () => {
    const response = scannerResponse("GET", "/verify-email", "BingPreview");
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(
      "<!doctype html><title>SGA Auth</title><p>Open this link in your browser to continue.</p>",
    );
    expect(response?.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("lets a GET with no User-Agent through to the page", () => {
    expect(scannerResponse("GET", "/verify-email", null)).toBeNull();
    expect(scannerResponse("GET", "/verify-email", "")).toBeNull();
  });

  it("still answers HEAD with no User-Agent", () => {
    expect(scannerResponse("HEAD", "/verify-email", null)?.status).toBe(200);
  });

  it("still matches with a trailing slash", () => {
    expect(scannerResponse("HEAD", "/verify-email/", CHROME)).not.toBeNull();
  });

  it.each([
    ["GET", "/verify-email", CHROME],
    ["GET", "/verify-email/confirm", "BingPreview"],
    ["HEAD", "/verify-email/confirm", CHROME],
    ["GET", "/other", "BingPreview"],
    ["POST", "/verify-email", "BingPreview"],
  ])("lets %s %s through", (method, path, agent) => {
    expect(scannerResponse(method, path, agent)).toBeNull();
  });
});
