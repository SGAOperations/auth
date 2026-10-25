import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every mutating route or server action must import and call can() from
// "@/lib/authz", or be listed here with the reason it is exempt.
const EXEMPT: Record<string, string> = {
  "src/app/api/auth/[...all]/route.ts":
    "Better Auth's own handler: sign-in, sign-up and session flows act on the caller's own account, not on another user",
  "src/app/api/csp-report/route.ts":
    "Unauthenticated browser CSP report sink; it acts on no user and only writes a redacted log line",
  "src/app/api/sgauth/sessions/[id]/route.ts":
    "Revokes one of the caller's own sessions through ownSessions.revoke, whose lookup is filtered to the caller's userId and returns 404 for any other session; it never targets another user",
  "src/app/api/sgauth/sessions/revoke-all/route.ts":
    "Forwards to Better Auth's revoke-sessions, which acts only on the caller's own sessions; it never targets another user",
  "src/app/verify-email/confirm/route.ts":
    "Emailed-link confirm POST: anonymous by design, the signed single-use verify token is the authority, and it acts only on the account that token names",
  "src/app/preview-gate/unlock/route.ts":
    "Preview-environment password gate; it acts on no user and runs before any sign-in",
  "src/app/api/jobs/alerts/route.ts":
    "Scheduled job called by GitHub Actions; jobRoute requires the CRON_SECRET bearer token, and the job acts on system state, not on a caller",
  "src/app/api/jobs/pa-transfer/route.ts":
    "Scheduled job called by GitHub Actions; jobRoute requires the CRON_SECRET bearer token, and the job acts on system state, not on a caller",
  "src/app/api/jobs/retention/route.ts":
    "Scheduled job called by GitHub Actions; jobRoute requires the CRON_SECRET bearer token, and the job acts on system state, not on a caller",
};

const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"];

/** True for a route.ts exporting a mutating handler, or a file-level "use server" module. */
export function isMutatingEntry(relPath: string, source: string): boolean {
  if (/\.(ts|tsx)$/.test(relPath) && startsWithUseServer(source)) {
    return true;
  }
  if (!/(^|\/)route\.ts$/.test(relPath)) {
    return false;
  }
  const methods = MUTATING_METHODS.join("|");
  const declaration = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|const|let|var)\\s+(?:${methods})\\b`,
  );
  if (declaration.test(source)) {
    return true;
  }
  const destructured = /export\s+(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
  for (const match of source.matchAll(destructured)) {
    const names = match[1].split(",").map((part) => part.split(":")[0].trim());
    if (names.some((name) => MUTATING_METHODS.includes(name))) {
      return true;
    }
  }
  const exportList = /export\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(exportList)) {
    const names = match[1].split(",").map((part) => {
      const specifier = part.trim().split(/\s+as\s+/);
      return specifier[specifier.length - 1].trim();
    });
    if (names.some((name) => MUTATING_METHODS.includes(name))) {
      return true;
    }
  }
  return false;
}

function startsWithUseServer(source: string): boolean {
  const withoutComments = source
    .replace(/^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*/, "")
    .trimStart();
  return /^(["'])use server\1/.test(withoutComments);
}

/** True when the file imports `can` from "@/lib/authz" and calls it. */
export function isGuarded(source: string): boolean {
  const imported =
    /import\s*\{[^}]*\bcan\b[^}]*\}\s*from\s*["']@\/lib\/authz["']/.test(
      source,
    );
  return imported && /\bcan\s*\(/.test(source);
}

describe("isMutatingEntry", () => {
  it.each([
    ["a/route.ts", "export async function POST() {}"],
    ["a/route.ts", "export function DELETE() {}"],
    ["a/route.ts", "export const PATCH = handler;"],
    ["a/route.ts", "export const { GET, PUT } = handlers;"],
    ["a/route.ts", "export const {\n  GET,\n  POST: post,\n} = handlers;"],
    ["a/route.ts", "export { handler as POST };"],
    ["a/route.ts", 'export { POST } from "./x";'],
    ["a/route.ts", "export {\n  GET,\n  handler as DELETE,\n};"],
    ["a/actions.ts", '"use server";\nexport async function f() {}'],
    ["a/actions.tsx", "// header\n'use server'\nexport async function f() {}"],
  ])("detects %s: %s", (relPath, source) => {
    expect(isMutatingEntry(relPath, source)).toBe(true);
  });

  it.each([
    ["a/route.ts", "export async function GET() {}"],
    ["a/route.ts", "export const { GET, HEAD } = handlers;"],
    ["a/route.ts", "const POST = 1;"],
    ["a/route.ts", "export { POST as GET };"],
    ["a/route.ts", 'export { GET, HEAD } from "./x";'],
    ["a/page.tsx", "export default function Page() {}"],
    ["a/helpers.ts", 'import "x";\nconst s = "use server";'],
  ])("ignores %s: %s", (relPath, source) => {
    expect(isMutatingEntry(relPath, source)).toBe(false);
  });
});

describe("isGuarded", () => {
  it("accepts an import plus a call", () => {
    const source = `import { can } from "@/lib/authz";\nconst d = can(actor, "grantAdmin", target);`;
    expect(isGuarded(source)).toBe(true);
  });

  it("accepts can among other named imports", () => {
    const source = `import { can, type AuthzSubject } from "@/lib/authz";\ncan(a, "accessAdmin");`;
    expect(isGuarded(source)).toBe(true);
  });

  it.each([
    ["no import", `const d = can(actor, "grantAdmin", target);`],
    ["import without a call", `import { can } from "@/lib/authz";`],
    [
      "a type-only neighbour",
      `import { type AuthzSubject } from "@/lib/authz";\ncan(a, "accessAdmin");`,
    ],
    ["another module", `import { can } from "@/lib/other";\ncan(a, "x");`],
  ])("rejects %s", (_name, source) => {
    expect(isGuarded(source)).toBe(false);
  });
});

describe("mutating routes and server actions", () => {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const appDir = path.join(root, "src/app");

  const files = (
    readdirSync(appDir, { recursive: true, encoding: "utf8" }) as string[]
  )
    .map((entry) => entry.split(path.sep).join("/"))
    .filter((entry) => /\.(ts|tsx)$/.test(entry))
    .filter((entry) => statSync(path.join(appDir, entry)).isFile())
    .map((entry) => `src/app/${entry}`);

  it("every one imports and calls can(), or is exempt with a reason", () => {
    const unguarded = files.filter((relPath) => {
      const source = readFileSync(path.join(root, relPath), "utf8");
      return (
        isMutatingEntry(relPath, source) &&
        !isGuarded(source) &&
        !(relPath in EXEMPT)
      );
    });
    expect(
      unguarded,
      `These mutating routes or server actions do not import and call can() from "@/lib/authz". Guard them, or add them to EXEMPT with a reason:\n${unguarded.join("\n")}`,
    ).toEqual([]);
  });

  it("lists only exempt files that still exist and still mutate", () => {
    for (const relPath of Object.keys(EXEMPT)) {
      expect(files, `${relPath} no longer exists`).toContain(relPath);
      const source = readFileSync(path.join(root, relPath), "utf8");
      expect(
        isMutatingEntry(relPath, source),
        `${relPath} is no longer a mutating entry; remove it from EXEMPT`,
      ).toBe(true);
    }
  });
});
