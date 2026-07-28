import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as organizersService from '../services/organizers.js'
import type { AppPrismaClient } from '../prismaClient.js'
import { createPrismaAppStorage } from '../storage/prismaAppStorage.js'
import type { PtpClient } from '../ptp/client.js'
import { httpStatusForError } from '../services/errors.js'

// Kept as a real AppPrismaClient shape (not services/organizers.js's
// OrganizerServiceDeps directly) so app.ts never needs to change what
// it constructs/passes in — services/*.ts depends on the shared
// AppStorage contract (storage/appStorage.ts); the adaptation from a
// real Prisma client happens once inside registerOrganizerRoutes below,
// same pattern as backendClient.ts's LocalBackendClient.
export interface OrganizerRouteDeps {
  prisma: AppPrismaClient
  ptp: PtpClient
  tokenEncryptionKey: string
}

const linkOrganizerBodySchema = z.object({
  discordId: z.string().min(1),
  token: z.string().min(1),
})
type LinkOrganizerBody = z.infer<typeof linkOrganizerBodySchema>

export function registerOrganizerRoutes(app: FastifyInstance, deps: OrganizerRouteDeps): void {
  const serviceDeps = { storage: createPrismaAppStorage(deps.prisma), ptp: deps.ptp, tokenEncryptionKey: deps.tokenEncryptionKey }

  app.post<{ Body: LinkOrganizerBody }>(
    '/organizers/link',
    { schema: { body: linkOrganizerBodySchema } },
    async (request, reply) => {
      const result = await organizersService.linkOrganizer(serviceDeps, request.body)
      if (!result.ok) {
        return reply.code(httpStatusForError(result.error)).send({ error: result.error.message })
      }
      return reply.send(result.value)
    }
  )
}
