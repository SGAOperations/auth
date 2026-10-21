// Dev-only spike tool for AUTH-T104 (#115). It plays a product on
// stub-dev.northeasternsga.com: it reads the dev SGAuth session cookie, asks
// SGAuth who it belongs to, and can plant ("toss") a cookie copy so the
// cookie-tossing behaviour of each browser can be observed.
//
// It is deployed only for a spike run and then torn down (see "Cross-subdomain
// cookie spike" in docs/ENVIRONMENTS.md). It is never pointed at production.
//
// Reads no env and logs nothing: no cookie, no value, no response body.

const MAX_COPIES_CHECKED = 5;
const TIMEOUT_MS = 3000;
const TOSS_VALUE_PATTERN = /^[A-Za-z0-9._~%+/=-]{1,1024}$/;

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
};

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

/** Returns every value for `name`, in the order the browser sent them. */
export function readCookies(header, name) {
  const values = [];
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      values.push(part.slice(index + 1).trim());
    }
  }
  return values;
}

/** Variant id to where the tossed cookie is set. */
export function tossVariants(config) {
  return Object.freeze({
    "parent-root": Object.freeze({
      domain: config.parentDomain,
      path: "/",
      label: "Parent domain, Path=/ (replaces the real cookie)",
    }),
    "parent-path": Object.freeze({
      domain: config.parentDomain,
      path: "/api/auth",
      label:
        "Parent domain, Path=/api/auth (sent first to auth endpoints; invisible to this page)",
    }),
    "host-only": Object.freeze({
      domain: null,
      path: "/",
      label: "Host-only on stub-dev",
    }),
    "sibling-host": Object.freeze({
      domain: config.siblingHost,
      path: "/",
      label: `Domain=${config.siblingHost} (browsers should reject)`,
    }),
  });
}

function setCookie(config, variantId, value, maxAge) {
  const { domain, path } = tossVariants(config)[variantId];
  return `${config.cookieName}=${value}; ${domain ? `Domain=${domain}; ` : ""}Path=${path}; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function tossCookie(config, variantId, value) {
  return setCookie(config, variantId, value, 3600);
}

export function clearCookie(config, variantId) {
  return setCookie(config, variantId, "", 0);
}

/** URL-safe characters only, so a value cannot inject a header attribute. */
export function isValidTossValue(value) {
  return typeof value === "string" && TOSS_VALUE_PATTERN.test(value);
}

function htmlPage(body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>SGAuth SSO stub (dev)</title></head>
<body>
<h1>SGAuth SSO stub (dev)</h1>
${body}
</body>
</html>
`;
}

function respond(body, init = {}) {
  const { status = 200, type = "text/html", headers = [] } = init;
  const response = new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, "content-type": `${type}; charset=utf-8` },
  });
  for (const [name, value] of headers) response.headers.append(name, value);
  return response;
}

function text(message, status) {
  return respond(message, { status, type: "text/plain" });
}

function html(body, status = 200) {
  return respond(htmlPage(body), { status });
}

function redirectHome(setCookies) {
  return respond(null, {
    status: 303,
    type: "text/plain",
    headers: [["location", "/"], ...setCookies.map((c) => ["set-cookie", c])],
  });
}

function actions() {
  return `<p><a href="/toss">Toss a cookie</a></p>
<form method="post" action="/untoss"><button type="submit">Clear tossed cookies</button></form>`;
}

