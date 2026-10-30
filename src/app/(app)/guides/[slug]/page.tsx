import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { LeadershipOnly } from "@/components/home/leadership-only";
import { ResourceGroup } from "@/components/home/resource-list";
import { loadLeadershipViewer } from "@/lib/home/leadership";
import { guideBySlug } from "@/lib/home/resources";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const guide = guideBySlug((await params).slug);
  return guide ? { title: guide.name } : {};
}

export default async function GuidePage({ params }: Props) {
  const guide = guideBySlug((await params).slug);
  if (!guide) notFound();

  // `guide.path` is a module literal, which is what requireUser needs.
  const { isLeadership } = await loadLeadershipViewer(guide.path);
  if (!isLeadership) return <LeadershipOnly />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link
        href="/resources"
        className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Leadership resources
      </Link>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{guide.name}</h1>
        <p className="text-sm text-muted-foreground">{guide.summary}</p>
      </header>
      <div className="flex flex-col gap-4">
        {guide.groups.map((group) => (
          <ResourceGroup
            key={group.id}
            group={group}
            headingLevel={2}
            variant="card"
          />
        ))}
      </div>
    </div>
  );
}
