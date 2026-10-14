// Guard for scripts/sso-stub.mjs: the stub forwards the SGAuth session cookie
// to SGAUTH_URL, so a remote host must be https. Loopback and *.localhost
// never leave the machine, so plain http is fine there.

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

function isLocalHost(hostname) {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    LOOPBACK_V4.test(hostname)
  );
}

/** Returns a reason to refuse `value`, or null when it is safe to use. */
export function checkSgauthUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return "SGAUTH_URL is not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "SGAUTH_URL must use http or https";
  }
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    return "SGAUTH_URL must use https unless the host is localhost, *.localhost or loopback";
  }
  return null;
}
