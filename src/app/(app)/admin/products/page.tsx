import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/guards";
import { listProductsForAdmin } from "@/lib/product-admin";
import { visibilitySummary } from "@/lib/product-visibility";
import { getTrustedOrigins, isAllowedRedirect } from "@/lib/products";

export const metadata: Metadata = { title: "Products" };

const PATH = "/admin/products";

function OriginList({
  title,
  entries,
}: {
  title: string;
  entries: ReadonlyArray<{ text: string; source: string }>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <li
            key={entry.text}
            className="flex flex-wrap items-baseline gap-x-3 text-sm"
          >
            <code className="font-mono break-all">{entry.text}</code>
            <span className="text-muted-foreground">{entry.source}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default async function ProductsPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin(PATH);

  const [products, origins] = await Promise.all([
    listProductsForAdmin(),
    getTrustedOrigins(),
  ]);

  const productByOrigin = new Map(
    products.map((product) => [product.baseUrl, product.name]),
  );
  const sourceOf = (origin: string) => {
    const name = productByOrigin.get(origin);
    return name ? `Product · ${name}` : "SGAuth / environment";
  };
  const originEntries = origins.map((origin) => ({
    text: origin,
    source: sourceOf(origin),
  }));
  const redirectOrigins: string[] = [];
  for (const origin of origins) {
    if (await isAllowedRedirect(`${origin}/`)) redirectOrigins.push(origin);
  }
  const redirectEntries = redirectOrigins.map((origin) => ({
    text: `${origin}/…`,
    source: sourceOf(origin),
  }));
  const hasProductOrigin = origins.some((origin) =>
    productByOrigin.has(origin),
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-muted-foreground">
            Products listed here are trusted for sign-in and appear on account
            pages for the people allowed to see them.
          </p>
        </div>
        <Link href={`${PATH}/new`} className={buttonVariants()}>
          Add product
        </Link>
      </div>

      {products.length === 0 ? (
        <div className="flex flex-col items-start gap-3 text-muted-foreground">
          <p>
            No products yet. Add one to trust its origin and list it on account
            pages.
          </p>
          <Link href={`${PATH}/new`} className={buttonVariants()}>
            Add product
          </Link>
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Base URL</TableHead>
              <TableHead>Visible to</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Trusted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {products.map((product) => {
              const trusted = origins.includes(product.baseUrl);
              return (
                <TableRow key={product.id}>
                  <TableCell>
                    <Link
                      href={`${PATH}/${product.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {product.name}
                    </Link>
                    <div className="font-mono text-xs text-muted-foreground">
                      {product.slug}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs break-all whitespace-normal">
                    {product.baseUrl}
                  </TableCell>
                  <TableCell>
                    {product.visibility === "UNSET" ? (
                      <span className="text-muted-foreground">
                        {visibilitySummary(product)}
                      </span>
                    ) : (
                      visibilitySummary(product)
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={product.isActive ? "default" : "secondary"}>
                      {product.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {trusted ? "Yes" : product.isActive ? "Not yet" : "—"}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <Card>
        <CardHeader>
          <CardTitle>What the registry allows</CardTitle>
          <CardDescription>
            Live from this server. Other servers pick up changes within 60
            seconds.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <OriginList title="Trusted origins" entries={originEntries} />
          <OriginList title="Redirect targets" entries={redirectEntries} />
          {hasProductOrigin ? null : (
            <p className="text-sm text-muted-foreground">
              Only SGAuth&apos;s own origin is trusted. Activate a product to
              trust its origin.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
