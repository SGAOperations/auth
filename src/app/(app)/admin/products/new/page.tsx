import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guards";
import { listPositionOptions } from "@/lib/product-admin";
import { ProductForm } from "../product-form";

export const metadata: Metadata = { title: "Add product" };

export default async function NewProductPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin("/admin/products/new");
  const positions = await listPositionOptions();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link
          href="/admin/products"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Products
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Add product</h1>
      </div>
      <ProductForm mode="create" positions={positions} />
    </div>
  );
}
