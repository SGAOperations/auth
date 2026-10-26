import "server-only";
import { after } from "next/server";

/**
 * Better Auth's `advanced.backgroundTasks.handler`. Keeps the Vercel function
 * alive until the task settles, so the work finishes after the response. Better
 * Auth has already attached its own `.catch` that logs the failure.
 *
 * Outside a request scope (scripts, seed) `after` throws; the task is already
 * running, so it is left to finish and nothing is rethrown.
 */
export function runAfterResponse(task: Promise<unknown>): void {
  try {
    after(task);
  } catch {
    // No request scope: the task keeps running on its own.
  }
}
