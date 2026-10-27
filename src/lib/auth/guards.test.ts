import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth/current-user";

vi.mock("server-only", () => ({}));

const getCurrentUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/current-user", () => ({ getCurrentUser }));

const can = vi.hoisted(() => vi.fn());
vi.mock("@/lib/authz", () => ({ can }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { requireAdmin, requireUser } from "@/lib/auth/guards";

function user(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: "u1",
    email: "a@example.com",
    name: "Ada Lovelace",
    preferredName: null,
    isAdmin: false,
    isPrimaryAdmin: false,
    twoFactorEnabled: true,
    status: "ACTIVE",
    ...overrides,
  };
}

beforeEach(() => {
  getCurrentUser.mockReset();
  can.mockReset();
});

describe("requireUser", () => {
  it("redirects a signed-out visitor to login with the path", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expect(requireUser("/account")).rejects.toThrow(
      "REDIRECT:/login?redirect=%2Faccount",
    );
  });

  it("returns the user without redirecting", async () => {
    const signedIn = user();
    getCurrentUser.mockResolvedValue(signedIn);
    await expect(requireUser("/account")).resolves.toBe(signedIn);
  });
});

describe("requireAdmin", () => {
  it("redirects a signed-out visitor to login", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expect(requireAdmin("/admin")).rejects.toThrow(
      "REDIRECT:/login?redirect=%2Fadmin",
    );
  });

  it("answers 404 for a non-admin", async () => {
    const nonAdmin = user();
    getCurrentUser.mockResolvedValue(nonAdmin);
    can.mockReturnValue({ allowed: false, reason: "NOT_ADMIN" });
    await expect(requireAdmin("/admin")).rejects.toThrow("NOT_FOUND");
    expect(can).toHaveBeenCalledWith(nonAdmin, "accessAdmin");
  });

  it("answers 404 when can() denies a deactivated admin", async () => {
    getCurrentUser.mockResolvedValue(user({ isAdmin: true }));
    can.mockReturnValue({ allowed: false, reason: "ACTOR_INACTIVE" });
    await expect(requireAdmin("/admin")).rejects.toThrow("NOT_FOUND");
  });

  it("sends an admin without MFA to enrollment", async () => {
    getCurrentUser.mockResolvedValue(
      user({ isAdmin: true, twoFactorEnabled: false }),
    );
    can.mockReturnValue({ allowed: true });
    await expect(requireAdmin("/admin")).rejects.toThrow(
      "REDIRECT:/account/security?reason=mfa-required",
    );
  });

  it("returns an enrolled admin", async () => {
    const admin = user({ isAdmin: true });
    getCurrentUser.mockResolvedValue(admin);
    can.mockReturnValue({ allowed: true });
    await expect(requireAdmin("/admin")).resolves.toBe(admin);
  });
});
