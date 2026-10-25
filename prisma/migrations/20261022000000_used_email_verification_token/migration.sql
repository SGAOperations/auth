-- Single-use record for email-verification links.

-- CreateTable
CREATE TABLE "UsedEmailVerificationToken" (
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsedEmailVerificationToken_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateIndex
CREATE INDEX "UsedEmailVerificationToken_expiresAt_idx" ON "UsedEmailVerificationToken"("expiresAt");

-- Only a SHA-256 hex digest is stored, never a raw token.
ALTER TABLE "UsedEmailVerificationToken" ADD CONSTRAINT "UsedEmailVerificationToken_tokenHash_sha256_hex" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
