import type { Instrumentation } from "next";

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

// Sends thrown request errors to PostHog error tracking. It reads the route,
// the path without its query string and the method, never the headers. It
// must never throw: an error in here would hide the one it was reporting.
export const onRequestError: Instrumentation.onRequestError = async (
  err,
  request,
  context,
) => {
  // eslint-disable-next-line no-restricted-syntax -- NEXT_RUNTIME is set by Next per runtime, not app configuration
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { analytics } = await import("@/lib/analytics");
    await analytics.captureError(err, {
      route: context.routePath,
      path: request.path.split("?")[0],
      method: request.method,
      source: "request",
    });
  } catch {
    // Reporting is best effort.
  }
};
