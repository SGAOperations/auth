import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

// What a signed-in non-leader sees on a leadership page. It carries no
// leadership content: the page decides before it renders any.
export function LeadershipOnly() {
  return (
    <Empty className="mx-auto max-w-xl border">
      <EmptyHeader>
        <EmptyTitle>
          <h1>For SGA leadership</h1>
        </EmptyTitle>
        <EmptyDescription>
          These resources are for people who hold an SGA leadership position. If
          you hold one, ask an SGA admin to mark it as leadership.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Link href="/" className={cn(buttonVariants({ variant: "outline" }))}>
          Go to home
        </Link>
      </EmptyContent>
    </Empty>
  );
}
