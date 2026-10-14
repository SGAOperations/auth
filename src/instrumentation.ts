export async function register() {
  // eslint-disable-next-line no-restricted-syntax -- NEXT_RUNTIME is set by Next per runtime, not app configuration
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // The full environment is validated first, so every bad variable is
    // reported together. Importing the auth config then resolves the base
    // URL, so a bad one stops the server at boot instead of on the first
    // request.
    await import("@/lib/env");
    await import("@/lib/auth/config");
  }
}
