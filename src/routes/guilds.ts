import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as guildsService from '../services/guilds.js'
import type { GuildServiceDeps } from '../services/guilds.js'
import * as organizersService from '../services/organizers.js'
import { httpStatusForError } from '../services/errors.js'

export type GuildRouteDeps = GuildServiceDeps

const subscribeGuildBodySchema = z.object({
  guildId: z.string().min(1),
  installedBy: z.string().min(1),
  // Both optional — see services/guilds.ts's subscribeGuild for what
  // omitting one or both means (reconfigure just one setting, or read
  // current settings back without writing anything).
  channelId: z.string().min(1).optional(),
  policy: z.enum(['OPEN', 'ALLOWLIST']).optional(),
})
type SubscribeGuildBody = z.infer<typeof subscribeGuildBodySchema>

const unsubscribeGuildBodySchema = z.object({
  guildId: z.string().min(1),
})
type UnsubscribeGuildBody = z.infer<typeof unsubscribeGuildBodySchema>

const allowOrganizerBodySchema = z.object({
  guildId: z.string().min(1),
  organizerDiscordId: z.string().min(1),
  approvedBy: z.string().min(1),
})
type AllowOrganizerBody = z.infer<typeof allowOrganizerBodySchema>

const allowGuildBodySchema = z.object({
  guildId: z.string().min(1),
  allowedOriginGuildId: z.string().min(1),
  approvedBy: z.string().min(1),
})
type AllowGuildBody = z.infer<typeof allowGuildBodySchema>

// Moved from routes/organizers.ts — eligibility is origin-guild-scoped
// (see services/organizers.ts's listEligibleGuilds), not organizer-scoped,
// so this belongs alongside the other guild-keyed routes.
const eligibleGuildsParamsSchema = z.object({
  originGuildId: z.string().min(1),
})
type EligibleGuildsParams = z.infer<typeof eligibleGuildsParamsSchema>

export function registerGuildRoutes(app: FastifyInstance, deps: GuildRouteDeps): void {
  app.post<{ Body: SubscribeGuildBody }>(
    '/guilds/subscribe',
    { schema: { body: subscribeGuildBodySchema } },
    async (request, reply) => {
      const result = await guildsService.subscribeGuild(deps, request.body)
      if (!result.ok) {
        return reply.code(httpStatusForError(result.error)).send({ error: result.error.message })
      }
      return reply.send(result.value)
    }
  )

  app.post<{ Body: UnsubscribeGuildBody }>(
    '/guilds/unsubscribe',
    { schema: { body: unsubscribeGuildBodySchema } },
    async (request, reply) => {
      const result = await guildsService.unsubscribeGuild(deps, request.body.guildId)
      return reply.send(result)
    }
  )

  app.post<{ Body: AllowOrganizerBody }>(
    '/guilds/allow-organizer',
    { schema: { body: allowOrganizerBodySchema } },
    async (request, reply) => {
      await guildsService.allowOrganizer(deps, request.body)
      return reply.send({ ok: true })
    }
  )

  app.post<{ Body: AllowGuildBody }>(
    '/guilds/allow-guild',
    { schema: { body: allowGuildBodySchema } },
    async (request, reply) => {
      await guildsService.allowGuild(deps, request.body)
      return reply.send({ ok: true })
    }
  )

  app.get<{ Params: EligibleGuildsParams }>(
    '/guilds/:originGuildId/eligible-guilds',
    { schema: { params: eligibleGuildsParamsSchema } },
    async (request) => {
      return organizersService.listEligibleGuilds(deps, request.params.originGuildId)
    }
  )
}
