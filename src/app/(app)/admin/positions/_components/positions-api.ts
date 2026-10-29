import { z } from "zod";

// Client wrapper for the position endpoints. Nothing here throws for an HTTP
// error: the caller gets the status and the API's error code.

const BASE = "/api/sgauth/admin/positions";

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string };

const positionResponseSchema = z.object({
  position: z.object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    holderCount: z.number(),
  }),
});

const deleteResponseSchema = z.object({ holderCount: z.number() });

const errorBodySchema = z.object({ code: z.string() });

async function send<S extends z.ZodType>(
  url: string,
  init: { method: string; body?: unknown },
  schema: S,
): Promise<ApiResult<z.infer<S>>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    return { ok: false, status: 0, code: "NETWORK" };
  }

  const body: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = schema.safeParse(body);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, status: response.status, code: "UNEXPECTED_RESPONSE" };
  }
  const error = errorBodySchema.safeParse(body);
  return {
    ok: false,
    status: response.status,
    code: error.success ? error.data.code : "UNKNOWN",
  };
}

export interface CreatePositionBody {
  key: string;
  name: string;
  category: string;
  description: string;
}

export interface UpdatePositionBody {
  name: string;
  category: string;
  description: string;
}

export function createPosition(body: CreatePositionBody) {
  return send(BASE, { method: "POST", body }, positionResponseSchema);
}

export function updatePosition(id: string, body: UpdatePositionBody) {
  return send(
    `${BASE}/${encodeURIComponent(id)}`,
    { method: "PATCH", body },
    positionResponseSchema,
  );
}

/** The holder count shown before a delete is confirmed. */
export async function deletePositionPreflight(
  id: string,
): Promise<ApiResult<{ holderCount: number }>> {
  const result = await send(
    `${BASE}/${encodeURIComponent(id)}`,
    { method: "GET" },
    positionResponseSchema,
  );
  return result.ok
    ? { ok: true, data: { holderCount: result.data.position.holderCount } }
    : result;
}

export function deletePosition(id: string, confirmKey: string) {
  return send(
    `${BASE}/${encodeURIComponent(id)}`,
    { method: "DELETE", body: { confirmKey } },
    deleteResponseSchema,
  );
}
