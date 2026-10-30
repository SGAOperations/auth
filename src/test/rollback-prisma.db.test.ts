import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", async (importOriginal) => {
  const { prisma } = await importOriginal<typeof import("@/lib/prisma")>();
  const { createRollbackPrisma } = await import("@/test/rollback-prisma");
  return { prisma: createRollbackPrisma(prisma) };
});

import { prisma } from "@/lib/prisma";
import { createPrimaryAdmin, createUser } from "@/test/factories";
import {
  assertDeferredConstraints,
  withRollback,
} from "@/test/rollback-prisma";

const exists = async (id: string) =>
  (await prisma.user.count({ where: { id } })) === 1;

const primaryAdminIds = async () =>
  (
    await prisma.user.findMany({
      where: { isPrimaryAdmin: true },
      select: { id: true },
    })
  )
    .map((user) => user.id)
    .sort();

const setting = async (name: string) => {
  const rows = await prisma.$queryRawUnsafe<{ value: string | null }[]>(
    `SELECT current_setting('${name}', true) AS value`,
  );
  return rows[0]?.value ?? "";
};

describe("withRollback", () => {
  it("leaves nothing behind, whether the body returns or throws", async () => {
    let returned = "";
    await withRollback(async () => {
      returned = (await createUser()).id;
      expect(await exists(returned)).toBe(true);
    });
    expect(await exists(returned)).toBe(false);

    let thrown = "";
    await expect(
      withRollback(async () => {
        thrown = (await createUser()).id;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await exists(thrown)).toBe(false);
  });

  it("rolls a failed nested transaction back to its savepoint and keeps the outer writes", async () => {
    await withRollback(async () => {
      const outer = await createUser();
      let inner = "";
      await expect(
        prisma.$transaction(async (tx) => {
          inner = (await createUser({}, tx)).id;
          throw new Error("handler failed");
        }),
      ).rejects.toThrow("handler failed");
      expect(await exists(inner)).toBe(false);
      expect(await exists(outer.id)).toBe(true);

      const kept = await prisma.$transaction(async (tx) => createUser({}, tx));
      expect(await exists(kept.id)).toBe(true);
    });
  });

  it("runs the array form in order inside one savepoint", async () => {
    await withRollback(async () => {
      const [count, users] = await prisma.$transaction([
        prisma.user.count(),
        prisma.user.findMany({ take: 1 }),
      ]);
      expect(count).toBeGreaterThanOrEqual(0);
      expect(users.length).toBeLessThanOrEqual(1);
    });
  });

  it("clears a transaction-local setting when the nested transaction ends", async () => {
    await withRollback(async () => {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('sgauth.pa_transfer', 'on', true)`,
        );
        expect(await setting("sgauth.pa_transfer")).toBe("on");
      });
      expect(await setting("sgauth.pa_transfer")).toBe("");

      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL sgauth.audit_anonymize = 'on'`);
      });
      expect(await setting("sgauth.audit_anonymize")).toBe("");
    });
  });

  it("never commits a Primary Admin", async () => {
    const before = await primaryAdminIds();
    await withRollback(async () => {
      const pa = await createPrimaryAdmin({ twoFactorEnabled: true }, prisma);
      expect(await primaryAdminIds()).toEqual([pa.id]);
      await assertDeferredConstraints();
    });
    expect(await primaryAdminIds()).toEqual(before);
  });

  it("fires the deferred rule that a Primary Admin must remain", async () => {
    await withRollback(async () => {
      const pa = await createPrimaryAdmin({ twoFactorEnabled: true }, prisma);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT set_config('sgauth.pa_transfer', 'on', true)`,
        );
        await tx.user.update({
          where: { id: pa.id },
          data: { isPrimaryAdmin: false },
        });
      });
      await expect(assertDeferredConstraints()).rejects.toThrow();
    });
  });

  it("refuses assertDeferredConstraints outside a case", async () => {
    await expect(assertDeferredConstraints()).rejects.toThrow(
      "inside withRollback",
    );
  });

  it("forwards to the real client outside a case", async () => {
    const user = await createUser();
    expect(await exists(user.id)).toBe(true);
    const result = await prisma.$transaction(async (tx) =>
      tx.user.count({ where: { id: user.id } }),
    );
    expect(result).toBe(1);
  });
});
