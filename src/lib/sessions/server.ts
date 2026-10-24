import "server-only";
import { auth } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";
import {
  betterAuthSessionDeps,
  createOwnSessionHandlers,
} from "@/lib/sessions/own-sessions";

// Real wiring lives here; tests build their own handlers and never import it.
export const ownSessions = createOwnSessionHandlers(
  betterAuthSessionDeps(auth, prisma),
);
