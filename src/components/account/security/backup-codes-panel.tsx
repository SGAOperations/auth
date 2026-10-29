"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  BACKUP_CODES_FILE_NAME,
  backupCodesFileText,
} from "@/lib/account/security-ui";

interface BackupCodesPanelProps {
  codes: readonly string[];
  email: string;
  mode: "enrolled" | "regenerated";
  /** The owner drops the codes from state, which unmounts the panel. */
  onDone: () => void;
}

type CopyState = "idle" | "copied" | "failed";

// The codes live only in this component's props and state: the server keeps
// hashes and cannot return them again. That is what "shown once" means.
export function BackupCodesPanel({
  codes,
  email,
  mode,
  onDone,
}: BackupCodesPanelProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const heading = useRef<HTMLHeadingElement>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  // Mounted only while the codes are unsaved, so leaving the page loses them.
  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copyAll() {
    let next: CopyState = "copied";
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
    } catch {
      next = "failed";
    }
    setCopyState(next);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopyState("idle"), 2000);
  }

  function download() {
    const text = backupCodesFileText(codes, { email, generatedAt: new Date() });
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = BACKUP_CODES_FILE_NAME;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3
          ref={heading}
          tabIndex={-1}
          className="text-base font-medium outline-none"
        >
          {mode === "enrolled"
            ? "Two-factor authentication is on. Save your backup codes"
            : "Your new backup codes"}
        </h3>
        <p className="text-sm text-muted-foreground">
          Each code works once if you lose access to your authenticator app.
          This is the only time you&apos;ll see them.
        </p>
      </div>
      <ul
        aria-label="Backup codes"
        className="grid grid-cols-1 gap-x-6 gap-y-1 rounded-lg border bg-muted/40 p-4 font-mono text-sm sm:grid-cols-2"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={copyAll}>
          Copy all
        </Button>
        <Button type="button" variant="outline" onClick={download}>
          Download
        </Button>
        <span role="status" className="text-sm text-muted-foreground">
          {copyState === "copied" ? "Copied" : null}
          {copyState === "failed"
            ? "Copy failed. Select the codes and copy them yourself."
            : null}
        </span>
      </div>
      <Button
        type="button"
        className="w-full sm:w-auto sm:self-start"
        onClick={onDone}
      >
        I&apos;ve saved my codes
      </Button>
    </div>
  );
}
