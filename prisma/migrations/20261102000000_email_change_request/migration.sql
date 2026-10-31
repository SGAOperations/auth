-- AUTH-T24: admin-initiated email change, pending until the new mailbox confirms.

-- CreateTable
CREATE TABLE "EmailChangeRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "newEmail" CITEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailChangeRequest_tokenHash_key" ON "EmailChangeRequest"("tokenHash");

-- CreateIndex
CREATE INDEX "EmailChangeRequest_userId_idx" ON "EmailChangeRequest"("userId");

-- CreateIndex
CREATE INDEX "EmailChangeRequest_expiresAt_idx" ON "EmailChangeRequest"("expiresAt");

-- AddForeignKey
ALTER TABLE "EmailChangeRequest" ADD CONSTRAINT "EmailChangeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Database backstop: a token is only ever stored as a lower-case hex SHA-256.
ALTER TABLE "EmailChangeRequest" ADD CONSTRAINT "EmailChangeRequest_tokenHash_sha256_hex" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

-- At most one open request per user. An expired request that was never
-- consumed or cancelled still counts as open, so a new request cancels it first.
CREATE UNIQUE INDEX "EmailChangeRequest_userId_open_key" ON "EmailChangeRequest"("userId") WHERE "consumedAt" IS NULL AND "cancelledAt" IS NULL;
