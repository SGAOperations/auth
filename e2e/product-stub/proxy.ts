import { createSgaProxy } from "@nusgaops/sgauth/proxy";

// Reads the cookie name from SGAUTH_COOKIE_NAME, which the Playwright config
// sets. It never calls SGAuth: requireSession() is the boundary.
export default createSgaProxy({ publicPaths: ["/"] });

export const config = {
  matcher: ["/((?!_next/).*)"],
};
