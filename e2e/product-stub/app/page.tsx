import { logoutUrl } from "@nusgaops/sgauth/urls";
import { headers } from "next/headers";
import { config } from "../lib/config";
import { getServerSession } from "../lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getServerSession();
  if (session === null) return <p>Not signed in.</p>;

  // Sign out returns to this product's own home page.
  const host = (await headers()).get("host");
  const home = `http://${host}/`;
  return (
    <>
      <p>Signed in as {session.user.email}.</p>
      <a href={logoutUrl(home, { baseUrl: config.sgauthUrl })}>Sign out</a>
    </>
  );
}
