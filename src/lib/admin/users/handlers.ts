import "server-only";
import type { z } from "zod";
import {
  Prisma,
  type PrismaClient,
  type User,
} from "@/generated/prisma/client";
import {
  apiJson,
  invalidInputResponse,
  readJson,
  requireAdmin,
  type AdminActor,
} from "@/lib/admin-api";
import { ACTION_SPECS } from "@/lib/admin/users/actions";
import {
  denied,
  userError,
  type AdminUserErrorCode,
} from "@/lib/admin/users/http";
import {
  getUser,
  getUserDetail,
  listUsers,
  loadTarget,
  type UserTarget,
} from "@/lib/admin/users/queries";
import {
  actionParam,
  createBody,
  listQuery,
  patchBody,
  userIdParam,
} from "@/lib/admin/users/schemas";
import {
  audit,
  auditRequestInfo,
  withAuditContext,
  withAuditTransaction,
} from "@/lib/audit";
import { can, type UserAction } from "@/lib/authz";
import type { Mailer, SendResult } from "@/lib/email/mailer";
import type { TransferNotice } from "@/lib/jobs/pa-transfer";
import { logger } from "@/lib/log";
import type { AdminInviteResult } from "@/lib/set-password/service";
import { tombstoneUser } from "@/lib/users/tombstone";

/** Next 16 passes route `params` as a Promise. */
export interface RouteContext {
  params: Promise<Record<string, string>>;
}

export type RouteHandler = (
  request: Request,
  ctx: RouteContext,
) => Promise<Response>;

export interface AdminUserDeps {
  prisma: PrismaClient;
  /** Fresh-auth guard, adapted: the 403 `REAUTH_REQUIRED` response, or null. */
  requireFreshAuth(headers: Headers): Promise<Response | null>;
  /** Lifts the account lock and kills unlock links. Does not audit. */
  clearAccountLock(
    db: Prisma.TransactionClient,
    input: { userId: string; now: Date },
  ): Promise<{ wasLocked: boolean }>;
  /** Mints the set-password token. Writes no audit row, sends no email. */
  issueAdminInvite(
    db: Prisma.TransactionClient,
    input: { userId: string; now: Date },
  ): Promise<AdminInviteResult>;
  mailer: Pick<Mailer, "sendEmail">;
  /** After commit; logs and never throws. */
  sendTransferNotice(notice: TransferNotice): Promise<void>;
  now(): Date;
}

/** What a mutation hands back to the pipeline once it has written its row. */
export interface RunSuccess {
  userId: string;
  /** Fields merged into the response body beside `user`. */
  extra?: Record<string, unknown>;
  /** Runs after the commit; its status goes in the body as `email`. */
  send?: () => Promise<SendResult>;
  /** A Primary Admin transfer the action cancelled; announced after the commit. */
  transferNotice?: TransferNotice;
}

export type RunOutcome = { fail: AdminUserErrorCode } | RunSuccess;

export interface RunInput<B> {
  tx: Prisma.TransactionClient;
  actor: AdminActor;
  target: UserTarget;
  body: B;
  now: Date;
}

export interface MutationSpec<B = undefined> {
  /** The per-target `can()` action. */
  authz: UserAction;
  freshAuth: boolean;
  body?: z.ZodType<B>;
  run(input: RunInput<B>, deps: AdminUserDeps): Promise<RunOutcome>;
}

