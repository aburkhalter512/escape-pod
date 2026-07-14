-- AlterTable
ALTER TABLE "organizers" ADD COLUMN     "next_round_number" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
-- Nullable for now — existing rows need backfilling below before this can
-- become required.
ALTER TABLE "pod_rounds" ADD COLUMN     "organizer_round_number" INTEGER;

-- Backfill existing rounds: number each organizer's rounds 1..N in
-- creation order, matching the semantics startPod uses for new rounds.
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY organizer_discord_id ORDER BY created_at ASC
  ) AS rn
  FROM "pod_rounds"
)
UPDATE "pod_rounds" p
SET organizer_round_number = numbered.rn
FROM numbered
WHERE p.id = numbered.id;

-- Now that every existing row has a value, the column can be required.
ALTER TABLE "pod_rounds" ALTER COLUMN "organizer_round_number" SET NOT NULL;

-- Seed each organizer's next number past their backfilled max, so the
-- next /start-pod continues the sequence instead of colliding with the
-- unique constraint below. Organizers with no existing rounds keep the
-- column default of 1.
UPDATE "organizers" o
SET next_round_number = sub.max_round + 1
FROM (
  SELECT organizer_discord_id, MAX(organizer_round_number) AS max_round
  FROM "pod_rounds"
  GROUP BY organizer_discord_id
) sub
WHERE o.discord_id = sub.organizer_discord_id;

-- AddUniqueConstraint
CREATE UNIQUE INDEX "pod_rounds_organizer_discord_id_organizer_round_number_key" ON "pod_rounds"("organizer_discord_id", "organizer_round_number");
