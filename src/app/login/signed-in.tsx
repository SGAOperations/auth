import { Button } from "@/components/ui/button";
import { completeSignIn } from "./actions";
import { UseDifferentAccount } from "./use-different-account";

export function SignedIn({
  status,
}: {
  /** What a finished Slack step says, shown above Continue. */
  status?: string;
}) {
  return (
    <>
      {status ? (
        <p role="status" className="rounded-md border px-3 py-2 text-sm">
          {status}
        </p>
      ) : null}
      <form action={completeSignIn}>
        <Button type="submit" className="w-full">
          Continue
        </Button>
      </form>
      <UseDifferentAccount />
    </>
  );
}
