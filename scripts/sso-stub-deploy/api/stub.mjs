// Vercel entry for the dev-only cookie spike stub (AUTH-T104, #115).
//
// The config is fixed in code, not read from env, so a deployment of this stub
// can only ever touch the dev cookie. The one env read is the optional bypass
// secret, needed only while auth-dev is still behind Vercel Standard
// Protection (set it to a dedicated secret and revoke it at teardown). The
// `env.ts` rule in docs/ENGINEERING.md section 2 covers application code only,
// as scripts/sso-stub.mjs already says.
import { createStubHandler } from "../stub-core.mjs";

export const STUB_CONFIG = Object.freeze({
  sgauthUrl: "https://auth-dev.northeasternsga.com",
  cookieName: "__Secure-sgauth-dev.session_token",
  stubOrigin: "https://stub-dev.northeasternsga.com",
  parentDomain: "northeasternsga.com",
  siblingHost: "auth-dev.northeasternsga.com",
});

const handler = createStubHandler({
  ...STUB_CONFIG,
  bypassSecret: process.env.SGAUTH_DEV_BYPASS_SECRET || null,
  fetch,
});

export function GET(request) {
  return handler(request);
}

export function POST(request) {
  return handler(request);
}
