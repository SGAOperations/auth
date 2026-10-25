import { createCapturingMailer } from "@/test/capturing-mailer";

/**
 * The `lockout` input of `buildAuthOptions` for tests that do not exercise the
 * lockout: a capturing mailer, the local device cookie, and the inline defer.
 */
export function testLockout() {
  return {
    mailer: createCapturingMailer(),
    deviceCookie: { name: "sgauth-local.device", secure: false },
  };
}
