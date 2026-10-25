import "server-only";
import { notFound, redirect } from "next/navigation";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  MFA_ENROLLMENT_PATH,
  MFA_ERROR_CODES,
  adminMfaDecision,
} from "@/lib/auth/mfa-policy";

interface AdminGuardInput {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>;
  prisma: Pick<PrismaClient, "user">;
}

export type AdminGuardResult =
  | { ok: true; actor: { id: string } }
  | { ok: false; response: Response };

/**
 * The guard every admin route and page calls. Admin endpoints answer 401 for
 * no session, 403 `NOT_ADMIN` for a non-admin or inactive user, and 403
 * `MFA_REQUIRED` for an admin who has not enrolled. Callers never restate it.
 */
export function createAdminGuard({ getSession, prisma }: AdminGuardInput) {
  // `session.user` carries neither the admin flags nor the MFA flag, so they
  // are read fresh.
  async function decide(headers: Headers) {
    const session = await getSession(headers);
    if (!session) return { session: null, decision: null } as const;
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: {
        isAdmin: true,
        isPrimaryAdmin: true,
        twoFactorEnabled: true,
        status: true,
      },
    });
    return {
      session,
      decision: user
        ? adminMfaDecision(user)
        : ({ allowed: false, reason: "NOT_ACTIVE" } as const),
    };
  }

  async function requireAdmin(headers: Headers): Promise<AdminGuardResult> {
    const { session, decision } = await decide(headers);
    if (!session || !decision) {
      return {
        ok: false,
        response: Response.json({ code: "UNAUTHORIZED" }, { status: 401 }),
      };
    }
    if (decision.allowed) return { ok: true, actor: { id: session.user.id } };
    if (decision.reason === "MFA_REQUIRED") {
      return {
        ok: false,
        response: Response.json(
          {
            ...MFA_ERROR_CODES.MFA_REQUIRED,
            enrollmentUrl: MFA_ENROLLMENT_PATH,
          },
          { status: 403 },
        ),
      };
    }
    return {
      ok: false,
      response: Response.json({ code: "NOT_ADMIN" }, { status: 403 }),
    };
  }

  /**
   * For server components. Non-admins get a 404, so the admin pages do not
   * announce themselves; an admin without MFA goes to enrollment.
   */
  async function requireAdminPage(headers: Headers): Promise<{ id: string }> {
    const { session, decision } = await decide(headers);
    if (!session || !decision) notFound();
    if (decision.allowed) return { id: session.user.id };
    if (decision.reason === "MFA_REQUIRED") {
      redirect(`${MFA_ENROLLMENT_PATH}?reason=mfa-required`);
    }
    notFound();
  }

  return { requireAdmin, requireAdminPage };
}
