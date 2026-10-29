"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmEmailStep } from "@/components/admin/transfer/confirm-email-step";
import { RecipientStep } from "@/components/admin/transfer/recipient-step";
import { useReauth } from "@/components/reauth-dialog";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { postTransferAction } from "@/lib/admin/transfer-client";
import {
  REAUTH_DECLINED_COPY,
  emailConfirmed,
  transferErrorCopy,
  type RecipientOption,
} from "@/lib/admin/transfer-view";
import { formatEt } from "@/lib/email/layout";
import { ACCEPTANCE_WINDOW_MS } from "@/lib/jobs/pa-transfer-machine";

type Step = "warning" | "recipient" | "confirm" | "summary";

const STEPS: readonly Step[] = ["warning", "recipient", "confirm", "summary"];

const CONSEQUENCES = [
  "The recipient becomes the only Primary Admin. You stay an admin.",
  "They must accept within 7 days, and may be asked to re-enter their password and code.",
  "After they accept, there is a 24-hour window in which you can cancel, here or from the link we email you.",
  "When it takes effect, you and the recipient are both signed out everywhere.",
];

interface Failure {
  message: string;
  inFlight: boolean;
}

export function TransferWizard({
  options,
}: {
  options: readonly RecipientOption[];
}) {
  const router = useRouter();
  const reauth = useReauth();
  const [step, setStep] = useState<Step>("warning");
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [reviewedAt, setReviewedAt] = useState<Date | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const recipient = options.find((option) => option.id === recipientId) ?? null;
  const stepNumber = STEPS.indexOf(step) + 1;

  function back() {
    setFailure(null);
    setStep(STEPS[STEPS.indexOf(step) - 1]);
  }

  function selectRecipient(id: string) {
    // A typed email belongs to one recipient only.
    if (id !== recipientId) setTyped("");
    setRecipientId(id);
  }

  function next() {
    if (step === "confirm") setReviewedAt(new Date());
    setStep(STEPS[STEPS.indexOf(step) + 1]);
  }

  async function start() {
    if (!recipient) return;
    setPending(true);
    setFailure(null);
    // A stale session prompts for the password and code, then retries once.
    const result = await postTransferAction(
      "/api/sgauth/admin/transfer",
      { recipientUserId: recipient.id, confirmEmail: typed.trim() },
      reauth.fetch,
    );
    setPending(false);

    switch (result.kind) {
      case "ok":
        toast.success(`Transfer to ${recipient.name} started.`);
        router.replace("/admin");
        return;
      case "reauth":
        setFailure({ message: REAUTH_DECLINED_COPY, inFlight: false });
        return;
      case "error":
        setFailure({
          message: transferErrorCopy(result.code, result.reason, "sender"),
          inFlight: result.code === "TRANSFER_IN_FLIGHT",
        });
        return;
      case "unexpected":
        setFailure({
          message: transferErrorCopy("UNEXPECTED", undefined, "sender"),
          inFlight: false,
        });
        return;
    }
  }

  const canContinue =
    step === "warning" ||
    (step === "recipient" && recipient !== null) ||
    (step === "confirm" &&
      recipient !== null &&
      emailConfirmed(typed, recipient.email));

  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <p className="text-sm text-muted-foreground">
          Step {stepNumber} of {STEPS.length}
        </p>
        <CardTitle className="text-xl">Transfer Primary Admin</CardTitle>
        <CardDescription>
          {step === "warning"
            ? "Read this before you continue."
            : "Nothing changes until you start the transfer on the last step."}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {step === "warning" ? (
          <div
            role="note"
            className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm"
          >
            <ul className="flex list-disc flex-col gap-2 pl-5">
              {CONSEQUENCES.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {step === "recipient" ? (
          <RecipientStep
            options={options}
            selectedId={recipientId}
            onSelect={selectRecipient}
          />
        ) : null}

        {step === "confirm" && recipient ? (
          <ConfirmEmailStep
            recipientEmail={recipient.email}
            value={typed}
            onChange={setTyped}
          />
        ) : null}

        {step === "summary" && recipient ? (
          <div className="flex flex-col gap-3">
            <dl className="flex flex-col gap-1 text-sm">
              <dt className="text-muted-foreground">New Primary Admin</dt>
              <dd className="font-medium">{recipient.name}</dd>
              <dd className="break-all text-muted-foreground">
                {recipient.email}
              </dd>
            </dl>
            {reviewedAt ? (
              <p className="text-sm">
                Expires if not accepted by{" "}
                {formatEt(
                  new Date(reviewedAt.getTime() + ACCEPTANCE_WINDOW_MS),
                )}
                .
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              You may be asked for your password and an authentication code when
              you start the transfer.
            </p>
          </div>
        ) : null}

        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure.message}
            {failure.inFlight ? (
              <>
                {" "}
                <Link href="/admin" className="underline underline-offset-3">
                  Go to the dashboard
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap justify-between gap-2">
        {step === "warning" ? (
          <Link href="/admin" className="text-sm underline underline-offset-3">
            Cancel
          </Link>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={back}
            disabled={pending}
          >
            Back
          </Button>
        )}
        {step === "summary" ? (
          <Button type="button" onClick={start} disabled={pending}>
            {pending ? "Starting…" : "Start transfer"}
          </Button>
        ) : (
          <Button type="button" onClick={next} disabled={!canContinue}>
            {step === "warning" ? "I understand, continue" : "Continue"}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
