"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  PRODUCT_FORM_DEFAULTS,
  fieldMessages,
  productFormResolver,
  productToFormValues,
  suggestProductSlug,
  toProductPayload,
  type ProductFormMode,
  type ProductFormValues,
} from "@/lib/product-form";
import {
  createProduct,
  updateProduct,
  type ProductActionFailure,
} from "./actions";

export interface ProductFormProduct {
  id: string;
  slug: string;
  name: string;
  description: string;
  baseUrl: string;
  iconUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  visibleToPositionKeys: string[];
  loginRedirectPath: string | null;
}

export interface ProductFormPosition {
  key: string;
  name: string;
  category: string | null;
}

const UNCATEGORIZED = "Uncategorized";

const FAILURE_COPY: Record<
  Exclude<ProductActionFailure["code"], "INVALID_INPUT" | "SLUG_TAKEN">,
  string
> = {
  RATE_LIMITED: "Too many changes. Try again in a minute.",
  FORBIDDEN: "You don't have permission to do that.",
  NOT_FOUND: "This product no longer exists.",
  ACTIVE_PRODUCT: "Deactivate this product before deleting it.",
  CONFIRMATION_MISMATCH: "The slug you typed doesn't match.",
};

const UNEXPECTED_COPY = "Something went wrong. Try again.";

function groupByCategory(positions: readonly ProductFormPosition[]) {
  const groups = new Map<string, ProductFormPosition[]>();
  for (const position of positions) {
    const category = position.category ?? UNCATEGORIZED;
    groups.set(category, [...(groups.get(category) ?? []), position]);
  }
  return [...groups.entries()];
}

