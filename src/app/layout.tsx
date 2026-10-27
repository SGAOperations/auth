import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import { EnvironmentBanner } from "@/components/environment-banner";
import { SiteFooter } from "@/components/site-footer";
import { Toaster } from "@/components/ui/sonner";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: "SGA Account", template: "%s · SGA Account" },
  description: "Sign in once for every SGA tool.",
  ...(env.SGAUTH_ENV !== "production" && {
    robots: { index: false, follow: false },
  }),
};

// The app is dark-only: tell the browser before CSS loads.
export const viewport: Viewport = { colorScheme: "dark" };

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Every page must render per request to carry the CSP nonce; doing it in the
  // root layout covers future pages.
  await connection();
  return (
    <html
      lang="en"
      className={cn(
        geistSans.variable,
        geistMono.variable,
        "dark h-full antialiased",
      )}
    >
      <body className="min-h-full flex flex-col">
        <EnvironmentBanner sgauthEnv={env.SGAUTH_ENV} />
        {children}
        <SiteFooter />
        <Toaster richColors closeButton />
      </body>
    </html>
  );
}
