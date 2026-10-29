import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    // Application code only: scripts/ is build and CI tooling.
    files: ["src/**/*.{ts,tsx}", "prisma/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          "MemberExpression[object.name='process'][property.name='env']",
          "MemberExpression[object.name='process'][property.value='env']",
          "VariableDeclarator[init.name='process'] > ObjectPattern > Property[key.name='env']",
        ].map((selector) => ({
          selector,
          message:
            "Read environment variables through env / publicEnv from @/lib/env (docs/ENGINEERING.md §2).",
        })),
      ],
    },
  },
  { files: ["src/lib/env.ts"], rules: { "no-restricted-syntax": "off" } },
  // The test harness reads TEST_* variables that are deliberately outside the app env schema.
  { files: ["src/test/**/*.ts"], rules: { "no-restricted-syntax": "off" } },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Coverage reports:
    "coverage/**",
    // Generated files:
    "src/generated/**",
    // e2e build output and Playwright reports:
    "e2e/product-stub/.next/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
