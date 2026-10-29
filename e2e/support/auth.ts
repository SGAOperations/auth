import { expect, type BrowserContext, type Page } from "@playwright/test";
import { E2E_PASSWORD } from "./db";

export const AUTH = "http://auth.sga.localhost:3000";
export const A = "http://a.sga.localhost:3001";
export const B = "http://b.sga.localhost:3002";
export const COOKIE = "sgauth-local.session_token";
export const REDIRECT_COOKIE = "sgauth.redirect";

// SGAuth limits sign-ins to 10 a minute per IP (src/lib/rate-limit/policies.ts),
// and one run signs in about a dozen times from 127.0.0.1. Rather than loosen
// the production limits, every sign-in waits until fewer than eight have
// started in the last minute. Playwright runs one worker, so one process-wide
// list is the whole budget.
const SIGN_IN_BUDGET = 8;
const WINDOW_MS = 61_000;
const recentSignIns: number[] = [];

async function awaitSignInBudget(): Promise<void> {
  for (;;) {
    const cutoff = Date.now() - WINDOW_MS;
    while (recentSignIns.length > 0 && recentSignIns[0] <= cutoff) {
      recentSignIns.shift();
    }
    if (recentSignIns.length < SIGN_IN_BUDGET) break;
    await new Promise((resolve) =>
      setTimeout(resolve, recentSignIns[0] + WINDOW_MS - Date.now()),
    );
  }
  recentSignIns.push(Date.now());
}

/**
 * Signs in through the real two-step form on the current page (SGAuth's
 * `/login` labels, kept in one place). The caller opens `/login` first, so it
 * controls the `redirect` param.
 */
export async function signIn(page: Page, email: string): Promise<void> {
  await awaitSignInBudget();
  // The form is client-rendered; a click before hydration would submit natively.
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
}

/**
 * Signs in with the same request the form sends, from inside the browser so
 * Chromium stores the cookie exactly as it does after the form. For tests
 * whose subject is not the login form: the form's email step has its own
 * limit (10 per 10 minutes per IP, and 5 per address), which a whole suite
 * signing in through the form would exhaust.
 */
export async function signInFast(page: Page, email: string): Promise<void> {
  await awaitSignInBudget();
  await page.goto(`${AUTH}/login`);
  const status = await page.evaluate(
    async ({ email, password }) => {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
        credentials: "same-origin",
      });
      return response.status;
    },
    { email, password: E2E_PASSWORD },
  );
  expect(status).toBe(200);
}

/**
 * The session cookies the browser still holds. Specs assert this is empty after
 * a logout, so a failure prints the leftover cookie's domain, path and expiry.
 */
export async function sessionCookies(context: BrowserContext) {
  return (await context.cookies())
    .filter((cookie) => cookie.name === COOKIE)
    .map(({ name, domain, path, expires, value }) => ({
      name,
      domain,
      path,
      expires,
      emptyValue: value === "",
    }));
}

/**
 * Aborts every request to an `evil.example` host and records it. A test
 * asserts the returned list stays empty.
 */
export async function guardEvilHosts(page: Page): Promise<string[]> {
  const hits: string[] = [];
  await page.route(
    (url) => url.hostname.endsWith("evil.example"),
    async (route) => {
      hits.push(route.request().url());
      await route.abort();
    },
  );
  return hits;
}
