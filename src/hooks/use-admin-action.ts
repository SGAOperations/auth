"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useReauth } from "@/components/reauth-dialog";
import type { ActionResult } from "@/lib/admin/action-result";
import { FAILURE_COPY, failureMessage } from "@/lib/admin/denial-copy";

interface RunOptions {
  /** The success toast, or a function of the result (an email may have failed). */
  success: string | ((result: Extract<ActionResult, { ok: true }>) => string);
  /** Called after a success, once the toast is shown. */
  onSuccess?: () => void;
}

/**
 * Runs Server Actions for the admin pages: one `pending` flag, a toast for
 * every outcome, a refresh of the server data, and the re-auth prompt. A
 * `REAUTH_REQUIRED` answer opens the prompt and, once it succeeds, runs the
 * same call once more; a second one is an error toast and never loops.
 * Cancelling the prompt ends the call quietly.
 */
export function useAdminAction() {
  const router = useRouter();
  const { prompt } = useReauth();
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (
      action: () => Promise<ActionResult>,
      { success, onSuccess }: RunOptions,
    ): Promise<boolean> => {
      setPending(true);
      try {
        let result = await action();
        if (!result.ok && result.code === "REAUTH_REQUIRED") {
          if (!(await prompt())) return false;
          result = await action();
        }
        if (result.ok) {
          toast.success(
            typeof success === "string" ? success : success(result),
          );
          onSuccess?.();
          router.refresh();
          return true;
        }
        toast.error(failureMessage(result));
        // The page is stale when the thing is gone or its state moved.
        if (result.code === "NOT_FOUND" || result.code === "CONFLICT") {
          router.refresh();
        }
        return false;
      } catch (error) {
        console.error(error);
        toast.error(FAILURE_COPY.UNEXPECTED);
        return false;
      } finally {
        setPending(false);
      }
    },
    [prompt, router],
  );

  return { run, pending };
}
