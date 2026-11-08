"use client";

import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function CopyRequestButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied.");
    } catch {
      toast.error("Copy failed. Select the text and copy it.");
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      onClick={copy}
    >
      Copy
    </Button>
  );
}
