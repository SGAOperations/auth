// Same cap audit.ts applies to a stored user agent.
const MAX_USER_AGENT_LENGTH = 512;

// First match wins, so order matters: Edge, Opera and Chrome all contain
// "Chrome/" or "Safari/", and iOS browsers report "Safari/" too.
function browserOf(userAgent: string): string | null {
  if (userAgent.includes("Edg/")) return "Edge";
  if (userAgent.includes("OPR/")) return "Opera";
  if (userAgent.includes("Firefox/") || userAgent.includes("FxiOS/")) {
    return "Firefox";
  }
  if (userAgent.includes("Chrome/") || userAgent.includes("CriOS/")) {
    return "Chrome";
  }
  if (userAgent.includes("Safari/") && userAgent.includes("Version/")) {
    return "Safari";
  }
  return null;
}

// iPhone and iPad come before macOS ("like Mac OS X"), and Android before
// Linux.
function osOf(userAgent: string): string | null {
  if (userAgent.includes("iPhone")) return "iPhone";
  if (userAgent.includes("iPad")) return "iPad";
  if (userAgent.includes("Android")) return "Android";
  if (userAgent.includes("CrOS")) return "ChromeOS";
  if (userAgent.includes("Windows")) return "Windows";
  if (userAgent.includes("Mac OS X") || userAgent.includes("Macintosh")) {
    return "macOS";
  }
  if (userAgent.includes("Linux")) return "Linux";
  return null;
}

/** A friendly device label such as "Chrome on macOS", from a raw user agent. */
export function describeDevice(userAgent: string | null | undefined): string {
  const ua = (userAgent ?? "").slice(0, MAX_USER_AGENT_LENGTH);
  const browser = browserOf(ua);
  const os = osOf(ua);
  if (browser && os) return `${browser} on ${os}`;
  if (browser) return browser;
  if (os) return `Unknown browser on ${os}`;
  return "Unknown device";
}
