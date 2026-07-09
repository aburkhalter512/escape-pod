import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as guildsService from '../services/guilds.js'
import type { GuildServiceDeps } from '../services/guilds.js'

export type GuildRouteDeps = GuildServiceDeps

const subscribeGuildBodySchema = z.object({
  guildId: z.string().min(1),
  channelId: z.string().min(1),
  installedBy: z.string().min(1),
})
type SubscribeGuildBody = z.infer<typeof subscribeGuildBodySchema>

const allowOrganizerBodySchema = z.object({
  guildId: z.string().min(1),
  organizerDiscordId: z.string().min(1),
  approvedBy: z.string().min(1),
})
type AllowOrganizerBody = z.infer<typeof allowOrganizerBodySchema>

export function registerGuildRoutes(app: FastifyInstance, deps: GuildRouteDeps): void {
  app.post<{ Body: SubscribeGuildBody }>(
    '/guilds/subscribe',
    { schema: { body: subscribeGuildBodySchema } },
    async (request, reply) => {
      await guildsService.subscribeGuild(deps, request.body)
      return reply.send({ ok: true })
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
}
