import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as organizersService from '../services/organizers.js'
import type { OrganizerServiceDeps } from '../services/organizers.js'
import { httpStatusForError } from '../services/errors.js'

export type OrganizerRouteDeps = OrganizerServiceDeps

const linkOrganizerBodySchema = z.object({
  discordId: z.string().min(1),
  token: z.string().min(1),
})
type LinkOrganizerBody = z.infer<typeof linkOrganizerBodySchema>

// Eligibility is origin-guild-scoped, not organizer-scoped — see
// services/organizers.ts's listEligibleGuilds. The path itself is still
// under /organizers for now (a full move to routes/guilds.ts, where it
// semantically belongs, is a follow-up); this rename only fixes the
// param's misleading name, since it was silently being fed to a
// function that now treats it as a guild id, not an organizer id.
const eligibleGuildsParamsSchema = z.object({
  originGuildId: z.string().min(1),
})
type EligibleGuildsParams = z.infer<typeof eligibleGuildsParamsSchema>

export function registerOrganizerRoutes(app: FastifyInstance, deps: OrganizerRouteDeps): void {
  app.post<{ Body: LinkOrganizerBody }>(
    '/organizers/link',
    { schema: { body: linkOrganizerBodySchema } },
    async (request, reply) => {
      const result = await organizersService.linkOrganizer(deps, request.body)
      if (!result.ok) {
        return reply.code(httpStatusForError(result.error)).send({ error: result.error.message })
      }
      return reply.send(result.value)
    }
  )

  app.get<{ Params: EligibleGuildsParams }>(
    '/organizers/:originGuildId/eligible-guilds',
    { schema: { params: eligibleGuildsParamsSchema } },
    async (request) => {
      return organizersService.listEligibleGuilds(deps, request.params.originGuildId)
    }
  )
}
