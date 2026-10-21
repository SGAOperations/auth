import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import type { PrismaClient } from "@/generated/prisma/client";
import { AUDIT_CATALOG, AUDIT_EVENT_TYPES } from "@/lib/audit";
import { APP_ROUTE_AUDIT, AUTH_ENDPOINT_AUDIT } from "@/lib/audit-routes";
import { buildAuthOptions } from "@/lib/auth/options";
import { buildAuthPlugins } from "@/lib/auth/plugins";

const FIX =
  "add an audit() call and list it in src/lib/audit-routes.ts, or classify it as exempt with a reason";

const APP_DIR = "src/app";
const HOOKS_FILE = "src/lib/auth/audit-hooks.ts";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const MUTATING_METHOD = "(?:POST|PUT|PATCH|DELETE)";
const exportsMutatingMethod = new RegExp(
  [
    `export\\s+(?:async\\s+)?function\\s+${MUTATING_METHOD}\\b`,
    `export\\s+(?:const|let|var)\\s+${MUTATING_METHOD}\\b`,
    `export\\s+(?:const|let|var)\\s*\\{[^}]*\\b${MUTATING_METHOD}\\b[^}]*\\}\\s*=`,
    // Specifier lists, including `{ handler as POST }` and `{ POST } from "…"`.
    `export\\s*\\{[^}]*\\b${MUTATING_METHOD}\\b[^}]*\\}`,
  ].join("|"),
);
// A directive is the first statement, so only comments may precede it.
const serverActionFile =
  /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*["']use server["']/;
// A function-level directive opens a function body.
const inlineServerAction = /\{\s*["']use server["']/;

function isMutating(path: string, source: string): boolean {
  return (
    (path.endsWith("/route.ts") && exportsMutatingMethod.test(source)) ||
    serverActionFile.test(source) ||
    inlineServerAction.test(source)
  );
}

function mutatingAppFiles(): string[] {
  return readdirSync(join(process.cwd(), APP_DIR), { recursive: true })
    .map((entry) => `${APP_DIR}/${String(entry).replaceAll("\\", "/")}`)
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
    .filter((path) => isMutating(path, read(path)))
    .sort();
}

function authEndpoints() {
  const prisma = {} as unknown as PrismaClient;
  const auth = betterAuth({
    ...buildAuthOptions({
      prisma,
      baseURL: "http://localhost:3000",
      secret: "s".repeat(32),
    }),
    plugins: buildAuthPlugins({
      signupAllowlist: {
        domains: new Set(["northeastern.edu"]),
        emails: new Set(),
      },
      prisma,
      issuer: "http://localhost:3000",
    }),
  });
  return Object.values(auth.api).flatMap((endpoint) => {
    const { path, options } = endpoint as {
      path?: string;
      options?: { method?: string | string[] };
    };
    if (!path) return [];
    return [{ path, methods: [options?.method ?? []].flat() }];
  });
}

function missingLiterals(source: string, events: readonly string[]) {
  return events.filter((event) => !source.includes(`"${event}"`));
}

describe("audit coverage: mutation detector", () => {
  it.each([
    ["src/app/a/route.ts", "export async function POST() {}"],
    ["src/app/a/route.ts", "export const DELETE = handler;"],
    ["src/app/a/route.ts", "export { handler as POST };"],
    ["src/app/a/route.ts", 'export { PUT, GET } from "./other";'],
    ["src/app/a/actions.ts", '"use server";\nexport async function f() {}'],
    ["src/app/a/page.tsx", 'async function f() {\n  "use server";\n}'],
  ])("flags %s: %s", (path, source) => {
    expect(isMutating(path, source)).toBe(true);
  });

  it.each([
    ["src/app/a/route.ts", "export async function GET() {}"],
    ["src/app/a/route.ts", "export { handler as GET };"],
    ["src/app/a/page.tsx", "export default function Page() {}"],
  ])("ignores %s: %s", (path, source) => {
    expect(isMutating(path, source)).toBe(false);
  });
});

describe("audit coverage: App Router files", () => {
  const files = mutatingAppFiles();

  it.each(files)("%s is classified", (path) => {
    const entry = APP_ROUTE_AUDIT[path];
    expect(entry, `${path} mutates state: ${FIX}`).toBeDefined();
    expect(entry?.kind, `${path} mutates state but is marked read`).not.toBe(
      "read",
    );
  });

  it("emits every listed event from each audited file", () => {
    for (const [path, entry] of Object.entries(APP_ROUTE_AUDIT)) {
      if (entry.kind !== "audited") continue;
      const source = read(path);
      expect(source, `${path} has no audit() call`).toContain("audit(");
      expect(
        missingLiterals(source, entry.events),
        `${path} does not mention every listed event`,
      ).toEqual([]);
    }
  });

  it("lists only files that exist and mutate", () => {
    expect(Object.keys(APP_ROUTE_AUDIT).sort()).toEqual(files);
  });
});

describe("audit coverage: Better Auth endpoints", () => {
  const endpoints = authEndpoints();

  it("finds the live endpoint table", () => {
    expect(endpoints.length).toBeGreaterThan(10);
  });

  it("classifies every endpoint and lists no phantom one", () => {
    const live = endpoints.map((endpoint) => endpoint.path).sort();
    const unclassified = live.filter((path) => !(path in AUTH_ENDPOINT_AUDIT));
    expect(unclassified, `unclassified endpoints: ${FIX}`).toEqual([]);
    expect(
      Object.keys(AUTH_ENDPOINT_AUDIT).filter((path) => !live.includes(path)),
      "classified paths that are not Better Auth endpoints",
    ).toEqual([]);
  });

  it("only marks GET-only endpoints as read", () => {
    for (const { path, methods } of endpoints) {
      if (AUTH_ENDPOINT_AUDIT[path]?.kind !== "read") continue;
      expect(methods, `${path} accepts a mutating method`).toEqual(["GET"]);
    }
  });

  it("emits every listed event from the Better Auth adapters", () => {
    const source = read(HOOKS_FILE);
    for (const [path, entry] of Object.entries(AUTH_ENDPOINT_AUDIT)) {
      if (entry.kind !== "audited") continue;
      expect(
        missingLiterals(source, entry.events),
        `${path} lists an event ${HOOKS_FILE} never emits`,
      ).toEqual([]);
    }
  });
});

describe("audit coverage: catalog", () => {
  it("has no duplicate type", () => {
    expect(new Set(AUDIT_EVENT_TYPES).size).toBe(AUDIT_EVENT_TYPES.length);
  });

  it("defines a spec for exactly the listed types", () => {
    expect(Object.keys(AUDIT_CATALOG).sort()).toEqual(
      [...AUDIT_EVENT_TYPES].sort(),
    );
  });
});
