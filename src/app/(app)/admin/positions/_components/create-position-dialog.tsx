"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  positionKeyIssue,
  positionNameSchema,
  suggestPositionKey,
} from "@/lib/position-key";
import {
  isKeyErrorCode,
  positionErrorMessage,
  positionFailureToast,
} from "@/lib/position-view";
import { PositionKeyField } from "./position-key-field";
import { createPosition } from "./positions-api";

export function CreatePositionDialog({
  categories,
}: {
  categories: readonly string[];
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [keyEdited, setKeyEdited] = useState(false);
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const suggested = suggestPositionKey(name);
  const valid =
    positionNameSchema.safeParse(name).success &&
    positionKeyIssue(key) === null;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setKey("");
      setKeyEdited(false);
      setCategory("");
      setDescription("");
      setKeyError(null);
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    setKeyError(null);
    const trimmedName = name.trim();
    const result = await createPosition({
      key,
      name: trimmedName,
      category: category.trim(),
      description: description.trim(),
    });
    setPending(false);

    if (result.ok) {
      toast.success(`Created ${trimmedName}.`);
      onOpenChange(false);
      router.refresh();
      return;
    }
    if (isKeyErrorCode(result.code)) {
      setKeyError(positionErrorMessage(result.code));
      return;
    }
    const failure = positionFailureToast(result);
    toast.error(failure.message);
    if (failure.refresh) router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button />}>New position</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New position</DialogTitle>
          <DialogDescription>
            Products check a position&apos;s key to grant access.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              value={name}
              maxLength={100}
              autoComplete="off"
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                if (!keyEdited) {
                  setKey(suggestPositionKey(next));
                  setKeyError(null);
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-1">
            <PositionKeyField
              value={key}
              serverError={keyError}
              onChange={(next) => {
                setKey(next);
                setKeyEdited(true);
                setKeyError(null);
              }}
            />
            {keyEdited && key !== suggested ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="w-fit px-0"
                onClick={() => {
                  setKey(suggested);
                  setKeyEdited(false);
                  setKeyError(null);
                }}
              >
                Use suggested key
              </Button>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-category`}>Category (optional)</Label>
            <Input
              id={`${id}-category`}
              list={`${id}-categories`}
              value={category}
              maxLength={100}
              autoComplete="off"
              onChange={(event) => setCategory(event.target.value)}
            />
            <datalist id={`${id}-categories`}>
              {categories.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">
              Groups positions in this list.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`${id}-description`}>Description (optional)</Label>
            <Textarea
              id={`${id}-description`}
              value={description}
              maxLength={1000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || pending}>
              {pending ? "Creating…" : "Create position"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
