#!/usr/bin/env node
// Local product stub for the SSO manual test (docs/ENVIRONMENTS.md, "Local
// development"). It plays the part of a product such as VaultZ on
// vaultz.sga.localhost: it reads the SGAuth session cookie from the browser
// request and asks SGAuth who the session belongs to.
//
// It reads SGAUTH_URL and SGAUTH_COOKIE_NAME, the names the SDK will read.
// The SDK will call /api/sgauth/session (AUTH-T28), which does not exist yet,
// so the stub uses Better Auth's own /api/auth/get-session.
//
// Local tooling only, never deployed. It reads `process.env` directly: the
// `src/lib/env.ts` rule in docs/ENGINEERING.md section 2 covers application
// code only. Nothing it receives is logged: not the cookie, not a response.
//
// Usage: node scripts/sso-stub.mjs
import { createServer } from "node:http";
import { checkSgauthUrl } from "./sso-stub-url.mjs";

const SGAUTH_URL = process.env.SGAUTH_URL ?? "http://auth.sga.localhost:3000";
// The session cookie is forwarded to SGAUTH_URL, so refuse to send it in
// cleartext to a remote host.
const urlProblem = checkSgauthUrl(SGAUTH_URL);
if (urlProblem) {
  console.error(`sso-stub: ${urlProblem}`);
  process.exit(1);
}
const COOKIE_NAME =
  process.env.SGAUTH_COOKIE_NAME ?? "sgauth-local.session_token";
const PORT = Number(process.env.PORT ?? 3001);
const TIMEOUT_MS = 3000;

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

/** Returns the named cookie's value, or null when it is absent. */
function readCookie(header, name) {
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return null;
}

function page(statusHtml) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>SGAuth SSO stub</title></head>
<body>
<h1>SGAuth SSO stub</h1>
<p>${statusHtml}</p>
</body>
</html>
`;
}

const sgauthLink = `<a href="${escapeHtml(SGAUTH_URL)}">${escapeHtml(SGAUTH_URL)}</a>`;
const cookieCode = `<code>${escapeHtml(COOKIE_NAME)}</code>`;

async function resolveStatus(cookieValue) {
  if (cookieValue === null) {
    return `Not signed in. No ${cookieCode} cookie reached this host. Sign in at ${sgauthLink}, then reload.`;
  }

  let response;
  try {
    // Forward only the session cookie, never the whole header.
    response = await fetch(`${SGAUTH_URL}/api/auth/get-session`, {
      headers: { cookie: `${COOKIE_NAME}=${cookieValue}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return unreachable("timeout or connection error");
  }
  if (!response.ok) return unreachable(`HTTP ${response.status}`);

  let body;
  try {
    body = await response.json();
  } catch {
    return unreachable("invalid response");
  }

  const user = body?.user;
  if (!user) {
    return `A ${cookieCode} cookie arrived, but SGAuth returned no session (expired or revoked).`;
  }
  return `Signed in as ${escapeHtml(user.email)} (user ${escapeHtml(user.id)}). Session read from ${sgauthLink}.`;
}

function unreachable(reason) {
  return `Could not reach SGAuth at ${sgauthLink} (${escapeHtml(reason)}). Is <code>npm run dev</code> running?`;
}

async function handle(request, response) {
  const { pathname } = new URL(request.url ?? "/", "http://stub.invalid");
  if (request.method !== "GET" || pathname !== "/") {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
    return;
  }
  const status = await resolveStatus(
    readCookie(request.headers.cookie, COOKIE_NAME),
  );
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(page(status));
}

// Loopback only, never all interfaces: two listen calls on one handler.
function listener(request, response) {
  handle(request, response).catch(() => {
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("Internal error");
  });
}

createServer(listener).listen(PORT, "127.0.0.1", () => {
  console.log(
    `SSO stub on port ${PORT}: SGAUTH_URL=${SGAUTH_URL} SGAUTH_COOKIE_NAME=${COOKIE_NAME}`,
  );
});
// Hosts without IPv6 loopback cannot bind ::1; the IPv4 listener still serves.
createServer(listener)
  .on("error", () => {})
  .listen(PORT, "::1");
