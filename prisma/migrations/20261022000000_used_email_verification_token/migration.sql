-- AUTH-T103: single-use record for email-verification links.

-- CreateTable
CREATE TABLE "UsedEmailVerificationToken" (
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsedEmailVerificationToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE INDEX "UsedEmailVerificationToken_expiresAt_idx" ON "UsedEmailVerificationToken"("expiresAt");

-- Database backstop, as on "UnlockToken": only a SHA-256 hex digest is stored,
-- never a raw token. Prisma does not model CHECK constraints.
ALTER TABLE "UsedEmailVerificationToken" ADD CONSTRAINT "UsedEmailVerificationToken_tokenHash_sha256_hex" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
