import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/config";

export { auth };

export type Session = typeof auth.$Infer.Session;

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}
