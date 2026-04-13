/**
 * Server-oriented exports; individual modules use `server-only` where needed.
 * Root middleware imports `updateSession` from here — do not add `import "server-only"` to this file.
 */
export {
  createAdminSupabaseClient,
  getAuthUser,
} from "./admin";
export {
  AUTH_CALLBACK_PATH,
  DEFAULT_OTP_SHOULD_CREATE_USER,
} from "./auth-constants";
export { authErrorToQueryCode } from "./auth-errors";
export {
  getSupabaseAnonKey,
  getSupabaseServiceRoleKey,
  getSupabaseUrl,
} from "./env";
export { getSafeNextPath } from "./next-redirect";
export { sendOtp, verifyOtp, type SendOtpOptions } from "./otp";
export { createServerSupabaseClient } from "./server";
export { updateSession } from "./middleware";
