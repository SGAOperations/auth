import assert from "node:assert/strict";
import { test } from "node:test";

import { STUB_CONFIG } from "./sso-stub-deploy/api/stub.mjs";
import {
  createStubHandler,
  isValidTossValue,
  readCookies,
} from "./sso-stub-deploy/stub-core.mjs";

const NAME = "__Secure-sgauth-dev.session_token";
const ORIGIN = "https://stub-dev.northeasternsga.com";

function makeFetch(responder) {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return responder(calls.length - 1);
  };
  return { fakeFetch, calls };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function setup({
  responder = () => json({ user: null }),
  bypassSecret = null,
} = {}) {
  const { fakeFetch, calls } = makeFetch(responder);
  const handler = createStubHandler({
    ...STUB_CONFIG,
    bypassSecret,
    fetch: fakeFetch,
  });
  return { handler, calls };
}

function get(route, cookie) {
  return new Request(`${ORIGIN}/api/stub?route=${route}`, {
    headers: cookie ? { cookie } : {},
  });
}

function post(route, { origin = ORIGIN, body = "" } = {}) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}/api/stub?route=${route}`, {
    method: "POST",
    headers,
    body,
  });
}

function tossBody(variant, value) {
  return new URLSearchParams({ variant, value }).toString();
}

test("readCookies returns every copy in order and ignores other names", () => {
  assert.deepEqual(
    readCookies(`a=1; ${NAME}=x=y; ${NAME}X=no; ${NAME}=second`, NAME),
    ["x=y", "second"],
  );
  assert.deepEqual(readCookies(null, NAME), []);
});

test("home without a cookie makes no fetch", async () => {
  const { handler, calls } = setup();
  const response = await handler(get("home"));
  assert.equal(response.status, 200);
  assert.match(
    await response.text(),
    /No <code>__Secure-sgauth-dev\.session_token<\/code> cookie reached stub-dev/,
  );
  assert.equal(calls.length, 0);
});

test("home with one copy forwards only the session cookie", async () => {
  const { handler, calls } = setup({
    responder: () => json({ user: { email: "v@northeastern.edu", id: "u1" } }),
  });
  const response = await handler(get("home", `other=1; ${NAME}=tok`));
  assert.match(
    await response.text(),
    /Signed in as v@northeastern\.edu \(user u1\)/,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://auth-dev.northeasternsga.com/api/auth/get-session",
  );
  assert.deepEqual(calls[0].headers, { cookie: `${NAME}=tok` });
});

test("home sends the bypass header only when configured", async () => {
  const { handler, calls } = setup({ bypassSecret: "s3" });
  await handler(get("home", `${NAME}=tok`));
  assert.equal(calls[0].headers["x-vercel-protection-bypass"], "s3");
});

test("home escapes the email", async () => {
  const { handler } = setup({
    responder: () => json({ user: { email: "<b>x</b>", id: "u" } }),
  });
  const body = await (await handler(get("home", `${NAME}=tok`))).text();
  assert.match(body, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(body, /<b>x/);
});

test("home with two copies checks each, then both together", async () => {
  const { handler, calls } = setup({
    responder: (i) => json({ user: { email: `u${i}@x.edu`, id: `id${i}` } }),
  });
  const body = await (
    await handler(get("home", `${NAME}=a; ${NAME}=b`))
  ).text();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].headers.cookie, `${NAME}=a; ${NAME}=b`);
  assert.match(body, /2 copies/);
  assert.match(body, /Copy 1 \(sent first\): u0@x\.edu/);
  assert.match(body, /Copy 2: u1@x\.edu/);
  assert.match(body, /All copies as the browser sent them: u2@x\.edu/);
});

test("home with seven copies checks five and says so", async () => {
  const { handler, calls } = setup();
  const cookie = Array.from({ length: 7 }, (_, i) => `${NAME}=v${i}`).join(
    "; ",
  );
  const body = await (await handler(get("home", cookie))).text();
  assert.equal(calls.length, 6);
  assert.match(body, /Only the first 5 copies were checked\./);
});

test("home reports unreachable reasons and no session", async () => {
  const cases = [
    [() => Promise.reject(new Error("boom")), /timeout or connection error/],
    [() => new Response("x", { status: 500 }), /HTTP 500/],
    [() => new Response("not json"), /invalid response/],
    [() => json({ user: null }), /returned no session/],
  ];
  for (const [responder, pattern] of cases) {
    const { handler } = setup({ responder });
    const body = await (await handler(get("home", `${NAME}=tok`))).text();
    assert.match(body, pattern);
  }
});

test("toss and untoss POSTs refuse a missing or foreign Origin", async () => {
  const { handler } = setup();
  for (const route of ["toss", "untoss"]) {
    for (const origin of [
      null,
      "https://auth-dev.northeasternsga.com",
      "https://evil.example",
    ]) {
      const response = await handler(
        post(route, { origin, body: tossBody("host-only", "abc") }),
      );
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("set-cookie"), null);
    }
  }
});

test("toss sets the exact cookie for each variant", async () => {
  const { handler } = setup();
  const expected = {
    "parent-root": `${NAME}=abc; Domain=northeasternsga.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
    "parent-path": `${NAME}=abc; Domain=northeasternsga.com; Path=/api/auth; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
    "host-only": `${NAME}=abc; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
    "sibling-host": `${NAME}=abc; Domain=auth-dev.northeasternsga.com; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`,
  };
  for (const [variant, cookie] of Object.entries(expected)) {
    const response = await handler(
      post("toss", { body: tossBody(variant, "abc") }),
    );
    assert.equal(response.status, 303, variant);
    assert.equal(response.headers.get("location"), "/");
    assert.deepEqual(response.headers.getSetCookie(), [cookie], variant);
  }
});

test("toss rejects bad values and unknown variants", async () => {
  const { handler } = setup();
  for (const value of [
    "a;b",
    "a b",
    "a\r\nSet-Cookie: x=y",
    "",
    "a".repeat(1025),
  ]) {
    assert.equal(isValidTossValue(value), false);
    const response = await handler(
      post("toss", { body: tossBody("host-only", value) }),
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  const unknown = await handler(
    post("toss", { body: tossBody("nope", "abc") }),
  );
  assert.equal(unknown.status, 400);
});

test("untoss clears all four variants", async () => {
  const { handler } = setup();
  const response = await handler(post("untoss"));
  assert.equal(response.status, 303);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 4);
  for (const cookie of cookies) assert.match(cookie, /Max-Age=0$/);
});

test("unsupported methods and routes", async () => {
  const { handler } = setup();
  assert.equal((await handler(get("untoss"))).status, 405);
  assert.equal((await handler(get("nope"))).status, 404);
  assert.equal((await handler(new Request(`${ORIGIN}/api/stub`))).status, 404);
});

test("every response carries the hardening headers", async () => {
  const { handler } = setup();
  const responses = [
    await handler(get("home")),
    await handler(get("toss")),
    await handler(get("nope")),
    await handler(post("toss", { origin: "https://evil.example" })),
  ];
  for (const response of responses) {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-robots-tag"), "noindex");
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /default-src 'none'/,
    );
  }
});

test("STUB_CONFIG is frozen and dev-only", () => {
  assert.ok(Object.isFrozen(STUB_CONFIG));
  assert.equal(STUB_CONFIG.cookieName, NAME);
  assert.equal(STUB_CONFIG.sgauthUrl, "https://auth-dev.northeasternsga.com");
  for (const value of Object.values(STUB_CONFIG)) {
    assert.ok(!value.includes("__Secure-sgauth.session_token"));
  }
});
