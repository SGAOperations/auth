import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every mutating route or server action must import and call can() from
// "@/lib/authz" (or requireAdmin from "@/lib/admin-api", which runs can()
// itself), or be listed here with the reason it is exempt.
const EXEMPT: Record<string, string> = {
  "src/app/api/auth/[...all]/route.ts":
    "Better Auth's own handler: sign-in, sign-up and session flows act on the caller's own account, not on another user",
  "src/app/login/actions.ts":
    "Takes no input and acts only on the caller's own session: it reads it and sends the browser to its redirect target",
  "src/app/api/csp-report/route.ts":
    "Unauthenticated browser CSP report sink; it acts on no user and only writes a redacted log line",
  "src/app/api/sgauth/sessions/[id]/route.ts":
    "Revokes one of the caller's own sessions through ownSessions.revoke, whose lookup is filtered to the caller's userId and returns 404 for any other session; it never targets another user",
  "src/app/api/sgauth/sessions/revoke-all/route.ts":
    "Forwards to Better Auth's revoke-sessions, which acts only on the caller's own sessions; it never targets another user",
  "src/app/api/sgauth/reauth/route.ts":
    "Re-authenticates the caller's own session: it checks the caller's own password and stamps their own session row, and it never targets another user",
  "src/app/verify-email/confirm/route.ts":
    "Emailed-link confirm POST: anonymous by design, the signed single-use verify token is the authority, and it acts only on the account that token names",
  "src/app/verify-email/resend/route.ts":
    "Expired-link resend POST: anonymous by design, the signed verify token names the address and the response is the same whether or not an account exists",
  "src/app/unlock/confirm/route.ts":
    "Emailed-link confirm POST: anonymous by design, the single-use unlock token is the authority, and it acts only on the account that token names",
  "src/app/transfer/cancel/confirm/route.ts":
    "Emailed-link confirm POST: anonymous by design, the single-use cancel token is the authority, and it acts only on the one transfer that token names",
  "src/app/set-password/confirm/route.ts":
    "Emailed-link confirm POST: anonymous by design, the single-use set-password token is the authority, and it acts only on the account that token names",
  "src/app/reset-password/confirm/route.ts":
    "Emailed-link confirm POST: anonymous by design, the single-use reset token is the authority, and it acts only on the account that token names",
  "src/app/set-password/request/route.ts":
    "Anonymous request for a set-password link: it answers every address the same, and any link goes only to the mailbox of the account it names",
  "src/app/api/sgauth/sign-in/email-step/route.ts":
    "Anonymous login email step: it answers every address the same, and any set-password link goes only to the mailbox of the account it names",
  "src/app/preview-gate/unlock/route.ts":
    "Preview-environment password gate; it acts on no user and runs before any sign-in",
  "src/app/api/jobs/alerts/route.ts":
    "Scheduled job called by GitHub Actions; jobRoute requires the CRON_SECRET bearer token, and the job acts on system state, not on a caller",
  "src/app/api/jobs/pa-transfer/route.ts":
    "Scheduled job called by GitHub Actions; jobRoute requires the CRON_SECRET bearer token, and the job acts on system state, not on a caller",
  "src/app/api/jobs/retention/route.ts":
    "Scheduled job called by GitHub Actions; jobRoute requires the CRON_SECRET bearer token, and the job acts on system state, not on a caller",
};

// Thin route binders whose logic lives in a handler module. A binder counts as
// guarded when it imports its handlers from its group's `module` and the
// group's handler file passes the group's `guarded` check. The user handlers
// call requireAdmin and can() on the target. The import handlers act on no
// single target: requireAdmin runs can(actor, "accessAdmin"), and the plan runs
// can() per row.
interface BinderGroup {
  module: string;
  handlersFile: string;
  routes: string[];
  guarded(handlersSource: string): boolean;
}
const BINDER_GROUPS: BinderGroup[] = [
  {
    module: "@/lib/admin/users/server",
    handlersFile: "src/lib/admin/users/handlers.ts",
    routes: [
      "src/app/api/sgauth/admin/users/route.ts",
      "src/app/api/sgauth/admin/users/[id]/route.ts",
      "src/app/api/sgauth/admin/users/[id]/[action]/route.ts",
    ],
    guarded: (source) => handlersAreGuarded(source),
  },
  {
    module: "@/lib/user-import/server",
    handlersFile: "src/lib/user-import/handlers.ts",
    routes: [
      "src/app/api/sgauth/admin/users/import/route.ts",
      "src/app/api/sgauth/admin/users/import/preview/route.ts",
    ],
    guarded: (source) =>
      importsAndCalls(source, "requireAdmin", "@/lib/admin-api"),
  },
];
const BINDERS = BINDER_GROUPS.flatMap((group) => group.routes);

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

