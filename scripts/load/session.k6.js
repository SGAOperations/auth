/* global __ENV, __VU */
// k6 load script for the SGAuth session endpoint (AUTH-T98).
//
// This file is run by the k6 binary, never by Node. It imports only k6
// modules. See docs/PERFORMANCE.md for setup, the full set of variables and
// how to read the results.
//
//   export LOADTEST_EMAIL=... LOADTEST_PASSWORD=...
//   k6 run --summary-export .temp/k6-session.json scripts/load/session.k6.js

import http from "k6/http";
import exec from "k6/execution";
import { check, fail, sleep } from "k6";

const BASE_URL = (
  __ENV.BASE_URL || "https://auth-dev.northeasternsga.com"
).replace(/\/+$/, "");
const EMAIL = __ENV.LOADTEST_EMAIL;
const PASSWORD = __ENV.LOADTEST_PASSWORD;
const SESSION_COUNT = Number(__ENV.SESSION_COUNT || 5);
const SGAUTH_COOKIE = __ENV.SGAUTH_COOKIE;
const BYPASS = __ENV.VERCEL_PROTECTION_BYPASS;
const LOAD_VUS = Number(__ENV.LOAD_VUS || 100);
const LOAD_DURATION = __ENV.LOAD_DURATION || "2m";
const THINK_TIME_S = Number(__ENV.THINK_TIME_S || 0.5);

const SESSION_PATH = "/api/sgauth/session";

export const options = {
  scenarios: {
    baseline: {
      executor: "constant-vus",
      exec: "baseline",
      vus: 1,
      duration: "20s",
    },
    warmup: {
      executor: "constant-vus",
      vus: 5,
      duration: "30s",
      startTime: "20s",
    },
    load: {
      executor: "constant-vus",
      vus: LOAD_VUS,
      duration: LOAD_DURATION,
      startTime: "50s",
    },
  },
  thresholds: {
    "http_req_duration{scenario:load}": ["p(95)<250"],
    "http_req_failed{scenario:load}": ["rate==0"],
    "checks{scenario:load}": ["rate==1"],
    // Always pass; they make k6 print these trends in the summary.
    "http_req_duration{scenario:baseline}": ["max>=0"],
    "http_req_duration{scenario:warmup}": ["max>=0"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  setupTimeout: "60s",
  teardownTimeout: "60s",
};

function extraHeaders() {
  return BYPASS ? { "x-vercel-protection-bypass": BYPASS } : {};
}

function authHeaders() {
  return {
    "Content-Type": "application/json",
    // Better Auth rejects a POST whose Origin is not in trustedOrigins.
    Origin: BASE_URL,
    ...extraHeaders(),
  };
}

export function setup() {
  if (SGAUTH_COOKIE) {
    return { cookies: [SGAUTH_COOKIE], minted: false };
  }
  if (!EMAIL || !PASSWORD) {
    fail(
      "Set LOADTEST_EMAIL and LOADTEST_PASSWORD, or SGAUTH_COOKIE (see docs/PERFORMANCE.md)",
    );
  }

  const cookies = [];
  for (let i = 0; i < SESSION_COUNT; i++) {
    const res = http.post(
      `${BASE_URL}/api/auth/sign-in/email`,
      JSON.stringify({ email: EMAIL, password: PASSWORD }),
      { headers: authHeaders(), jar: new http.CookieJar() },
    );
    if (res.status !== 200) {
      const hint =
        res.status === 429 ? "; lower SESSION_COUNT or pass SGAUTH_COOKIE" : "";
      fail(
        `Sign-in ${i + 1} of ${SESSION_COUNT} returned ${res.status}${hint}`,
      );
    }
    // Every cookie, not a hard-coded name: the session cookie name differs
    // per environment (AUTH-T26).
    const pairs = Object.keys(res.cookies).map(
      (name) => `${name}=${res.cookies[name][0].value}`,
    );
    cookies.push(pairs.join("; "));
  }
  return { cookies, minted: true };
}

export default function sessionLoad(data) {
  const cookie = data.cookies[(__VU - 1) % data.cookies.length];
  // Cookie as a header, not the VU jar, so a sliding-refresh Set-Cookie
  // cannot swap sessions between iterations.
  const res = http.get(`${BASE_URL}${SESSION_PATH}`, {
    headers: { Cookie: cookie, ...extraHeaders() },
    jar: new http.CookieJar(),
  });
  check(res, {
    "status is 200": (r) => r.status === 200,
    "body has user.id": (r) => {
      try {
        return typeof r.json("user.id") === "string";
      } catch {
        return false;
      }
    },
  });
  if (exec.scenario.name === "load") {
    sleep(THINK_TIME_S);
  }
}

export function baseline() {
  const res = http.get(`${BASE_URL}/api/auth/ok`, {
    headers: extraHeaders(),
    jar: new http.CookieJar(),
  });
  check(res, { "status is 200": (r) => r.status === 200 });
}

export function teardown(data) {
  if (!data.minted) {
    return;
  }
  data.cookies.forEach((cookie, i) => {
    const res = http.post(`${BASE_URL}/api/auth/sign-out`, "{}", {
      headers: { ...authHeaders(), Cookie: cookie },
      jar: new http.CookieJar(),
    });
    if (res.status !== 200) {
      console.warn(`Sign-out ${i + 1} returned ${res.status}`);
    }
  });
}