/** Thrown inside the transaction so nothing commits, mapped to a 409 outside. */
class Abort extends Error {
  constructor(readonly code: AdminUserErrorCode) {
    super(code);
    this.name = "Abort";
  }
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

type Spec<B> = Pick<MutationSpec<B>, "authz" | "freshAuth" | "body">;

type Authorized<B> =
  | { response: Response }
  | { actor: AdminActor; target: UserTarget; body: B };

export function createAdminUserHandlers(deps: AdminUserDeps) {
  const { prisma } = deps;

  /** Wraps a handler so an unexpected throw is a logged 500, not a leak. */
  function guarded(action: string, fn: RouteHandler): RouteHandler {
    return async (request, ctx) => {
      try {
        return await fn(request, ctx);
      } catch (err) {
        logger.error("admin_user_action_failed", {
          action,
          errorName: err instanceof Error ? err.name : "unknown",
        });
        return userError("INTERNAL_ERROR");
      }
    };
  }

  /**
   * Pipeline steps 1 to 4: guard, input, target, `can()`, then fresh auth.
   * `resolve` picks the spec from the route params once the guard has passed,
   * or answers for an unknown one.
   */
  async function authorize<B>(
    request: Request,
    ctx: RouteContext,
    resolve: (params: Record<string, string>) => Spec<B> | Response,
  ): Promise<Authorized<B>> {
    const guard = await requireAdmin({ mutation: true, action: "accessAdmin" });
    if ("response" in guard) return guard;
    const { actor } = guard;

    const params = await ctx.params;
    const spec = resolve(params);
    if (spec instanceof Response) return { response: spec };

    // A malformed id looks the same as an unknown one.
    const id = userIdParam.safeParse(params.id);
    if (!id.success) return { response: userError("USER_NOT_FOUND") };

    let body = undefined as B;
    if (spec.body) {
      const parsed = await readJson(request, spec.body);
      if ("response" in parsed) return parsed;
      body = parsed.data;
    }

    const target = await loadTarget(prisma, id.data);
    if (!target) return { response: userError("USER_NOT_FOUND") };
    if (target.status === "DELETED") {
      return { response: userError("USER_DELETED") };
    }
    const decision = can(actor, spec.authz, target);
    if (!decision.allowed) return { response: denied(decision.reason) };

    // After can(), so an action that is never allowed does not ask for re-auth.
    if (spec.freshAuth) {
      const stale = await deps.requireFreshAuth(request.headers);
      if (stale) return { response: stale };
    }
    return { actor, target, body };
  }

  /**
   * Pipeline steps 5 to 7: the mutation and its one audit row in a single
   * transaction, then the email after the commit.
   */
  async function commit(
    request: Request,
    actor: AdminActor,
    run: (tx: Prisma.TransactionClient, now: Date) => Promise<RunOutcome>,
    status = 200,
  ): Promise<Response> {
    const now = deps.now();
    let outcome: RunSuccess;
    try {
      outcome = await withAuditTransaction(prisma, (tx) =>
        withAuditContext(
          {
            actor: { actorType: "USER", actorUserId: actor.id },
            ...auditRequestInfo(request.headers),
          },
          async () => {
            const result = await run(tx, now);
            if ("fail" in result) throw new Abort(result.fail);
            return result;
          },
        ),
      );
    } catch (err) {
      if (err instanceof Abort) return userError(err.code);
      throw err;
    }

    if (outcome.transferNotice) {
      await deps.sendTransferNotice(outcome.transferNotice);
    }

    const body: Record<string, unknown> = {
      user: await getUser(prisma, outcome.userId),
      ...outcome.extra,
    };
    if (outcome.send) {
      // Never changes the status code: the account change already committed.
      body.email = await outcome
        .send()
        .then((result) => result.status)
        .catch(() => "failed" as const);
    }
    return apiJson(body, { status });
  }

  const list = guarded("list", async (request) => {
    const guard = await requireAdmin({
      mutation: false,
      action: "accessAdmin",
    });
    if ("response" in guard) return guard.response;
    const query = listQuery.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!query.success) return invalidInputResponse(query.error);
    return apiJson(await listUsers(prisma, query.data));
  });

  const get = guarded("get", async (_request, ctx) => {
    const guard = await requireAdmin({
      mutation: false,
      action: "accessAdmin",
    });
    if ("response" in guard) return guard.response;
    const id = userIdParam.safeParse((await ctx.params).id);
    if (!id.success) return userError("USER_NOT_FOUND");
    // Tombstones are returned: they hold no personal data.
    const user = await getUserDetail(prisma, id.data, deps.now());
    return user ? apiJson({ user }) : userError("USER_NOT_FOUND");
  });

