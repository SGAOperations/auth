-- AUTH-T77: security alert state and operational signals.

-- CreateTable
CREATE TABLE "OpsSignal" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertState" (
    "ruleKey" TEXT NOT NULL,
    "lastSentAt" TIMESTAMP(3),
    "coveredThrough" TIMESTAMP(3),

    CONSTRAINT "AlertState_pkey" PRIMARY KEY ("ruleKey")
);

-- CreateIndex
CREATE INDEX "OpsSignal_kind_createdAt_idx" ON "OpsSignal"("kind", "createdAt");