export function createStubHandler(config) {
  const variants = tossVariants(config);
  const cookieCode = `<code>${escapeHtml(config.cookieName)}</code>`;
  const sgauthLink = `<a href="${escapeHtml(config.sgauthUrl)}">${escapeHtml(config.sgauthUrl)}</a>`;

  /** Resolves one cookie header at SGAuth: { kind, email?, id?, reason? }. */
  async function resolve(cookieHeader) {
    const headers = { cookie: cookieHeader };
    if (config.bypassSecret) {
      headers["x-vercel-protection-bypass"] = config.bypassSecret;
    }
    let response;
    try {
      response = await config.fetch(
        `${config.sgauthUrl}/api/auth/get-session`,
        {
          headers,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        },
      );
    } catch {
      return { kind: "unreachable", reason: "timeout or connection error" };
    }
    if (!response.ok) {
      return { kind: "unreachable", reason: `HTTP ${response.status}` };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return { kind: "unreachable", reason: "invalid response" };
    }
    const user = body?.user;
    if (!user) return { kind: "none" };
    return { kind: "user", email: user.email, id: user.id };
  }

  function describe(result) {
    if (result.kind === "user") return escapeHtml(result.email);
    if (result.kind === "none") return "no session";
    return `unreachable (${escapeHtml(result.reason)})`;
  }

  async function home(request) {
    const copies = readCookies(
      request.headers.get("cookie"),
      config.cookieName,
    );
    if (copies.length === 0) {
      return html(
        `<p>No ${cookieCode} cookie reached stub-dev. Sign in at ${sgauthLink}, then reload.</p>\n${actions()}`,
      );
    }

    const checked = copies.slice(0, MAX_COPIES_CHECKED);
    const results = [];
    for (const value of checked) {
      results.push(await resolve(`${config.cookieName}=${value}`));
    }

    let body;
    if (copies.length === 1) {
      const [result] = results;
      if (result.kind === "user") {
        body = `<p>Signed in as ${escapeHtml(result.email)} (user ${escapeHtml(result.id)}). Session read from ${sgauthLink}.</p>`;
      } else if (result.kind === "none") {
        body = `<p>Copy 1: a cookie arrived, but SGAuth returned no session (expired or revoked).</p>`;
      } else {
        body = `<p>Could not reach SGAuth at ${sgauthLink} (${escapeHtml(result.reason)}).</p>`;
      }
    } else {
      const joined = await resolve(
        checked.map((value) => `${config.cookieName}=${value}`).join("; "),
      );
      const items = results.map(
        (result, index) =>
          `<li>Copy ${index + 1}${index === 0 ? " (sent first)" : ""}: ${describe(result)}</li>`,
      );
      body = `<p>${copies.length} copies of ${cookieCode} arrived.</p>
<ol>
${items.join("\n")}
</ol>
<p>All copies as the browser sent them: ${describe(joined)}</p>`;
      if (copies.length > MAX_COPIES_CHECKED) {
        body += `\n<p>Only the first ${MAX_COPIES_CHECKED} copies were checked.</p>`;
      }
    }
    return html(`${body}\n${actions()}`);
  }

  function tossForm() {
    const radios = Object.entries(variants)
      .map(
        ([id, variant], index) =>
          `<p><label><input type="radio" name="variant" value="${escapeHtml(id)}"${index === 0 ? " checked" : ""}> ${escapeHtml(variant.label)}</label></p>`,
      )
      .join("\n");
    return html(`<p>Paste a session_token value from another account (DevTools, Application, Cookies) and pick where to set it.</p>
<form method="post" action="/toss">
${radios}
<p><label>Value <input type="text" name="value" required maxlength="1024" size="60" autocomplete="off"></label></p>
<p><button type="submit">Set cookie</button></p>
</form>
<p>Clearing the parent-domain, Path=/ copy also signs this browser out of auth-dev.</p>
<p><a href="/">Back</a></p>`);
  }

  function refusal(message, status) {
    return html(
      `<p>${escapeHtml(message)}</p>\n<p><a href="/toss">Back</a></p>`,
      status,
    );
  }

  async function toss(request) {
    const form = new URLSearchParams(await request.text());
    const variant = form.get("variant");
    const value = form.get("value");
    if (typeof variant !== "string" || !Object.hasOwn(variants, variant)) {
      return refusal("Unknown cookie variant.", 400);
    }
    if (!isValidTossValue(value)) {
      return refusal(
        "The cookie value must be 1 to 1024 URL-safe characters.",
        400,
      );
    }
    return redirectHome([tossCookie(config, variant, value)]);
  }

  function untoss() {
    return redirectHome(
      Object.keys(variants).map((id) => clearCookie(config, id)),
    );
  }

  return async function handle(request) {
    const route = new URL(request.url).searchParams.get("route");
    const handlers = {
      home: { GET: home },
      toss: { GET: tossForm, POST: toss },
      untoss: { POST: untoss },
    };
    const routeHandlers =
      route !== null && Object.hasOwn(handlers, route) ? handlers[route] : null;
    if (!routeHandlers) return text("Not found", 404);
    const method = Object.hasOwn(routeHandlers, request.method)
      ? routeHandlers[request.method]
      : null;
    if (!method) return text("Method not allowed", 405);
    if (
      request.method === "POST" &&
      request.headers.get("origin") !== config.stubOrigin
    ) {
      return text("Cross-origin request refused.", 403);
    }
    return method(request);
  };
}
