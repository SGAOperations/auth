import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import { buildAuthPlugins } from "@/lib/auth/plugins";

const TRIPWIRE =
  "The Better Auth admin plugin is mounted. Add its ban-user, set-role, remove-user, update-user and impersonate-user endpoints to primary-admin-protection.db.test.ts against the Primary Admin before merging.";

// Admin plugin can ban, re-role, remove and impersonate users; untested until mounted.
describe("primary admin: Better Auth admin plugin tripwire", () => {
  const prisma = {} as unknown as PrismaClient;
  const plugins = buildAuthPlugins({
    signupAllowlist: {
      domains: new Set(["northeastern.edu"]),
      emails: new Set(),
    },
    prisma,
    issuer: "http://localhost:3000",
  });
  const auth = betterAuth({
    ...buildAuthOptions({
      prisma,
      baseURL: "http://localhost:3000",
      secret: "s".repeat(32),
    }),
    plugins,
  });
  const paths = Object.values(auth.api).flatMap((endpoint) => {
    const { path } = endpoint as { path?: string };
    return path ? [path] : [];
  });

  it("reads a live endpoint table", () => {
    expect(paths.length).toBeGreaterThan(10);
  });

  it("mounts no admin endpoint", () => {
    expect(
      paths.filter((path) => path.startsWith("/admin/")),
      TRIPWIRE,
    ).toEqual([]);
  });

  it("mounts no admin plugin", () => {
    expect(
      plugins.filter((plugin) => plugin.id === "admin"),
      TRIPWIRE,
    ).toEqual([]);
  });
});
