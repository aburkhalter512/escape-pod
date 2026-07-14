import { PrismaClient } from '@prisma/client'

// Points at the dedicated test database (see scripts/test-db-setup.sh),
// not the regular dev DATABASE_URL — running integration tests must never
// be able to touch real dev data, even by accident.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/draft_pod_test'

export function createIntegrationPrisma(): PrismaClient {
  return new PrismaClient({ datasourceUrl: TEST_DATABASE_URL })
}

// Run between every integration test so each one starts from a clean
// slate. TRUNCATE rather than per-test transaction rollback: Prisma's
// interactive transactions don't compose well with services/*.ts
// functions that open their own transactions/updateMany calls internally
// (tasks/001's atomic claim in particular), so nesting the whole test
// inside one more transaction would change the exact concurrency
// behavior under test. CASCADE handles the FK dependency order
// automatically; RESTART IDENTITY is mostly hygiene here since this
// schema keys everything off cuid/text ids, not serials.
//
// This is the one deliberate exception to "integration tests never touch
// the database directly" (see testUtils/integrationBackend.ts's doc
// comment): resetting between tests is pure infrastructure/hygiene, not
// a test standing in for a real user action or reading state a real API
// call could have told it. No test file should call `prisma.<model>.*`
// itself beyond this function and $disconnect — everything else goes
// through BackendClient or a job-wrapper function instead.
export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "pod_round_signups",
      "pod_round_targets",
      "pod_rounds",
      "guild_organizer_allowlist",
      "guild_subscriptions",
      "organizers"
    RESTART IDENTITY CASCADE
  `)
}
