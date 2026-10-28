import { describe, expect, it } from "vitest";
import {
  actionParam,
  ADMIN_USER_ACTIONS,
  createBody,
  listQuery,
  patchBody,
  userIdParam,
} from "@/lib/admin/users/schemas";

const ID = "0194f4a4-6b1e-7c3a-9d52-3f8a1b2c4d5e";

describe("userIdParam", () => {
  it("accepts a uuid and rejects anything else", () => {
    expect(userIdParam.safeParse(ID).success).toBe(true);
    expect(userIdParam.safeParse("not-a-uuid").success).toBe(false);
    expect(userIdParam.safeParse("").success).toBe(false);
  });
});

describe("listQuery", () => {
  it("defaults page to 1 and pageSize to 25", () => {
    expect(listQuery.parse({})).toEqual({ page: 1, pageSize: 25 });
  });

  it("coerces the numeric strings a query string carries", () => {
    expect(listQuery.parse({ page: "3", pageSize: "100" })).toMatchObject({
      page: 3,
      pageSize: 100,
    });
  });

  it.each([
    [{ pageSize: "101" }],
    [{ pageSize: "0" }],
    [{ page: "0" }],
    [{ page: "1.5" }],
    [{ isAdmin: "yes" }],
    [{ status: "ARCHIVED" }],
    [{ q: "" }],
    [{ q: " " }],
    [{ q: "x".repeat(101) }],
    [{ position: "VP-Finance" }],
    [{ position: "a" }],
    [{ position: "a".repeat(65) }],
    [{ sort: "name" }],
  ])("rejects %j", (query) => {
    expect(listQuery.safeParse(query).success).toBe(false);
  });

  it.each([
    [{ q: "x".repeat(100) }],
    [{ position: "ab" }],
    [{ position: "a".repeat(64) }],
    [{ pageSize: "1" }],
    [{ status: "DELETED" }],
  ])("accepts the edge %j", (query) => {
    expect(listQuery.safeParse(query).success).toBe(true);
  });

  it("maps isAdmin to a boolean", () => {
    expect(listQuery.parse({ isAdmin: "true" }).isAdmin).toBe(true);
    expect(listQuery.parse({ isAdmin: "false" }).isAdmin).toBe(false);
  });

  it("trims q", () => {
    expect(listQuery.parse({ q: "  sam " }).q).toBe("sam");
  });
});

describe("createBody", () => {
  const valid = { email: "a@example.com", name: "Avery" };

  it("lower-cases and trims the email and accepts any domain", () => {
    expect(
      createBody.parse({ ...valid, email: "  Invitee@Example.COM " }).email,
    ).toBe("invitee@example.com");
  });

  it("defaults sendInvite to true", () => {
    expect(createBody.parse(valid).sendInvite).toBe(true);
    expect(createBody.parse({ ...valid, sendInvite: false }).sendInvite).toBe(
      false,
    );
  });

  it.each([
    [{ ...valid, email: "nope" }],
    [{ ...valid, email: `${"a".repeat(310)}@example.com` }],
    [{ ...valid, name: "" }],
    [{ ...valid, name: " " }],
    [{ ...valid, name: "x".repeat(101) }],
    [{ ...valid, preferredName: "" }],
    [{ ...valid, preferredName: "x".repeat(101) }],
    [{ ...valid, sendInvite: "yes" }],
    [{ ...valid, isAdmin: true }],
    [{ name: "Avery" }],
    [{ email: "a@example.com" }],
  ])("rejects %j", (body) => {
    expect(createBody.safeParse(body).success).toBe(false);
  });

  it("accepts a 100-character name and preferredName", () => {
    const name = "x".repeat(100);
    expect(
      createBody.safeParse({ ...valid, name, preferredName: name }).success,
    ).toBe(true);
  });
});

describe("patchBody", () => {
  it("rejects an empty body", () => {
    expect(patchBody.safeParse({}).success).toBe(false);
  });

  it("accepts either field, and null to clear preferredName", () => {
    expect(patchBody.safeParse({ name: "Sam" }).success).toBe(true);
    expect(patchBody.parse({ preferredName: null })).toEqual({
      preferredName: null,
    });
  });

  it.each([
    [{ name: "" }],
    [{ name: null }],
    [{ preferredName: "" }],
    [{ name: "x".repeat(101) }],
    [{ email: "a@example.com" }],
    [{ name: "Sam", status: "DELETED" }],
  ])("rejects %j", (body) => {
    expect(patchBody.safeParse(body).success).toBe(false);
  });
});

describe("actionParam", () => {
  it.each(ADMIN_USER_ACTIONS)("accepts %s", (action) => {
    expect(actionParam.safeParse(action).success).toBe(true);
  });

  it.each(["Deactivate", "delete", "frobnicate", ""])("rejects %j", (value) => {
    expect(actionParam.safeParse(value).success).toBe(false);
  });
});
