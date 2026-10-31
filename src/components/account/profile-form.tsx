"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { updateProfile } from "@/app/(app)/account/actions";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  profileInputSchema,
  type ProfileFormValues,
  type ProfileInput,
} from "@/lib/account/profile";

const SAVE_FAILED = "Couldn't save your profile. Try again.";

export function ProfileForm({
  email,
  name,
  preferredName,
}: {
  email: string;
  name: string;
  preferredName: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const form = useForm<ProfileFormValues, unknown, ProfileInput>({
    resolver: zodResolver(profileInputSchema),
    defaultValues: { name, preferredName: preferredName ?? "" },
  });

  function onSubmit(values: ProfileInput) {
    startTransition(async () => {
      let result;
      try {
        result = await updateProfile(values);
      } catch {
        toast.error(SAVE_FAILED);
        return;
      }

      if (result.ok) {
        form.reset({
          name: result.profile.name,
          preferredName: result.profile.preferredName ?? "",
        });
        toast.success("Profile saved.");
        return;
      }
      if (result.error === "unauthenticated") {
        window.location.replace("/login");
        return;
      }
      for (const [field, message] of Object.entries(result.fieldErrors)) {
        if (field === "name" || field === "preferredName") {
          form.setError(field, { message });
        }
      }
    });
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        noValidate
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Email</span>
          <span className="break-all text-sm">{email}</span>
          <p className="text-sm text-muted-foreground">
            Your email can&apos;t be changed here. Ask an SGA admin if it&apos;s
            wrong.
          </p>
        </div>

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Full name</FormLabel>
              <FormControl>
                <Input {...field} autoComplete="name" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="preferredName"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Preferred name (optional)</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  value={field.value ?? ""}
                  autoComplete="nickname"
                />
              </FormControl>
              <FormDescription>
                Shown instead of your full name where tools support it.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div>
          <Button type="submit" disabled={pending || !form.formState.isDirty}>
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
