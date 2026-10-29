import { expect, test } from "@playwright/test";
import {
  A,
  AUTH,
  COOKIE,
  REDIRECT_COOKIE,
  guardEvilHosts,
  signIn,
  signInFast,
} from "./support/auth";
import { REDIRECT_EMAIL, disconnect } from "./support/db";

test.afterAll(async () => {
  await disconnect();
});

function loginWithRedirect(target: string): string {
  return `${AUTH}/login?redirect=${encodeURIComponent(target)}`;
}

test.describe("post-login redirect", () => {
  test("control: a registered product origin is honoured", async ({ page }) => {
    const evilHits = await guardEvilHosts(page);
    await page.goto(loginWithRedirect(`${A}/protected`));
    await signIn(page, REDIRECT_EMAIL);
    await expect(page).toHaveURL(`${A}/protected`);
    expect(evilHits).toEqual([]);
  });

  // Well-formed targets that no product registers. They are sealed into the
  // redirect cookie and refused when it is consumed, so sign-in goes through
  // the real form and must land on /account.
  for (const target of [
    "https://evil.example/",
    "http://a.sga.localhost.evil.example:3001/",
  ]) {
    test(`rejected after sign-in: ${target}`, async ({ page }) => {
      const evilHits = await guardEvilHosts(page);
      await page.goto(loginWithRedirect(target));
      await signIn(page, REDIRECT_EMAIL);
      await expect(page).toHaveURL(`${AUTH}/account`);
      expect(evilHits).toEqual([]);
    });
  }

  // Malformed targets never reach the cookie: the proxy refuses them on
  // /login, so there is nothing to consume and nothing to follow.
  for (const target of [
    "//evil.example/",
    "/\\evil.example",
    "http://a.sga.localhost:3001@evil.example/",
    "javascript:alert(1)",
  ]) {
    test(`rejected on /login: ${target}`, async ({ page, context }) => {
      const evilHits = await guardEvilHosts(page);
      await page.goto(loginWithRedirect(target));
      await expect(page.getByLabel("Email")).toBeVisible();
      expect(new URL(page.url()).origin).toBe(AUTH);
      expect(
        (await context.cookies()).some(
          (cookie) => cookie.name === REDIRECT_COOKIE,
        ),
      ).toBe(false);
      expect(evilHits).toEqual([]);
    });
  }
});

test.describe("logout redirect", () => {
  test("rejected: an unregistered target ends on the login page", async ({
    page,
    context,
  }) => {
    const evilHits = await guardEvilHosts(page);
    await signInFast(page, REDIRECT_EMAIL);
    await page.goto(
      `${AUTH}/logout?redirect=${encodeURIComponent("https://evil.example/")}`,
    );
    await expect(page).toHaveURL(`${AUTH}/login`);
    expect((await context.cookies()).some((c) => c.name === COOKIE)).toBe(
      false,
    );
    expect(evilHits).toEqual([]);
  });

  test("accepted: a registered product origin is followed", async ({
    page,
  }) => {
    await signInFast(page, REDIRECT_EMAIL);
    await page.goto(`${AUTH}/logout?redirect=${encodeURIComponent(`${A}/`)}`);
    await expect(page).toHaveURL(`${A}/`);
  });
});
