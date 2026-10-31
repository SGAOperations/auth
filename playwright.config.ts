import { defineConfig, devices } from "@playwright/test";

const isCI = Boolean(process.env.CI);

// Readiness probes use 127.0.0.1: Node's resolver does not resolve
// *.localhost names on every OS, while Chromium always does.
const productEnv = (id: "a" | "b", name: string) => ({
  PRODUCT_ID: id,
  PRODUCT_NAME: name,
  SGAUTH_URL: "http://auth.sga.localhost:3000",
  SGAUTH_COOKIE_NAME: "sgauth-local.session_token",
  SGAUTH_CACHE_TTL_SECONDS: "1",
});

export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  // The specs share database fixtures, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  // A retry would hide a flaky pass.
  retries: 0,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ...(isCI ? ([["github"]] as const) : []),
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx next start -p 3000",
      url: "http://127.0.0.1:3000/api/auth/ok",
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      command: "npx next start e2e/product-stub -p 3001",
      url: "http://127.0.0.1:3001/",
      env: productEnv("a", "Product A"),
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      command: "npx next start e2e/product-stub -p 3002",
      url: "http://127.0.0.1:3002/",
      env: productEnv("b", "Product B"),
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
