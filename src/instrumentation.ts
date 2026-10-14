export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Importing the config validates the auth environment, so a bad one
    // stops the server at boot instead of failing on the first request.
    await import("@/lib/auth/config");
  }
}
