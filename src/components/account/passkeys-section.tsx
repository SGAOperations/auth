"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useReauth } from "@/components/reauth-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PasskeyListItem } from "@/lib/account/passkey-list";
import { authClient } from "@/lib/auth/client";
import {
  MAX_PASSKEYS_PER_USER,
  PASSKEY_NAME_MAX_LENGTH,
} from "@/lib/auth/passkey-policy";
import {
  PASSKEY_COPY,
  addedLabel,
  mapAddPasskeyError,
  mapManagePasskeyError,
  removeConfirmation,
  withReauthRetry,
} from "@/lib/auth/passkey-ui";
import { usePasskeySupport } from "@/lib/auth/use-passkey-support";

interface PasskeysSectionProps {
  passkeys: PasskeyListItem[];
  /** Adds the note that a passkey does not replace the admin TOTP step. */
  isAdmin: boolean;
}

type Dialogue =
  | { kind: "add" }
  | { kind: "rename"; passkey: PasskeyListItem }
  | { kind: "remove"; passkey: PasskeyListItem };

/**
 * The "Passkeys" card of /account/security. Must sit inside `ReauthProvider`:
 * adding and removing are re-auth gated, and a 403 REAUTH_REQUIRED opens its
 * prompt and retries once.
 */
export function PasskeysSection({ passkeys, isAdmin }: PasskeysSectionProps) {
  const router = useRouter();
  const reauth = useReauth();
  const supported = usePasskeySupport();
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const steppedAside = useRef(false);

  const atLimit = passkeys.length >= MAX_PASSKEYS_PER_USER;

  function open(next: Dialogue) {
    setError(null);
    setName(next.kind === "rename" ? (next.passkey.name ?? "") : "");
    setDialogue(next);
  }

  function close() {
    if (!pending) setDialogue(null);
  }

  // The re-auth prompt is a second modal, so this one steps aside for it. Any
  // failure after that is reported as a toast, because there is no dialog left
  // to hold it.
  async function promptReauth() {
    steppedAside.current = true;
    setDialogue(null);
    return reauth.prompt();
  }

  function report(message: string) {
    if (steppedAside.current) toast.error(message);
    else setError(message);
  }

  async function add() {
    const trimmed = name.trim();
    const result = await withReauthRetry(
      () =>
        authClient.passkey.addPasskey(trimmed ? { name: trimmed } : undefined),
      promptReauth,
    );
    if (!result.error) {
      setDialogue(null);
      toast.success(PASSKEY_COPY.added);
      router.refresh();
      return;
    }
    const outcome = mapAddPasskeyError(result.error);
    if (outcome.kind === "message") report(outcome.message);
  }

  async function rename(passkey: PasskeyListItem) {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a name.");
      return;
    }
    const result = await authClient.passkey.updatePasskey({
      id: passkey.id,
      name: trimmed,
    });
    if (result.error) {
      report(PASSKEY_COPY.updateFailed);
      return;
    }
    setDialogue(null);
    toast.success(PASSKEY_COPY.renamed);
    router.refresh();
  }

  async function remove(passkey: PasskeyListItem) {
    const result = await withReauthRetry(
      () => authClient.passkey.deletePasskey({ id: passkey.id }),
      promptReauth,
    );
    if (!result.error) {
      setDialogue(null);
      toast.success(PASSKEY_COPY.removed);
      router.refresh();
      return;
    }
    const outcome = mapManagePasskeyError(result.error);
    if (outcome.kind === "message") report(outcome.message);
  }

  async function submit() {
    if (!dialogue) return;
    steppedAside.current = false;
    setError(null);
    setPending(true);
    try {
      if (dialogue.kind === "add") await add();
      else if (dialogue.kind === "rename") await rename(dialogue.passkey);
      else await remove(dialogue.passkey);
    } catch {
      report(
        dialogue.kind === "add"
          ? PASSKEY_COPY.addFailed
          : PASSKEY_COPY.updateFailed,
      );
    } finally {
      setPending(false);
    }
  }

  const nameField = (
    <div className="grid gap-2">
      <Label htmlFor="passkey-name">Name (optional)</Label>
      <Input
        id="passkey-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={PASSKEY_NAME_MAX_LENGTH}
        placeholder="e.g. MacBook Touch ID"
        autoComplete="off"
        autoFocus
        disabled={pending}
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Passkeys</CardTitle>
        <CardDescription>{PASSKEY_COPY.cardDescription}</CardDescription>
        {isAdmin ? (
          <CardDescription>{PASSKEY_COPY.adminNote}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{PASSKEY_COPY.empty}</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {passkeys.map((passkey) => (
              <li
                key={passkey.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium break-words">
                    {passkey.name ?? PASSKEY_COPY.unnamed}
                    {passkey.backedUp ? (
                      <Badge variant="secondary">{PASSKEY_COPY.synced}</Badge>
                    ) : null}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {addedLabel(passkey.createdAt)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Rename ${passkey.name ?? PASSKEY_COPY.unnamed}`}
                    onClick={() => open({ kind: "rename", passkey })}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Remove ${passkey.name ?? PASSKEY_COPY.unnamed}`}
                    onClick={() => open({ kind: "remove", passkey })}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {!supported ? (
          <p className="text-sm text-muted-foreground">
            {PASSKEY_COPY.unsupported}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <Button
              disabled={atLimit}
              variant={passkeys.length === 0 ? "default" : "outline"}
              onClick={() => open({ kind: "add" })}
            >
              <KeyRound aria-hidden="true" />
              Add a passkey
            </Button>
            {atLimit ? (
              <p className="text-sm text-muted-foreground">
                {PASSKEY_COPY.limitReached}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>

      <Dialog
        open={dialogue !== null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent showCloseButton={false}>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {dialogue?.kind === "rename"
                  ? "Rename passkey"
                  : dialogue?.kind === "remove"
                    ? "Remove passkey"
                    : "Add a passkey"}
              </DialogTitle>
              {dialogue?.kind === "remove" ? (
                <DialogDescription>
                  {removeConfirmation(dialogue.passkey.name)}
                </DialogDescription>
              ) : null}
            </DialogHeader>

            {dialogue && dialogue.kind !== "remove" ? nameField : null}

            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={close}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={
                  dialogue?.kind === "remove" ? "destructive" : "default"
                }
                disabled={pending}
              >
                {dialogue?.kind === "remove"
                  ? pending
                    ? "Removing…"
                    : "Remove passkey"
                  : dialogue?.kind === "rename"
                    ? pending
                      ? "Saving…"
                      : "Save"
                    : pending
                      ? "Waiting for your passkey…"
                      : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