  // Create has no target and no separate create action, so the guard's
  // `accessAdmin` gate is the whole authorization check.
  const create = guarded("create", async (request) => {
    const guard = await requireAdmin({ mutation: true, action: "accessAdmin" });
    if ("response" in guard) return guard.response;
    const { actor } = guard;
    const parsed = await readJson(request, createBody);
    if ("response" in parsed) return parsed.response;
    const { email, name, preferredName, sendInvite } = parsed.data;

    return commit(
      request,
      actor,
      async (tx, now) => {
        if (await tx.user.findUnique({ where: { email } })) {
          return { fail: "EMAIL_TAKEN" };
        }
        let user: User;
        try {
          // No Account row: the account has no password until the invite is
          // used. Prisma writes it, so Better Auth's hooks never run and
          // there is no second USER_CREATED.
          user = await tx.user.create({
            data: {
              email,
              name,
              preferredName,
              emailVerified: true,
              status: "ACTIVE",
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return { fail: "EMAIL_TAKEN" };
          throw err;
        }

        let invite: Extract<AdminInviteResult, { ok: true }> | null = null;
        if (sendInvite) {
          const issued = await deps.issueAdminInvite(tx, {
            userId: user.id,
            now,
          });
          // The limit is per user and this user is new, so it cannot trip.
          if (!issued.ok) throw new Error("invite limit on a new user");
          invite = issued;
        }

        await audit({
          type: "USER_CREATED",
          targetType: "USER",
          targetId: user.id,
          metadata: { source: "admin", invited: invite !== null },
        });

        const sent = invite;
        return {
          userId: user.id,
          extra: sent ? undefined : { email: "skipped" },
          send: sent
            ? () =>
                deps.mailer.sendEmail({
                  to: user.email,
                  template: "set-password",
                  data: {
                    name: user.preferredName ?? user.name,
                    url: sent.url,
                    expiresInMinutes: sent.expiresInMinutes,
                    kind: "admin-invite",
                  },
                })
            : undefined,
        };
      },
      201,
    );
  });

  const update = guarded("update", async (request, ctx) => {
    const auth = await authorize(request, ctx, () => ({
      authz: "updateProfile",
      freshAuth: false,
      body: patchBody,
    }));
    if ("response" in auth) return auth.response;
    const { actor, target, body } = auth;

    const fields = (["name", "preferredName"] as const).filter(
      (field) => body[field] !== undefined && body[field] !== target[field],
    );
    // Nothing changed: no write and no audit row.
    if (fields.length === 0) {
      return apiJson({ user: await getUser(prisma, target.id) });
    }

    return commit(request, actor, async (tx) => {
      const changed = await tx.user.updateMany({
        where: { id: target.id, status: { not: "DELETED" } },
        data: {
          ...(fields.includes("name") ? { name: body.name } : {}),
          ...(fields.includes("preferredName")
            ? { preferredName: body.preferredName }
            : {}),
        },
      });
      if (changed.count === 0) return { fail: "USER_DELETED" };
      await audit({
        type: "USER_UPDATED",
        targetType: "USER",
        targetId: target.id,
        metadata: { fields },
      });
      return { userId: target.id };
    });
  });

  // The tombstone opens its own anonymization transaction, so it does not go
  // through `commit`.
  const remove = guarded("delete", async (request, ctx) => {
    const auth = await authorize(request, ctx, () => ({
      authz: "delete",
      freshAuth: true,
    }));
    if ("response" in auth) return auth.response;
    const { actor, target } = auth;

    const { tombstoned, transferNotice } = await tombstoneUser(prisma, {
      userId: target.id,
      reason: "admin",
      actor: { actorType: "USER", actorUserId: actor.id },
    });
    // A race: the user was deleted between the load and the tombstone.
    if (!tombstoned) return userError("USER_DELETED");
    if (transferNotice) await deps.sendTransferNotice(transferNotice);
    return apiJson({ user: await getUser(prisma, target.id) });
  });

  const action = guarded("action", async (request, ctx) => {
    // The guard runs before the action name is read, so an outsider cannot
    // probe which names exist.
    const auth = await authorize(request, ctx, (params) => {
      const name = actionParam.safeParse(params.action);
      return name.success
        ? ACTION_SPECS[name.data]
        : userError("UNKNOWN_ACTION");
    });
    if ("response" in auth) return auth.response;
    const { actor, target } = auth;
    // Already validated by `resolve`, so the parse cannot fail.
    const spec: MutationSpec =
      ACTION_SPECS[actionParam.parse((await ctx.params).action)];
    return commit(request, actor, (tx, now) =>
      spec.run({ tx, actor, target, body: undefined, now }, deps),
    );
  });

  return { list, create, get, update, remove, action };
}

export type AdminUserHandlers = ReturnType<typeof createAdminUserHandlers>;
