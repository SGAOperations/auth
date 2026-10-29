"use client";

import { LockIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { positionNameSchema } from "@/lib/position-key";
import { positionFailureToast } from "@/lib/position-view";
import { DeletePositionDialog } from "./delete-position-dialog";
import { updatePosition } from "./positions-api";

export interface EditablePosition {
  id: string;
  key: string;
  name: string;
  category: string | null;
  description: string | null;
}

export const KEY_LOCKED_COPY =
  "The key can't be changed. Products check it to grant access, so changing it would break their permissions without warning. To use a different key, create a new position and reassign its holders.";

export function EditPositionForm({
  position,
  categories,
}: {
  position: EditablePosition;
  categories: readonly string[];
}) {
  const router = useRouter();
  const id = useId();
  const [name, setName] = useState(position.name);
  const [category, setCategory] = useState(position.category ?? "");
  const [description, setDescription] = useState(position.description ?? "");
  const [pending, setPending] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const dirty =
    name.trim() !== position.name ||
    category.trim() !== (position.category ?? "") ||
    description.trim() !== (position.description ?? "");
  const valid = positionNameSchema.safeParse(name).success;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || !valid || pending) return;
    setPending(true);
    const trimmedName = name.trim();
    const result = await updatePosition(position.id, {
      name: trimmedName,
      category: category.trim(),
      description: description.trim(),
    });
    setPending(false);

    if (result.ok) {
      toast.success(`Saved changes to ${trimmedName}.`);
      router.refresh();
      return;
    }
    const failure = positionFailureToast(result);
    toast.error(failure.message);
    if (failure.refresh) router.refresh();
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={100}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <LockIcon aria-hidden="true" className="size-3.5" />
            Key
          </span>
          <code className="w-fit rounded-md bg-muted px-2 py-1 font-mono text-sm break-all">
            {position.key}
          </code>
          <p className="text-xs text-muted-foreground">{KEY_LOCKED_COPY}</p>
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

        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!dirty || !valid || pending}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
          <Link
            href="/admin/positions"
            className={buttonVariants({ variant: "outline" })}
          >
            Cancel
          </Link>
        </div>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Delete this position</CardTitle>
          <CardDescription>
            Holders lose it right away and its key is retired for a year.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="destructive"
            className="w-fit"
            onClick={() => setDeleting(true)}
          >
            Delete position
          </Button>
        </CardContent>
      </Card>

      <DeletePositionDialog
        position={deleting ? position : null}
        onOpenChange={setDeleting}
        onDeleted={() => router.push("/admin/positions/deleted")}
        onStale={() => router.refresh()}
      />
    </div>
  );
}
