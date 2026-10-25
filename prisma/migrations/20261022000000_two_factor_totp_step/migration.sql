-- AUTH-T67: per-user last accepted TOTP step, for replay rejection.
-- AlterTable
ALTER TABLE "TwoFactor" ADD COLUMN "lastTotpStep" INTEGER;
