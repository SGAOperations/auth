-- Expand-only: the new column is nullable. Retention (AUTH-T78) records here
-- when it sent the 11-month inactivity notice.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "inactivityNoticeSentAt" TIMESTAMP(3);
