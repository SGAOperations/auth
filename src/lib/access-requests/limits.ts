/**
 * Character limits for an access request's free text. The CHECKs in the
 * access_request migration mirror these numbers, so changing one needs a new
 * migration. The submit handler builds its zod schema from the same numbers.
 */
export const ACCESS_REQUEST_LIMITS = { product: 100, access: 500 } as const;
