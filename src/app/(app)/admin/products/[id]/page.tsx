import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireAdmin } from "@/lib/auth/guards";
import { AUDIT_TIME_ZONE } from "@/lib/audit-log";
import { getProductForAdmin, listPositionOptions } from "@/lib/product-admin";
import { DeleteProductDialog } from "../delete-product-dialog";
import { ProductForm } from "../product-form";

export const metadata: Metadata = { title: "Edit product" };

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: AUDIT_TIME_ZONE,
  dateStyle: "medium",
});

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin(`/admin/products/${encodeURIComponent(id)}`);

  const [product, positions] = await Promise.all([
    getProductForAdmin(id),
    listPositionOptions(),
  ]);
  if (!product) notFound();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/admin/products"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Products
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {product.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          Created {dateFormat.format(product.createdAt)}, last updated{" "}
          {dateFormat.format(product.updatedAt)}.
        </p>
      </div>
      <ProductForm mode="update" product={product} positions={positions} />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Danger zone</CardTitle>
          <CardDescription>
            Deleting a product removes it from the registry for good.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteProductDialog product={product} />
        </CardContent>
      </Card>
    </div>
  );
}
