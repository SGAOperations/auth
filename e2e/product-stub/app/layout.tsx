import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { getConfig } from "../lib/config";

// Both read the per-product env, so they wait for a request: the build has no
// PRODUCT_ID or PRODUCT_NAME, and products A and B share one build.
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  return { title: getConfig().productName };
}

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  await connection();
  return (
    <html lang="en">
      <body>
        <h1>{getConfig().productName}</h1>
        {children}
      </body>
    </html>
  );
}
