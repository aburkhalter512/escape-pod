-- AlterEnum
-- Split into its own migration file, separate from the chat_channel_id
-- column addition that follows it: Postgres does not allow
-- `ALTER TYPE ... ADD VALUE` to run inside the same transaction as other
-- DDL statements on older Postgres versions (the new enum value isn't
-- visible until the transaction commits), so this stays its own migration.
ALTER TYPE "PodRoundStatus" ADD VALUE 'CONCLUDED';
