import { describe, expect, it } from "vitest";
import { revokeUserSession } from "@/lib/admin/user-sessions";
import { prisma } from "@/lib/prisma";
import { createAdmin, createSession, createUser } from "@/test/factories";

const sessionEvents = (sessionId: string) =>
  prisma.auditEvent.findMany({
    where: { type: "SESSION_REVOKED", targetId: sessionId },
  });

describe("revokeUserSession", () => {
  it("revokes only the named session of that user and audits it once", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const doomed = await createSession(user);
    const kept = await createSession(user);

    const result = await revokeUserSession(prisma, admin, {
      userId: user.id,
      sessionId: doomed.id,
    });

    expect(result).toEqual({ ok: true });
    expect(
      await prisma.session.findUnique({ where: { id: doomed.id } }),
    ).toBeNull();
    expect(
      await prisma.session.findUnique({ where: { id: kept.id } }),
    ).not.toBeNull();
    const events = await sessionEvents(doomed.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: admin.id,
      targetType: "SESSION",
      metadata: { userId: user.id },
    });
  });

  it("answers NOT_FOUND and deletes nothing when the session is another user's", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const other = await createUser();
    const session = await createSession(other);

    const result = await revokeUserSession(prisma, admin, {
      userId: user.id,
      sessionId: session.id,
    });

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(
      await prisma.session.findUnique({ where: { id: session.id } }),
    ).not.toBeNull();
    expect(await sessionEvents(session.id)).toHaveLength(0);
  });

  it("denies a non-admin actor and deletes nothing", async () => {
    const actor = await createUser();
    const user = await createUser();
    const session = await createSession(user);

    const result = await revokeUserSession(prisma, actor, {
      userId: user.id,
      sessionId: session.id,
    });

    expect(result).toEqual({
      ok: false,
      code: "FORBIDDEN",
      reason: "NOT_ADMIN",
    });
    expect(
      await prisma.session.findUnique({ where: { id: session.id } }),
    ).not.toBeNull();
    expect(await sessionEvents(session.id)).toHaveLength(0);
  });

  it("answers NOT_FOUND for an unknown user", async () => {
    const admin = await createAdmin();
    const result = await revokeUserSession(prisma, admin, {
      userId: "00000000-0000-4000-8000-000000000000",
      sessionId: "00000000-0000-4000-8000-000000000001",
    });
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });
});
