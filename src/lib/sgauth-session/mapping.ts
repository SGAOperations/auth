import type {
  MinimalSessionResponse,
  SessionResponse,
} from "@/lib/sgauth-session/contract";

// Pure: no env, no I/O.

export interface SessionSubject {
  id: string;
  email: string;
  name: string;
  preferredName: string | null;
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  status: string;
  positions: { key: string; name: string }[];
}

export interface SessionRow {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  absoluteExpiresAt?: Date | null;
}

/**
 * Keeps only the `name=value` pairs whose name is in `names`, in the original
 * order. The handler refuses a request with more than one session-token pair
 * before calling this, so at most one reaches it; a repeated `dont_remember`
 * pair is passed through. `names[0]` is the session token: without it the
 * result is `null`, so a lone `dont_remember` never reaches the database.
 */
export function pickSessionCookies(
  cookieHeader: string | null,
  names: readonly string[],
): string | null {
  if (!cookieHeader) return null;
  const kept: string[] = [];
  let hasSessionToken = false;
  for (const pair of cookieHeader.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    const name = pair.slice(0, separator).trim();
    if (!names.includes(name)) continue;
    if (name === names[0]) hasSessionToken = true;
    kept.push(`${name}=${pair.slice(separator + 1).trim()}`);
  }
  return hasSessionToken ? kept.join("; ") : null;
}

/** The value of the first session-token pair in a filtered cookie string. */
export function sessionTokenValue(
  cookie: string,
  tokenName: string,
): string | null {
  for (const pair of cookie.split("; ")) {
    const separator = pair.indexOf("=");
    if (pair.slice(0, separator) === tokenName)
      return pair.slice(separator + 1);
  }
  return null;
}

/**
 * Code-unit order, never `localeCompare` or database collation: collation can
 * ignore `-`, which would put `vp-finance` after `vpa`.
 */
export function sortPositions<T extends { key: string }>(
  positions: readonly T[],
): T[] {
  return [...positions].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}

function mapPositions(positions: SessionSubject["positions"]) {
  return positions.map((position) => ({
    key: position.key,
    name: position.name,
  }));
}

export function toSessionResponse({
  subject,
  session,
}: {
  subject: SessionSubject;
  session: SessionRow;
}): SessionResponse {
  if (!session.absoluteExpiresAt) {
    throw new Error(
      "session.absoluteExpiresAt is missing: SESSION_OPTIONS.additionalFields was not applied",
    );
  }
  return {
    user: {
      id: subject.id,
      email: subject.email,
      name: subject.name,
      preferredName: subject.preferredName,
      isAdmin: subject.isAdmin,
      isPrimaryAdmin: subject.isPrimaryAdmin,
    },
    positions: mapPositions(subject.positions),
    session: {
      id: session.id,
      expiresAt: session.expiresAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      createdAt: session.createdAt.toISOString(),
    },
  };
}

export function toMinimalResponse({
  subject,
}: {
  subject: Pick<SessionSubject, "id" | "positions">;
}): MinimalSessionResponse {
  return {
    user: { id: subject.id },
    positions: mapPositions(subject.positions),
  };
}
