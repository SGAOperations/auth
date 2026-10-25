import { TOKEN_LINK_PATHS } from "@/lib/token-links/actions";

// Pure, so the proxy and tests share it.

// Link previewers, mail security scanners and chat unfurlers. Safe Links often
// fetches with an ordinary browser User-Agent, so this list is best effort.
// The guarantee is that a GET never consumes a token; the list only lets a
// known robot skip the page's display work. It is not a security control.
const SCANNER_USER_AGENTS = [
  "BingPreview",
  "MicrosoftPreview",
  "Microsoft Office",
  "ms-office",
  "Microsoft-WebDAV",
  "Barracuda",
  "Proofpoint",
  "Mimecast",
  "Slackbot",
  "Discordbot",
  "facebookexternalhit",
  "Twitterbot",
  "LinkedInBot",
  "WhatsApp",
  "TelegramBot",
  "Googlebot",
  "Google-Read-Aloud",
].map((agent) => agent.toLowerCase());

/** An empty or missing User-Agent counts as a scanner. */
export function isLinkScanner(userAgent: string | null | undefined): boolean {
  const agent = userAgent?.trim().toLowerCase();
  if (!agent) return true;
  return SCANNER_USER_AGENTS.some((known) => agent.includes(known));
}

/** Exact match after a trailing slash, so `<path>/confirm` is not a token link. */
export function isTokenLinkPath(pathname: string): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return TOKEN_LINK_PATHS.has(path);
}

const SCANNER_BODY =
  "<!doctype html><title>SGA Auth</title><p>Open this link in your browser to continue.</p>";

const HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  "Content-Type": "text/html; charset=utf-8",
};

/**
 * HEAD on a token-link path, and GET from a known scanner, get a 200 with no
 * side effects. Returns `null` for everything else.
 */
export function scannerResponse(
  method: string,
  pathname: string,
  userAgent: string | null | undefined,
): Response | null {
  if (!isTokenLinkPath(pathname)) return null;
  const verb = method.toUpperCase();
  if (verb === "HEAD")
    return new Response(null, { status: 200, headers: HEADERS });
  if (verb === "GET" && isLinkScanner(userAgent)) {
    return new Response(SCANNER_BODY, { status: 200, headers: HEADERS });
  }
  return null;
}
