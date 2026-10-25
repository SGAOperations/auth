import "dotenv/config";
import { z } from "zod";
import { UsageError } from "../prisma/seed/sync-env.js";
import {
  integrationSchema,
  jwksUrlFor,
  matchIntegrations,
  parsePublicJwks,
  parsePushArgs,
  parsePushEnv,
  planProject,
  resolvedCovers,
  type Integration,
  type PublicJwk,
} from "./rotation/supabase-tpa.js";

// Standalone ops script, run only by an operator with a local
// SUPABASE_ACCESS_TOKEN: never in CI, never on Vercel. It is the one place SGAuth
// talks to the Supabase Management API, a product-integration tooling exception
// (plain fetch, no @supabase/* dependency, nothing under src/), the same as
// scripts/supabase-register-tpa.ts. Dry run by default; `--apply` writes.
// See docs/runbooks/rotate-secrets.md.

const USAGE =
  "Usage: npm run supabase:push-jwks -- --project-ref <ref> [--project-ref <ref> ...] [--issuer <https-origin>] [--apply]\n" +
  "Needs SUPABASE_ACCESS_TOKEN in the environment. Exit 0: every project verified. 1: input or API error. 2: not verified yet, re-run.";

const POLL_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 5_000;

class ApiError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function client(accessToken: string, ref: string) {
  const base = `https://api.supabase.com/v1/projects/${ref}/config/auth/third-party-auth`;

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      // Status and the API's `message` only: never the request or the token.
      let message = "";
      try {
        const body = z
          .object({ message: z.string() })
          .safeParse(await response.json());
        if (body.success) message = `: ${body.data.message}`;
      } catch {
        // No JSON body.
      }
      throw new ApiError(`Supabase answered ${response.status}${message}`);
    }
    return response.status === 204 ? null : response.json();
  }

  return {
    async list(): Promise<Integration[]> {
      return z.array(integrationSchema).parse(await call(""));
    },
    async get(id: string): Promise<Integration> {
      return integrationSchema.parse(await call(`/${id}`));
    },
    async create(keys: PublicJwk[]): Promise<Integration> {
      return integrationSchema.parse(
        await call("", {
          method: "POST",
          body: JSON.stringify({ custom_jwks: { keys } }),
        }),
      );
    },
    async remove(id: string): Promise<void> {
      await call(`/${id}`, { method: "DELETE" });
    },
  };
}

type Outcome = "verified" | "waiting" | "error";

async function fetchJwks(issuer: string) {
  const response = await fetch(jwksUrlFor(issuer));
  if (!response.ok) {
    throw new UsageError(
      `${jwksUrlFor(issuer)} answered ${response.status}; nothing to push.`,
    );
  }
  return parsePublicJwks(await response.json());
}

async function processProject(
  accessToken: string,
  ref: string,
  issuer: string,
  keys: PublicJwk[],
  apply: boolean,
): Promise<Outcome> {
  const api = client(accessToken, ref);
  const liveKids = keys.map((key) => key.kid);
  const plan = planProject(
    matchIntegrations(await api.list(), issuer, liveKids),
  );

  if (plan.kind === "error") {
    console.log(`${ref}: ${plan.reason}`);
    return "error";
  }

  let verify = plan.verify;
  if (plan.push) {
    if (!apply) {
      console.log(
        `${ref}: dry run. Would create an inline integration with ${liveKids.join(", ")} and delete ${plan.deleteAfterCreate.join(", ")} once it resolves. Re-run with --apply.`,
      );
    } else {
      // Create, confirm, then delete: trust is never missing.
      const created = await api.create(keys);
      let covered = false;
      for (let attempt = 0; attempt < POLL_ATTEMPTS && !covered; attempt++) {
        if (attempt > 0) await sleep(POLL_INTERVAL_MS);
        covered = resolvedCovers(
          (await api.get(created.id)).resolved_jwks,
          liveKids,
        );
      }
      if (!covered) {
        await api.remove(created.id);
        console.log(
          `${ref}: the new integration never resolved the keys. It was deleted and the old ones were left untouched.`,
        );
        return "error";
      }
      for (const id of plan.deleteAfterCreate) await api.remove(id);
      console.log(
        `${ref}: replaced ${plan.deleteAfterCreate.join(", ")} with ${created.id} (${liveKids.join(", ")}).`,
      );
      verify = [
        ...plan.verify.filter(
          (integration) => !plan.deleteAfterCreate.includes(integration.id),
        ),
        created,
      ];
    }
  }

  let outcome: Outcome = "verified";
  for (const integration of verify) {
    const current = await api.get(integration.id);
    if (resolvedCovers(current.resolved_jwks, liveKids)) {
      console.log(`${ref}: ${integration.id} resolves ${liveKids.join(", ")}.`);
      continue;
    }
    outcome = "waiting";
    const fetched =
      integration.oidc_issuer_url || integration.jwks_url
        ? "waiting for Supabase to re-fetch (up to ~30 min); re-run"
        : "not resolved yet; re-run";
    console.log(`${ref}: ${integration.id} ${fetched}.`);
  }
  return outcome;
}

async function main() {
  const args = parsePushArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const { accessToken } = parsePushEnv(process.env);

  const { keys } = await fetchJwks(args.issuer);
  console.log(
    `Issuer ${args.issuer} serves ${keys.map((key) => key.kid).join(", ")}.`,
  );

  const outcomes: Outcome[] = [];
  for (const ref of args.projectRefs) {
    try {
      outcomes.push(
        await processProject(accessToken, ref, args.issuer, keys, args.apply),
      );
    } catch (error) {
      console.log(
        `${ref}: ${error instanceof ApiError ? error.message : "unexpected error"}`,
      );
      outcomes.push("error");
    }
  }

  if (outcomes.includes("error")) process.exitCode = 1;
  else if (outcomes.includes("waiting")) process.exitCode = 2;
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
  } else {
    // Never console.error the raw error: a fetch failure can carry request
    // details.
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : "Unexpected error",
    );
  }
  process.exitCode = 1;
});
