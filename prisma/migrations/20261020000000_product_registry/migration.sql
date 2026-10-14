-- AUTH-T14: product registry. CHECKs and the slug trigger are hand-written; Prisma does not model them, so they do not drift.

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "baseUrl" TEXT NOT NULL,
    "iconUrl" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "visibleToPositionKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "loginRedirectPath" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE INDEX "Product_isActive_sortOrder_idx" ON "Product"("isActive", "sortOrder");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Product" ADD CONSTRAINT "Product_slug_check"
  CHECK (char_length("slug") BETWEEN 2 AND 64 AND "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "Product" ADD CONSTRAINT "Product_baseUrl_check"
  CHECK (char_length("baseUrl") <= 253
    AND "baseUrl" ~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+northeasternsga\.com$');

ALTER TABLE "Product" ADD CONSTRAINT "Product_iconUrl_check"
  CHECK ("iconUrl" IS NULL OR (char_length("iconUrl") <= 2048 AND "iconUrl" ~ '^https://[^[:space:]]+$'));

ALTER TABLE "Product" ADD CONSTRAINT "Product_loginRedirectPath_check"
  CHECK ("loginRedirectPath" IS NULL OR (char_length("loginRedirectPath") <= 512
    AND "loginRedirectPath" ~ '^/([^/\\[:space:]][^\\[:space:]]*)?$'));

CREATE FUNCTION product_slug_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."slug" IS DISTINCT FROM OLD."slug" THEN
    RAISE EXCEPTION 'product_slug_immutable: Product.slug cannot change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER product_slug_immutable BEFORE UPDATE OF "slug" ON "Product"
  FOR EACH ROW EXECUTE FUNCTION product_slug_immutable();
