import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SAMPLES } from "@/lib/email/samples";
import {
  TEMPLATES,
  TEMPLATE_NAMES,
  prepareTemplate,
} from "@/lib/email/templates";
import { APP_ROUTE_AUDIT } from "@/lib/audit-routes";
import {
  TEMPLATE_LINK_TARGETS,
  TOKEN_ACTIONS,
  resolveLinkTarget,
  tokenLinkUrl,
  type TokenActionName,
} from "@/lib/token-links/actions";

// AC2: every email template's link points at a page implementing the pattern.

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const ACTIONS = Object.keys(TOKEN_ACTIONS) as TokenActionName[];

describe("every template link is registered", () => {
  it.each(TEMPLATE_NAMES)("%s maps exactly its links fields", (name) => {
    expect(Object.keys(TEMPLATE_LINK_TARGETS[name]).sort()).toEqual(
      [...TEMPLATES[name].links].sort(),
    );
  });

  it("passes the path and query check for every sample link", () => {
    for (const sample of SAMPLES) {
      const prepared = prepareTemplate(sample.template, sample.data);
      if (!prepared.ok) throw new Error(`sample ${sample.id} did not parse`);
      for (const { field, url } of prepared.links) {
        const result = resolveLinkTarget(sample.template, field, url);
        // A pending target has no page to check yet.
        expect(
          result.ok || result.reason === "pending",
          `${sample.id}.${field}: ${JSON.stringify(result)}`,
        ).toBe(true);
      }
    }
  });
});

describe("every live action has a page implementing the pattern", () => {
  const live = ACTIONS.filter((a) => TOKEN_ACTIONS[a].status === "live");

  it.each(live)("%s", (action) => {
    const { path } = TOKEN_ACTIONS[action];
    const page = `src/app${path}/page.tsx`;
    const route = `src/app${path}/confirm/route.ts`;

    expect(existsSync(join(process.cwd(), page)), `${page} exists`).toBe(true);
    expect(read(page)).toContain("TokenActionPage");

    expect(existsSync(join(process.cwd(), route)), `${route} exists`).toBe(
      true,
    );
    const source = read(route);
    expect(source).toContain("createTokenActionHandler");
    // A GET export would let a pre-fetch reach the consume step.
    expect(source).not.toMatch(/export\s+(?:async\s+)?function\s+GET\b/);
    expect(source).not.toMatch(/export\s+(?:const|let|var)\s+GET\b/);
    expect(Object.keys(APP_ROUTE_AUDIT)).toContain(route);
  });
});

describe("pending actions cannot be linked", () => {
  const pending = ACTIONS.filter((a) => TOKEN_ACTIONS[a].status === "pending");

  it.each(pending)("tokenLinkUrl throws for %s", (action) => {
    expect(() =>
      tokenLinkUrl("https://auth.northeasternsga.com", action, "t"),
    ).toThrow();
  });
});
