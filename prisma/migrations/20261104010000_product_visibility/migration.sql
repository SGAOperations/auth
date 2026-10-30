-- Adds Product."visibility", the gate for who sees a product on account pages.
-- The enum and column are written by hand to match what `prisma migrate diff`
-- generates for prisma/schema.prisma. The CHECK cannot be expressed in the Prisma schema.
-- Expand-only: the column has a default, so the code that is deployed while this
-- runs keeps working (docs/MIGRATIONS.md).

-- CreateEnum
CREATE TYPE "ProductVisibility" AS ENUM ('EVERYONE', 'LEADERSHIP', 'POSITIONS', 'UNSET');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "visibility" "ProductVisibility" NOT NULL DEFAULT 'UNSET';

-- Keep today's behaviour: a product with position keys is visible to those
-- positions, and one without keys is visible to everyone.
UPDATE "Product" SET "visibility" = CASE WHEN coalesce(cardinality("visibleToPositionKeys"), 0) > 0 THEN 'POSITIONS'::"ProductVisibility" ELSE 'EVERYONE'::"ProductVisibility" END;

-- Backstops (not expressible in the Prisma schema).
-- Position keys apply only under POSITIONS, and POSITIONS needs at least one.
-- Defence in depth; the service layer validates first.
ALTER TABLE "Product" ADD CONSTRAINT "Product_visibility_keys_check"
  CHECK (("visibility" = 'POSITIONS') = (coalesce(cardinality("visibleToPositionKeys"), 0) > 0));
