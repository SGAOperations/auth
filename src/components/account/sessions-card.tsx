"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SignOutEverywhereDialog } from "@/components/app-shell/sign-out-everywhere-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatSessionMeta,
  revokeOutcome,
  sessionListSchema,
  type SessionListItem,
} from "@/lib/account/sessions-view";

type LoadState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; sessions: SessionListItem[] };

function goToLogin() {
  // A full reload drops the client cache.
  window.location.replace("/login");
}

async function fetchSessions(): Promise<LoadState> {
  try {
    const response = await fetch("/api/sgauth/sessions", {
      cache: "no-store",
    });
    if (response.status === 401) {
      goToLogin();
      return { status: "loading" };
    }
    if (!response.ok) throw new Error(`status ${response.status}`);
    const parsed = sessionListSchema.parse(await response.json());
    return { status: "ready", sessions: parsed.sessions };
  } catch {
    return { status: "error" };
  }
}

export function SessionsCard() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [revoking, setRevoking] = useState<string | null>(null);
  const [everywhereOpen, setEverywhereOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchSessions().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function retry() {
    setState({ status: "loading" });
    void fetchSessions().then(setState);
  }

  async function revoke(session: SessionListItem) {
    setRevoking(session.id);
    try {
      const response = await fetch(`/api/sgauth/sessions/${session.id}`, {
        method: "DELETE",
      });
      const outcome = revokeOutcome(response.status);
      if (outcome === "signed-out") {
        goToLogin();
        return;
      }
      if (outcome === "failed") {
        toast.error("Couldn't sign out that device. Try again.");
        return;
      }
      setState((current) =>
        current.status === "ready"
          ? {
              status: "ready",
              sessions: current.sessions.filter((s) => s.id !== session.id),
            }
          : current,
      );
      toast.success(
        outcome === "revoked"
          ? `Signed out ${session.device}.`
          : "That session had already ended.",
      );
    } catch {
      toast.error("Couldn't sign out that device. Try again.");
    } finally {
      setRevoking(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where you&apos;re signed in</CardTitle>
        <CardDescription>
          Signing out a device ends its session in every SGA tool.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {state.status === "loading" ? (
          <div aria-busy="true" className="flex flex-col gap-3">
            <span className="sr-only">Loading your sessions…</span>
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                aria-hidden="true"
                className="h-12 animate-pulse rounded-lg bg-muted"
              />
            ))}
          </div>
        ) : state.status === "error" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm">Couldn&apos;t load your sessions.</p>
            <Button variant="outline" size="sm" onClick={retry}>
              Try again
            </Button>
          </div>
        ) : (
          <>
            <ul className="flex flex-col divide-y">
              {state.sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="font-medium break-words">{session.device}</p>
                    <p className="text-sm text-muted-foreground break-words">
                      {formatSessionMeta(session)}
                    </p>
                  </div>
                  {session.isCurrent ? (
                    <Badge variant="secondary">This device</Badge>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Sign out ${session.device}`}
                      disabled={revoking === session.id}
                      onClick={() => void revoke(session)}
                    >
                      {revoking === session.id ? "Signing out…" : "Sign out"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {state.sessions.length === 1 && state.sessions[0].isCurrent ? (
              <p className="mt-3 text-sm text-muted-foreground">
                This is the only device signed in.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
      <CardFooter>
        <Button variant="destructive" onClick={() => setEverywhereOpen(true)}>
          Sign out everywhere
        </Button>
        <SignOutEverywhereDialog
          open={everywhereOpen}
          onOpenChange={setEverywhereOpen}
        />
      </CardFooter>
    </Card>
  );
}
