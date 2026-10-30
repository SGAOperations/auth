// Shared by product-input.test.ts (zod) and product-registry.schema.db.test.ts (DB
// CHECKs): one table proves the JS regexes and the SQL constraints agree.
export const PRODUCT_CASES = {
  baseUrl: {
    accepted: [
      "https://auth.northeasternsga.com",
      "https://a.b.northeasternsga.com",
      "https://vaultz-dev.northeasternsga.com",
    ],
    rejected: [
      "http://auth.northeasternsga.com",
      "https://northeasternsga.com",
      "https://evilnortheasternsga.com",
      "https://auth.northeasternsga.com.evil.com",
      "https://auth.northeasternsga.com/",
      "https://auth.northeasternsga.com/app",
      "https://auth.northeasternsga.com:8443",
      "https://Auth.northeasternsga.com",
      "https://u@auth.northeasternsga.com",
      "https://-x.northeasternsga.com",
    ],
  },
  slug: {
    accepted: ["sgauth", "vaultz-dev", "a1"],
    rejected: ["a", "Bad_Slug", "-x", "x-", "a--b", "a".repeat(65)],
  },
  iconUrl: {
    accepted: [null, "https://cdn.example.com/i.png"],
    rejected: ["http://cdn.example.com/i.png", "javascript:alert(1)"],
  },
  loginRedirectPath: {
    accepted: [null, "/", "/dashboard", "/a/b?x=1"],
    rejected: ["dashboard", "//evil.com", "/a b", "/a\\b"],
  },
  // [visibility, visibleToPositionKeys] pairs: zod and Product_visibility_keys_check
  // must accept and refuse the same ones.
  visibility: {
    accepted: [
      ["EVERYONE", []],
      ["LEADERSHIP", []],
      ["UNSET", []],
      ["POSITIONS", ["senator"]],
      ["POSITIONS", ["senator", "parliamentarian"]],
    ],
    rejected: [
      ["POSITIONS", []],
      ["EVERYONE", ["senator"]],
      ["LEADERSHIP", ["senator"]],
      ["UNSET", ["senator"]],
    ],
  },
} as const;