export function ProductForm({
  mode,
  product,
  positions,
}: {
  mode: ProductFormMode;
  product?: ProductFormProduct;
  positions: readonly ProductFormPosition[];
}) {
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const slugTouched = useRef(false);

  const form = useForm<ProductFormValues>({
    resolver: productFormResolver(mode),
    defaultValues: product
      ? productToFormValues(product)
      : PRODUCT_FORM_DEFAULTS,
  });
  const { isSubmitting } = form.formState;

  const known = useMemo(
    () => new Set(positions.map((position) => position.key)),
    [positions],
  );
  const visibleKeys = useWatch({
    control: form.control,
    name: "visibleToPositionKeys",
  });
  const unknownKeys = visibleKeys.filter((key) => !known.has(key));
  const baseUrl = useWatch({ control: form.control, name: "baseUrl" });
  const urlChangesActiveProduct =
    mode === "update" && product?.isActive && baseUrl !== product.baseUrl;

  const needle = filter.trim().toLowerCase();
  const groups = groupByCategory(
    positions.filter(
      (position) =>
        needle === "" ||
        position.name.toLowerCase().includes(needle) ||
        position.key.includes(needle),
    ),
  );

  function toggleKey(key: string, checked: boolean) {
    const next = checked
      ? [...visibleKeys, key]
      : visibleKeys.filter((entry) => entry !== key);
    form.setValue("visibleToPositionKeys", next, { shouldDirty: true });
  }

  async function onSubmit(values: ProductFormValues) {
    const payload = toProductPayload(values, mode);
    let result;
    try {
      result =
        mode === "create" || !product
          ? await createProduct(payload)
          : await updateProduct(product.id, payload);
    } catch {
      toast.error(UNEXPECTED_COPY);
      return;
    }

    if (!result.ok) {
      if (result.code === "INVALID_INPUT") {
        for (const [field, message] of fieldMessages(result.fieldErrors)) {
          form.setError(field, { message });
        }
        return;
      }
      if (result.code === "SLUG_TAKEN") {
        form.setError("slug", { message: "That slug is already taken." });
        return;
      }
      toast.error(FAILURE_COPY[result.code]);
      return;
    }

    if (mode === "create" && result.id) {
      toast.success("Product created.");
      router.push(`/admin/products/${result.id}`);
      return;
    }
    toast.success(result.unchanged ? "No changes to save." : "Changes saved.");
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        noValidate
        className="flex max-w-2xl flex-col gap-5"
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  maxLength={100}
                  onChange={(event) => {
                    field.onChange(event);
                    if (mode === "create" && !slugTouched.current) {
                      form.setValue(
                        "slug",
                        suggestProductSlug(event.target.value),
                      );
                    }
                  }}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="slug"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Slug</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  maxLength={64}
                  readOnly={mode === "update"}
                  className="font-mono"
                  onChange={(event) => {
                    slugTouched.current = true;
                    field.onChange(event);
                  }}
                />
              </FormControl>
              <FormDescription>
                {mode === "create"
                  ? "Used in product role names. It can't be changed after you save."
                  : "Slugs are permanent. Product roles are prefixed with it."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="baseUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Base URL</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="url"
                  maxLength={253}
                  autoComplete="off"
                  className="font-mono"
                />
              </FormControl>
              <FormDescription>
                https://&lt;name&gt;.northeasternsga.com, with no path or
                trailing slash.
              </FormDescription>
              {urlChangesActiveProduct ? (
                <p role="status" className="text-sm text-amber-600">
                  Saving stops trusting the old origin. Sign-ins and redirects
                  from it will fail within 60 seconds.
                </p>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Description</FormLabel>
              <FormControl>
                <Textarea {...field} maxLength={500} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="iconUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Icon URL (optional)</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="url"
                  maxLength={2048}
                  autoComplete="off"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="isActive"
          render={({ field }) => (
            <FormItem>
              <div className="flex items-center gap-3">
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <FormLabel>Active</FormLabel>
              </div>
              <FormDescription>
                Inactive products are not trusted and are hidden from account
                pages.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="sortOrder"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Sort order</FormLabel>
              <FormControl>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={10000}
                  name={field.name}
                  ref={field.ref}
                  onBlur={field.onBlur}
                  value={Number.isNaN(field.value) ? "" : field.value}
                  onChange={(event) =>
                    field.onChange(event.target.valueAsNumber)
                  }
                />
              </FormControl>
              <FormDescription>Lower numbers appear first.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="visibleToPositionKeys"
          render={() => (
            <FormItem>
              <FormLabel>Visible to</FormLabel>
              <Input
                type="search"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter positions"
                aria-label="Filter positions"
              />
              <div className="max-h-64 overflow-y-auto rounded-lg border p-3">
                {groups.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No positions match.
                  </p>
                ) : (
                  groups.map(([category, entries]) => (
                    <fieldset key={category} className="mb-3 last:mb-0">
                      <legend className="mb-1 text-xs font-medium text-muted-foreground">
                        {category}
                      </legend>
                      <div className="flex flex-col gap-1">
                        {entries.map((position) => (
                          <label
                            key={position.key}
                            className="flex items-center gap-2 text-sm"
                          >
                            <Checkbox
                              checked={visibleKeys.includes(position.key)}
                              onCheckedChange={(checked) =>
                                toggleKey(position.key, checked)
                              }
                            />
                            {position.name}
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))
                )}
              </div>
              {unknownKeys.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {unknownKeys.map((key) => (
                    <Badge key={key} variant="outline" className="font-mono">
                      {key} · Unknown position
                      <button
                        type="button"
                        aria-label={`Remove ${key}`}
                        className="ml-1 underline-offset-2 hover:underline"
                        onClick={() => toggleKey(key, false)}
                      >
                        ×
                      </button>
                    </Badge>
                  ))}
                </div>
              ) : null}
              <FormDescription>
                Leave everything unchecked to show this product to everyone.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="loginRedirectPath"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Post-login path (optional)</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  maxLength={512}
                  autoComplete="off"
                  className="font-mono"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? "Saving…"
              : mode === "create"
                ? "Create product"
                : "Save changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
