"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { deleteProduct } from "./actions";

const FAILURE_COPY: Record<string, string> = {
  CONFIRMATION_MISMATCH: "The slug you typed doesn't match.",
  ACTIVE_PRODUCT: "Deactivate this product before deleting it.",
  NOT_FOUND: "This product no longer exists.",
  RATE_LIMITED: "Too many changes. Try again in a minute.",
  FORBIDDEN: "You don't have permission to do that.",
};

export function DeleteProductDialog({
  product,
}: {
  product: { id: string; name: string; slug: string; isActive: boolean };
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setTyped("");
      setError(null);
    }
  }

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      // On success the action redirects to the list, so a result is a failure.
      const result = await deleteProduct(product.id, typed);
      if (!result.ok) {
        setError(
          FAILURE_COPY[result.code] ?? "Something went wrong. Try again.",
        );
      }
    } catch {
      toast.error("Something went wrong. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogTrigger
          render={
            <Button
              variant="destructive"
              className="w-fit"
              disabled={product.isActive}
            />
          }
        >
          Delete product
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {product.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the product. Its audit history is kept.
              Type <strong>{product.slug}</strong> to confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-label="Type the product slug to confirm"
            autoComplete="off"
            className="font-mono"
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={typed !== product.slug || pending}
              onClick={confirm}
            >
              {pending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {product.isActive ? (
        <p className="text-sm text-muted-foreground">
          Deactivate this product before deleting it.
        </p>
      ) : null}
    </div>
  );
}
