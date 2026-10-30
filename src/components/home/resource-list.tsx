import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  ResourceGroup as ResourceGroupData,
  ResourceItem,
} from "@/lib/home/resources";
import { cn } from "@/lib/utils";

// No hooks, so these render inside the client product explorer and on server
// pages alike.

const focusRing =
  "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ResourceItemRow({ item }: { item: ResourceItem }) {
  return (
    <li className="flex flex-col justify-center py-1 first:pt-0 last:pb-0">
      {item.href ? (
        <>
          <a
            href={item.href}
            rel="noreferrer"
            className={cn(
              "inline-flex min-h-11 items-center gap-1.5 underline-offset-4 hover:underline",
              focusRing,
            )}
          >
            <span className="break-words">{item.label}</span>
            <ArrowUpRight
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
          </a>
          {item.note ? (
            <p className="-mt-2 pb-1 text-sm text-muted-foreground">
              {item.note}
            </p>
          ) : null}
        </>
      ) : (
        <div className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="break-words">{item.label}</span>
          {item.comingSoon ? (
            <Badge variant="outline">Coming soon</Badge>
          ) : (
            <span className="text-sm text-muted-foreground">
              Link coming soon
            </span>
          )}
          {item.note ? (
            <p className="w-full text-sm text-muted-foreground">{item.note}</p>
          ) : null}
        </div>
      )}
    </li>
  );
}

type HeadingLevel = 2 | 3 | 4 | 5;

function GroupBody({ group }: { group: ResourceGroupData }) {
  return (
    <>
      {group.items.length > 0 ? (
        <ul className="flex flex-col divide-y">
          {group.items.map((item) => (
            <ResourceItemRow key={item.label} item={item} />
          ))}
        </ul>
      ) : null}
      {group.steps ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {group.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : null}
    </>
  );
}

export function ResourceGroup({
  group,
  headingLevel,
  variant,
}: {
  group: ResourceGroupData;
  headingLevel: HeadingLevel;
  variant: "card" | "plain";
}) {
  const Heading = `h${headingLevel}` as const;

  if (variant === "card") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>
            <Heading>{group.title}</Heading>
          </CardTitle>
          {group.intro ? (
            <CardDescription>{group.intro}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <GroupBody group={group} />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <Heading className="font-medium">{group.title}</Heading>
        {group.intro ? (
          <p className="text-sm text-muted-foreground">{group.intro}</p>
        ) : null}
      </div>
      <GroupBody group={group} />
    </div>
  );
}

export function LinkTile({
  href,
  title,
  description,
}: {
  href: string;
  title: string;
  description: string;
}) {
  const className = cn(
    "flex min-h-11 flex-col gap-0.5 rounded-xl bg-card/80 p-3 ring-1 ring-glow-faint backdrop-blur-sm transition-colors hover:bg-muted hover:ring-glow-muted focus-visible:ring-2 focus-visible:ring-ring outline-none",
  );
  const content = (
    <>
      <span className="font-medium break-words">{title}</span>
      <span className="text-sm text-muted-foreground">{description}</span>
    </>
  );
  return href.startsWith("/") ? (
    <Link href={href} className={className}>
      {content}
    </Link>
  ) : (
    <a href={href} rel="noreferrer" className={className}>
      {content}
    </a>
  );
}
