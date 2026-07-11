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

const eligibleGuildsParamsSchema = z.object({
  discordId: z.string().min(1),
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
    '/organizers/:discordId/eligible-guilds',
    { schema: { params: eligibleGuildsParamsSchema } },
    async (request) => {
      return organizersService.listEligibleGuilds(deps, request.params.discordId)
    }
  )
}
