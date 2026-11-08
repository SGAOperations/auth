import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { listSubmitterPositionKeys } from "@/lib/access-submitters";
import { requireAdmin } from "@/lib/auth/guards";
import { listPositionOptions } from "@/lib/product-admin";
import { SubmittersForm } from "./submitters-form";

export const metadata: Metadata = { title: "Access submitters" };

const PATH = "/admin/access-submitters";

export default async function AccessSubmittersPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin(PATH);

  const [positions, current] = await Promise.all([
    listPositionOptions(),
    listSubmitterPositionKeys(),
  ]);
  const options = positions.map(({ key, name, category }) => ({
    key,
    name,
    category,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Access submitters
        </h1>
        <p className="text-muted-foreground">
          People in a checked position can ask for access to an external product
          with <code className="font-mono">/access</code> in Slack. Requests are
          recorded for the operations team to review. Nothing is granted
          automatically.
        </p>
      </div>

      {options.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No positions yet</EmptyTitle>
            <EmptyDescription>
              Create positions first, then choose which ones can submit
              requests.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link
              href="/admin/positions"
              className={buttonVariants({ variant: "outline" })}
            >
              Go to Positions
            </Link>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          {current.length === 0 ? (
            <p role="status" className="text-sm text-amber-600">
              No positions are allowed yet, so every{" "}
              <code className="font-mono">/access</code> request is refused.
            </p>
          ) : null}
          <SubmittersForm
            key={current.join(",")}
            options={options}
            current={current}
          />
        </>
      )}
    </div>
  );
}
