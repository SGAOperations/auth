import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ProductExplorer } from "@/components/home/product-explorer";
import { LinkTile } from "@/components/home/resource-list";
import { buttonVariants } from "@/components/ui/button";
import { loadAccountOverview } from "@/lib/account/server";
import { requireUser } from "@/lib/auth/guards";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { toHomeProducts } from "@/lib/home/products";
import { SGA_LINKS } from "@/lib/home/resources";
import { displayName } from "@/lib/user-display";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Home" };

const sectionHeading = "font-heading text-base leading-snug font-medium";

export default async function HomePage() {
  const user = await requireUser("/");
  const overview = await loadAccountOverview(user.id);
  if (!overview) redirect("/login");
  const { profile, isLeadership } = overview;
  // Leadership content is attached here, on the server, so a non-leader's page
  // never carries it.
  const products = toHomeProducts(
    overview.tools,
    overview,
    new URL(toAuthSettings(env).baseURL).origin,
  );

  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight break-words">
            Hi, {displayName(profile)}
          </h1>
          <p className="text-sm text-muted-foreground break-all">
            Signed in as {profile.email}
          </p>
        </div>
        <Link
          href="/account"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
        >
          Your account
        </Link>
      </header>

      <section aria-labelledby="tools-heading" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="tools-heading" className={sectionHeading}>
            Your SGA tools
          </h2>
          <p className="text-sm text-muted-foreground">
            One sign-in works across every SGA tool.
          </p>
        </div>
        {products.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tools are available to you yet. Tools appear here when an admin
            gives you a position or opens a tool to everyone.
          </p>
        ) : (
          <ProductExplorer products={products} />
        )}
      </section>

      <section
        aria-labelledby="sga-links-heading"
        className="flex flex-col gap-3"
      >
        <h2 id="sga-links-heading" className={sectionHeading}>
          Around SGA
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <LinkTile
            href={SGA_LINKS.website.href}
            title={SGA_LINKS.website.label}
            description={SGA_LINKS.website.note}
          />
          <LinkTile
            href={SGA_LINKS.slack.href}
            title={SGA_LINKS.slack.label}
            description={SGA_LINKS.slack.note}
          />
          {isLeadership ? (
            <LinkTile
              href="/resources"
              title="Leadership resources"
              description="Forms, guides and templates for SGA leaders."
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
