import { expect, test } from "@playwright/test";
import {
  A,
  AUTH,
  B,
  COOKIE,
  sessionCookies,
  signIn,
  signInFast,
} from "./support/auth";
import {
  MEMBER_EMAIL,
  PRODUCT_B_POSITION,
  assignPosition,
  disconnect,
  expireSessions,
} from "./support/db";

test.afterAll(async () => {
  await disconnect();
});

function redirectParam(url: string): string | null {
  return new URL(url).searchParams.get("redirect");
}

test("login at SGAuth is seen by both products", async ({ page, context }) => {
  await page.goto(`${AUTH}/login`);
  await signIn(page, MEMBER_EMAIL);
  await expect(page).toHaveURL(`${AUTH}/account`);

  const cookies = (await context.cookies()).filter(
    (cookie) => cookie.name === COOKIE,
  );
  expect(cookies).toHaveLength(1);
  expect(cookies[0]).toMatchObject({
    domain: ".sga.localhost",
    httpOnly: true,
    sameSite: "Lax",
    secure: false,
  });

  await page.goto(`${A}/protected`);
  await expect(
    page.getByText(`Signed in as ${MEMBER_EMAIL} on Product A.`),
  ).toBeVisible();
  await page.goto(`${B}/protected`);
  await expect(
    page.getByText(`Signed in as ${MEMBER_EMAIL} on Product B.`),
  ).toBeVisible();
});

test("a position assigned by an admin opens a gated page on product B", async ({
  page,
}) => {
  await signInFast(page, MEMBER_EMAIL);

  const denied = await page.goto(`${B}/gated`);
  expect(denied?.status()).toBe(403);
  await expect(
    page.getByText(`Missing position ${PRODUCT_B_POSITION}.`),
  ).toBeVisible();

  await assignPosition(MEMBER_EMAIL, PRODUCT_B_POSITION);

  // The stub's session cache lives for 1 s.
  await expect(async () => {
    const response = await page.reload();
    expect(response?.status()).toBe(200);
  }).toPass({ timeout: 10_000 });
  await expect(
    page.getByText(`Access granted: ${PRODUCT_B_POSITION}.`),
  ).toBeVisible();
});

test("logout on product A signs product B out", async ({
  page,
  context,
  request,
}) => {
  await signInFast(page, MEMBER_EMAIL);
  const cookie = (await context.cookies()).find((c) => c.name === COOKIE);
  expect(cookie).toBeDefined();

  await page.goto(`${A}/`);
  await page.getByRole("link", { name: "Sign out" }).click();
  await expect(page).toHaveURL(`${A}/`);
  await expect(page.getByText("Not signed in.")).toBeVisible();
  expect(await sessionCookies(context)).toEqual([]);

  await page.goto(`${B}/protected`);
  expect(new URL(page.url()).origin + new URL(page.url()).pathname).toBe(
    `${AUTH}/login`,
  );
  expect(redirectParam(page.url())).toBe(`${B}/protected`);

  // The old cookie value alone no longer opens a session: the row is gone, not
  // just the browser's copy of the cookie.
  const response = await request.get(`${AUTH}/api/sgauth/session`, {
    headers: { cookie: `${COOKIE}=${cookie?.value ?? ""}` },
  });
  expect(response.status()).toBe(401);
});

test("a missing or expired session redirects to login and returns afterwards", async ({
  page,
}) => {
  // The run's earlier sign-ins have used the sign-in budget by now, so this
  // test's two sign-ins can wait up to a minute for the window to clear.
  test.setTimeout(120_000);

  // No cookie: the proxy redirects, keeping the path and query.
  await page.goto(`${A}/protected?x=1`);
  expect(new URL(page.url()).origin + new URL(page.url()).pathname).toBe(
    `${AUTH}/login`,
  );
  expect(redirectParam(page.url())).toBe(`${A}/protected?x=1`);

  // Expired session: the cookie is still present, so the proxy lets the request
  // through and requireSession() does the redirect.
  await signInFast(page, MEMBER_EMAIL);
  await page.goto(`${B}/protected`);
  await expect(
    page.getByText(`Signed in as ${MEMBER_EMAIL} on Product B.`),
  ).toBeVisible();

  await expireSessions(MEMBER_EMAIL);
  // Past the stub's 1 s session cache.
  await page.waitForTimeout(1_500);

  await page.goto(`${B}/protected`);
  expect(new URL(page.url()).origin + new URL(page.url()).pathname).toBe(
    `${AUTH}/login`,
  );
  expect(redirectParam(page.url())).toBe(`${B}/protected`);

  // Signing in again honours the redirect parameter.
  await signIn(page, MEMBER_EMAIL);
  await expect(page).toHaveURL(`${B}/protected`);
  await expect(
    page.getByText(`Signed in as ${MEMBER_EMAIL} on Product B.`),
  ).toBeVisible();
});
