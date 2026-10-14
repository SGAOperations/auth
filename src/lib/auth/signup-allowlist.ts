import "server-only";

export interface SignupAllowlist {
  emails: Set<string>;
  domains: Set<string>;
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

function isValidDomain(host: string): boolean {
  return host.includes(".") && !host.includes("@") && !/\s/.test(host);
}

function isValidEmail(email: string): boolean {
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  const [local, host] = parts;
  return local.length > 0 && isValidDomain(host) && !/\s/.test(local);
}

/**
 * Parses SGAUTH_SIGNUP_ALLOWLIST: comma-separated exact emails and/or
 * `@domain` entries. Errors name the entry position, never its value.
 */
export function parseSignupAllowlist(raw: string | undefined): SignupAllowlist {
  const list: SignupAllowlist = { emails: new Set(), domains: new Set() };
  if (!raw) return list;
  const entries = raw
    .split(",")
    .map(normalise)
    .filter((entry) => entry.length > 0);
  entries.forEach((entry, index) => {
    if (entry.startsWith("@")) {
      const host = entry.slice(1);
      if (!isValidDomain(host)) {
        throw new Error(`SGAUTH_SIGNUP_ALLOWLIST: invalid entry #${index}`);
      }
      list.domains.add(host);
      return;
    }
    if (!isValidEmail(entry)) {
      throw new Error(`SGAUTH_SIGNUP_ALLOWLIST: invalid entry #${index}`);
    }
    list.emails.add(entry);
  });
  return list;
}

export function isEmailAllowed(list: SignupAllowlist, email: string): boolean {
  const normalised = normalise(email);
  if (list.emails.has(normalised)) return true;
  const at = normalised.lastIndexOf("@");
  if (at < 0) return false;
  return list.domains.has(normalised.slice(at + 1));
}
