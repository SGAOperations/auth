import { describe, expect, it } from "vitest";
import {
  clampPage,
  hasActiveFilters,
  lastPage,
  parseUsersListParams,
  serializeUsersListParams,
  toListQuery,
} from "@/lib/admin/users-list-params";

describe("parseUsersListParams", () => {
  it("gives defaults when nothing is set", () => {
    expect(parseUsersListParams({})).toEqual({
      q: undefined,
      status: "default",
      admin: "any",
      position: undefined,
      page: 1,
    });
  });

  it("falls back on invalid values and never throws", () => {
    const params = parseUsersListParams({
      status: "bogus",
      admin: "maybe",
      position: "Not A Key!",
      page: "-3",
      q: "   ",
    });
    expect(params.status).toBe("default");
    expect(params.admin).toBe("any");
    expect(params.position).toBeUndefined();
    expect(params.page).toBe(1);
    expect(params.q).toBeUndefined();
    expect(parseUsersListParams({ page: "abc" }).page).toBe(1);
    expect(parseUsersListParams({ page: "2.5" }).page).toBe(1);
  });

  it("reads valid values, taking the first of a repeated one", () => {
    const params = parseUsersListParams({
      q: " ada ",
      status: ["deactivated", "active"],
      admin: "yes",
      position: "treasurer",
      page: "4",
    });
    expect(params).toEqual({
      q: "ada",
      status: "deactivated",
      admin: "yes",
      position: "treasurer",
      page: 4,
    });
  });

  it("caps a search at 100 characters by dropping it", () => {
    expect(parseUsersListParams({ q: "x".repeat(101) }).q).toBeUndefined();
  });
});

describe("paging", () => {
  it("clamps a page past the end to the last page", () => {
    expect(clampPage(9, 60)).toBe(3);
    expect(clampPage(2, 60)).toBe(2);
  });

  it("gives an empty result one page", () => {
    expect(lastPage(0)).toBe(1);
    expect(clampPage(5, 0)).toBe(1);
  });

  it("counts a partial last page", () => {
    expect(lastPage(26)).toBe(2);
    expect(lastPage(25)).toBe(1);
  });
});

describe("serializeUsersListParams", () => {
  it("omits defaults", () => {
    expect(serializeUsersListParams(parseUsersListParams({})).toString()).toBe(
      "",
    );
  });

  it("round-trips the non-default fields", () => {
    const params = parseUsersListParams({
      q: "ada",
      status: "active",
      admin: "no",
      position: "treasurer",
      page: "2",
    });
    const query = serializeUsersListParams(params);
    expect(parseUsersListParams(Object.fromEntries(query))).toEqual(params);
  });
});

describe("filters", () => {
  it("does not count the page as a filter", () => {
    expect(hasActiveFilters(parseUsersListParams({ page: "3" }))).toBe(false);
    expect(hasActiveFilters(parseUsersListParams({ admin: "yes" }))).toBe(true);
  });

  it("maps to the service query", () => {
    const query = toListQuery(
      parseUsersListParams({ status: "deleted", admin: "no" }),
      2,
    );
    expect(query).toMatchObject({
      status: "DELETED",
      isAdmin: false,
      page: 2,
      pageSize: 25,
    });
    expect(toListQuery(parseUsersListParams({}), 1)).toMatchObject({
      status: undefined,
      isAdmin: undefined,
    });
  });
});
