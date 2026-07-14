-- AlterTable
ALTER TABLE "pod_rounds" ADD COLUMN     "threshold_reached_at" TIMESTAMP(3);
ALTER TABLE "pod_rounds" ADD COLUMN     "fire_failure_notified" BOOLEAN NOT NULL DEFAULT false;
