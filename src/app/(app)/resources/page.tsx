import type { Metadata } from "next";
import { LeadershipOnly } from "@/components/home/leadership-only";
import { LinkTile, ResourceGroup } from "@/components/home/resource-list";
import { loadLeadershipViewer } from "@/lib/home/leadership";
import { GENERAL_RESOURCES, PRODUCT_GUIDES } from "@/lib/home/resources";

export const metadata: Metadata = { title: "Leadership resources" };

export default async function ResourcesPage() {
  const { isLeadership } = await loadLeadershipViewer("/resources");
  if (!isLeadership) return <LeadershipOnly />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Leadership resources
        </h1>
        <p className="text-sm text-muted-foreground">
          Forms, guides and templates for SGA leaders.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {GENERAL_RESOURCES.map((group) => (
          <ResourceGroup
            key={group.id}
            group={group}
            headingLevel={2}
            variant="card"
          />
        ))}
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="font-heading text-base leading-snug font-medium">
          Product guides
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {Object.values(PRODUCT_GUIDES).map((guide) => (
            <LinkTile
              key={guide.slug}
              href={guide.path}
              title={guide.name}
              description={guide.summary}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
