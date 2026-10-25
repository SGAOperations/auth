-- AUTH-T64: per-device failure counter for the known-device lockout exemption.
-- Expand-only: every new column is nullable or has a default.

-- AlterTable
ALTER TABLE "KnownDevice" ADD COLUMN     "failedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3),
ADD COLUMN     "windowStartedAt" TIMESTAMP(3);

-- Database backstop: a device token is only ever stored as a lower-case hex SHA-256.
ALTER TABLE "KnownDevice" ADD CONSTRAINT "KnownDevice_tokenHash_sha256_hex" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- Database backstop: the counter never goes negative.
ALTER TABLE "KnownDevice" ADD CONSTRAINT "KnownDevice_failedCount_nonnegative" CHECK ("failedCount" >= 0);
