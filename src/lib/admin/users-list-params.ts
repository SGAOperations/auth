import { z } from "zod";
import { DEFAULT_PAGE_SIZE } from "@/lib/admin/users/schemas";
import { POSITION_KEY_PATTERN } from "@/lib/position-key";

// Pure and client-safe. The list page's URL is its state: every filter is a
// search param, and anything invalid falls back to its default instead of
// failing the page.

export const STATUS_FILTERS = [
  "default",
  "active",
  "deactivated",
  "deleted",
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const ADMIN_FILTERS = ["any", "yes", "no"] as const;
export type AdminFilter = (typeof ADMIN_FILTERS)[number];

export interface UsersListParams {
  q: string | undefined;
  status: StatusFilter;
  admin: AdminFilter;
  position: string | undefined;
  page: number;
}

type RawParams = Record<string, string | string[] | undefined>;

const firstValue = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

const querySchema = z.string().trim().min(1).max(100);
const positionSchema = z.string().max(64).regex(POSITION_KEY_PATTERN);
const pageSchema = z.coerce.number().int().min(1);

export function parseUsersListParams(raw: RawParams): UsersListParams {
  return {
    q: parsed(querySchema, firstValue(raw.q)),
    status: parsed(z.enum(STATUS_FILTERS), firstValue(raw.status)) ?? "default",
    admin: parsed(z.enum(ADMIN_FILTERS), firstValue(raw.admin)) ?? "any",
    position: parsed(positionSchema, firstValue(raw.position)),
    page: parsed(pageSchema, firstValue(raw.page)) ?? 1,
  };
}

/** The most pages a result of `total` rows spans; an empty result has one. */
export function lastPage(total: number, pageSize = DEFAULT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function clampPage(
  page: number,
  total: number,
  pageSize = DEFAULT_PAGE_SIZE,
): number {
  return Math.min(page, lastPage(total, pageSize));
}

/** The query string for `params`: non-default fields only, in a fixed order. */
export function serializeUsersListParams(
  params: Partial<UsersListParams>,
): URLSearchParams {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.status && params.status !== "default") {
    search.set("status", params.status);
  }
  if (params.admin && params.admin !== "any") search.set("admin", params.admin);
  if (params.position) search.set("position", params.position);
  if (params.page && params.page > 1) search.set("page", String(params.page));
  return search;
}

/** True when any filter, not the page, differs from the default. */
export function hasActiveFilters(params: UsersListParams): boolean {
  return (
    params.q !== undefined ||
    params.status !== "default" ||
    params.admin !== "any" ||
    params.position !== undefined
  );
}

/** The service's `status` and `isAdmin` arguments for a set of params. */
export function toListQuery(params: UsersListParams, page: number) {
  const statuses = {
    default: undefined,
    active: "ACTIVE",
    deactivated: "DEACTIVATED",
    deleted: "DELETED",
  } as const;
  const admins = { any: undefined, yes: true, no: false } as const;
  return {
    q: params.q,
    position: params.position,
    status: statuses[params.status],
    isAdmin: admins[params.admin],
    page,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}