/**
 * True when the file imports `can` from "@/lib/authz" and calls it, or imports
 * `requireAdmin` from "@/lib/admin-api" and calls it (requireAdmin runs the
 * can() check itself before returning the actor).
 */
export function isGuarded(source: string): boolean {
  return (
    importsAndCalls(source, "can", "@/lib/authz") ||
    importsAndCalls(source, "requireAdmin", "@/lib/admin-api")
  );
}

function importsAndCalls(
  source: string,
  name: string,
  module: string,
): boolean {
  const escapedModule = module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const imported = new RegExp(
    `import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${escapedModule}["']`,
  ).test(source);
  return imported && new RegExp(`\\b${name}\\s*\\(`).test(source);
}

/** True when `handlersSource` itself runs both the admin guard and can(). */
export function handlersAreGuarded(handlersSource: string): boolean {
  return (
    importsAndCalls(handlersSource, "requireAdmin", "@/lib/admin-api") &&
    importsAndCalls(handlersSource, "can", "@/lib/authz")
  );
}

/** True when `source` imports something from the binder `module`. */
export function importsBinderModule(source: string, module: string): boolean {
  const escapedModule = module.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(
    `import\\s*\\{[^}]+\\}\\s*from\\s*["']${escapedModule}["']`,
  ).test(source);
}

describe("handlersAreGuarded", () => {
  it("needs the requireAdmin call and the can() call", () => {
    const both = `import { requireAdmin } from "@/lib/admin-api";\nimport { can } from "@/lib/authz";\nrequireAdmin({});\ncan(a, "x", t);`;
    expect(handlersAreGuarded(both)).toBe(true);
    expect(
      handlersAreGuarded(
        `import { requireAdmin } from "@/lib/admin-api";\nrequireAdmin({});`,
      ),
    ).toBe(false);
    expect(
      handlersAreGuarded(`import { can } from "@/lib/authz";\ncan(a, "x", t);`),
    ).toBe(false);
  });
});

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

  it("accepts requireAdmin imported from admin-api and called", () => {
    const source = `import {\n  requireAdmin,\n  type AdminGuard,\n} from "@/lib/admin-api";\nconst guard = await requireAdmin({ mutation: true });`;
    expect(isGuarded(source)).toBe(true);
  });

  it.each([
    [
      "requireAdmin without a call",
      `import { requireAdmin } from "@/lib/admin-api";`,
    ],
    [
      "requireAdmin called but not imported",
      `const guard = await requireAdmin({ mutation: true });`,
    ],
    [
      "requireAdmin from another module",
      `import { requireAdmin } from "@/lib/auth/server";\nawait requireAdmin({ mutation: true });`,
    ],
    [
      "a type-only requireAdmin neighbour",
      `import { type AdminGuard } from "@/lib/admin-api";\nrequireAdmin({ mutation: true });`,
    ],
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

  const guardedGroups = BINDER_GROUPS.filter((group) =>
    group.guarded(readFileSync(path.join(root, group.handlersFile), "utf8")),
  );

  it("every one imports and calls can(), or is exempt with a reason", () => {
    const unguarded = files.filter((relPath) => {
      const source = readFileSync(path.join(root, relPath), "utf8");
      const delegated = guardedGroups.some(
        (group) =>
          group.routes.includes(relPath) &&
          importsBinderModule(source, group.module),
      );
      return (
        isMutatingEntry(relPath, source) &&
        !isGuarded(source) &&
        !delegated &&
        !(relPath in EXEMPT)
      );
    });
    expect(
      unguarded,
      `These mutating routes or server actions do not import and call can() from "@/lib/authz". Guard them, or add them to EXEMPT with a reason:\n${unguarded.join("\n")}`,
    ).toEqual([]);
  });

  it("finds every binder, and each one is a mutating entry", () => {
    for (const relPath of BINDERS) {
      expect(files, `${relPath} no longer exists`).toContain(relPath);
      const source = readFileSync(path.join(root, relPath), "utf8");
      expect(isMutatingEntry(relPath, source), relPath).toBe(true);
    }
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
