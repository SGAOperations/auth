import { symmetricEncrypt } from "better-auth/crypto";
import { generateExportedKeyPair } from "better-auth/plugins/jwt";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/index.js";
import {
  JWKS_GRACE_PERIOD_SECONDS,
  JWT_ALG,
  STAGED_KEY_CREATED_AT,
} from "../../src/lib/auth/jwt-constants.js";

// Staged rotation of the JWT signing keys, behind scripts/jwks-rotate.ts. Like
// primary-admin.ts it takes its client as an argument, because src/lib is
// `server-only` and bound to the app singleton.
//
// The jwt plugin always signs with the newest live key, so it cannot hold a key
// back. A staged key therefore carries `createdAt = STAGED_KEY_CREATED_AT`: it
// is published in the JWKS (so every Supabase project can be given the combined
// set first) but is never the newest. `activate` moves its `createdAt` to now
// and expires the old key, which stays published for the grace period.

export class JwksRotationError extends Error {}

export type KeyRow = {
  id: string;
  alg: string | null;
  createdAt: Date;
  expiresAt: Date | null;
};

export type KeyState =
  /** The newest live ES256 key: the one that signs. */
  | "active"
  /** Live, published, never signs until activated. */
  | "staged"
  /** Live ES256 key that is not the newest: published, does not sign. */
  | "superseded"
  /** Expired, still published for the grace period. */
  | "retiring"
  /** Past the grace period: no longer published. */
  | "retired"
  /** Any other algorithm. Reported and never touched. */
  | "other";

export type ClassifiedKey = { row: KeyRow; state: KeyState };

const isStagedRow = (row: KeyRow) =>
  row.createdAt.getTime() === STAGED_KEY_CREATED_AT.getTime();

/** Mirrors the plugin: live while `expiresAt` is unset or in the future. */
const isLive = (row: KeyRow, now: Date) =>
  row.expiresAt === null || row.expiresAt > now;

export function classifyKeys(rows: KeyRow[], now: Date): ClassifiedKey[] {
  const live = rows
    .filter((row) => row.alg === JWT_ALG && isLive(row, now))
    .filter((row) => !isStagedRow(row));
  const newest = live.reduce<KeyRow | null>(
    (best, row) =>
      best === null || row.createdAt > best.createdAt ? row : best,
    null,
  );

  const stateOf = (row: KeyRow): KeyState => {
    if (row.alg !== JWT_ALG) return "other";
    if (isLive(row, now)) {
      if (isStagedRow(row)) return "staged";
      return row === newest ? "active" : "superseded";
    }
    // Not live, so `expiresAt` is set. The plugin publishes a key while
    // expiresAt + grace is in the future.
    const publishedUntil =
      (row.expiresAt as Date).getTime() + JWKS_GRACE_PERIOD_SECONDS * 1000;
    return publishedUntil > now.getTime() ? "retiring" : "retired";
  };

  return rows
    .map((row) => ({ row, state: stateOf(row) }))
    .sort((a, b) => b.row.createdAt.getTime() - a.row.createdAt.getTime());
}

const keysIn = (keys: ClassifiedKey[], state: KeyState) =>
  keys.filter((key) => key.state === state).map((key) => key.row);

/** Throws unless a new key can be staged. */
export function planStage(keys: ClassifiedKey[]): void {
  if (keysIn(keys, "active").length === 0) {
    // A lone staged key would sign at once, with no key to overlap.
    throw new JwksRotationError(
      "There is no active signing key to rotate away from. Call /api/auth/jwks once on this environment to create the first key, then stage again.",
    );
  }
  if (keysIn(keys, "staged").length > 0) {
    throw new JwksRotationError(
      "A staged key already exists. Activate it, or remove it, before staging another.",
    );
  }
}

/** The key to expire and the key to start signing with, or a refusal. */
export function planActivate(keys: ClassifiedKey[]): {
  activeId: string;
  stagedId: string;
} {
  const [active] = keysIn(keys, "active");
  const staged = keysIn(keys, "staged");
  if (staged.length === 0) {
    throw new JwksRotationError("There is no staged key to activate.");
  }
  if (staged.length > 1) {
    throw new JwksRotationError(
      "More than one staged key exists; refusing to guess which to activate.",
    );
  }
  if (!active) {
    throw new JwksRotationError("There is no active signing key to replace.");
  }
  return { activeId: active.id, stagedId: staged[0].id };
}

/** One line per key. Ids and dates only: never key material. */
export function formatKeyStatus(keys: ClassifiedKey[]): string {
  if (keys.length === 0) {
    return "No signing keys yet. The first call to /api/auth/jwks creates one.";
  }
  const date = (value: Date | null) =>
    value === null ? "never" : value.toISOString();
  return keys
    .map(({ row, state }) => {
      const created = isStagedRow(row) ? "staged" : date(row.createdAt);
      return `${row.id}  ${state.padEnd(10)}  alg=${row.alg ?? "none"}  created=${created}  expires=${date(row.expiresAt)}`;
    })
    .join("\n");
}

type Reader = Pick<Prisma.TransactionClient, "jwks">;

const KEY_SELECT = {
  id: true,
  alg: true,
  createdAt: true,
  expiresAt: true,
} as const;

export async function readKeys(db: Reader, now: Date) {
  return classifyKeys(await db.jwks.findMany({ select: KEY_SELECT }), now);
}

/**
 * Creates a staged ES256 key, stored exactly the way the plugin's createJwk
 * stores one (encrypted private key), except for the sentinel `createdAt`.
 * `secret` is BETTER_AUTH_SECRET. The state is read, planned and written inside
 * a serializable transaction, so two operators cannot both stage.
 */
export async function stageKey(
  db: Pick<PrismaClient, "$transaction">,
  secret: string,
  now: Date,
): Promise<string> {
  const { publicWebKey, privateWebKey } = await generateExportedKeyPair({
    jwks: { keyPairConfig: { alg: JWT_ALG } },
  });
  const privateKey = JSON.stringify(
    await symmetricEncrypt({
      key: secret,
      data: JSON.stringify(privateWebKey),
    }),
  );

  return db.$transaction(
    async (tx) => {
      planStage(await readKeys(tx, now));
      const row = await tx.jwks.create({
        data: {
          publicKey: JSON.stringify(publicWebKey),
          privateKey,
          alg: JWT_ALG,
          crv: "P-256",
          createdAt: STAGED_KEY_CREATED_AT,
        },
        select: { id: true },
      });
      return row.id;
    },
    { isolationLevel: "Serializable" },
  );
}

/**
 * Switches signing to the staged key and expires the old one, which stays in
 * the JWKS for the grace period. The state is re-read and re-planned inside a
 * serializable transaction, so two operators cannot both activate.
 */
export async function activateStagedKey(
  db: Pick<PrismaClient, "$transaction">,
  now: Date,
): Promise<{ activeId: string; stagedId: string }> {
  return db.$transaction(
    async (tx) => {
      const plan = planActivate(await readKeys(tx, now));
      await tx.jwks.update({
        where: { id: plan.activeId },
        data: { expiresAt: now },
      });
      await tx.jwks.update({
        where: { id: plan.stagedId },
        data: { createdAt: now },
      });
      // Written directly: src/lib/audit.ts is server-only. The shape follows
      // the JWKS_ROTATED catalog entry (no target, no metadata).
      await tx.auditEvent.create({
        data: { type: "JWKS_ROTATED", actorType: "SYSTEM", metadata: {} },
      });
      return plan;
    },
    { isolationLevel: "Serializable" },
  );
}
