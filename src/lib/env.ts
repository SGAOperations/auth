// Not `server-only`: client components need `publicEnv`, and prisma/seed.ts
// loads this in plain Node, where `server-only` throws. `env` is guarded at
// runtime instead.
import {
  parsePublicEnv,
  parseServerEnv,
  type PublicEnv,
  type ServerEnv,
} from "./env-schema.js";

export type { PublicEnv, ServerEnv, SgauthEnv } from "./env-schema.js";

function clientGuard(): ServerEnv {
  return new Proxy({} as ServerEnv, {
    get(_target, key) {
      throw new Error(
        `Server env var "${String(key)}" was read in client code`,
      );
    },
  });
}

export const env: ServerEnv =
  typeof window === "undefined" ? parseServerEnv(process.env) : clientGuard();

// Next inlines only literal `process.env.NEXT_PUBLIC_X` references, so every
// public key is spelled out here, never read through a loop.
export const publicEnv: PublicEnv = parsePublicEnv({
  // NEXT_PUBLIC_X: process.env.NEXT_PUBLIC_X,
});
