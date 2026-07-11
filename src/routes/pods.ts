import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import * as podsService from '../services/pods.js'
import type { PodServiceDeps } from '../services/pods.js'
import { httpStatusForError } from '../services/errors.js'

export type PodRouteDeps = PodServiceDeps

const startPodBodySchema = z.object({
  organizerDiscordId: z.string().min(1),
  setCode: z.string().min(1),
  // Matches the /start-pod command's own min/max (INTEGRATIONS.md §7.4) —
  // enforced again here since nothing guarantees a Discord interaction
  // handler is the only caller of this route.
  threshold: z.number().int().min(2).max(8),
  guildIds: z.array(z.string().min(1)),
  // ISO datetime string, coerced to a Date — the in-process caller
  // (components.ts) already has an absolute Date from parsing a relative
  // duration (util/duration.ts); this route takes the absolute form
  // directly rather than re-implementing that parsing here too.
  scheduledFor: z.coerce.date().optional(),
  // Name of the guild /start-pod was invoked in, resolved live by the
  // caller before this call — see services/pods.ts's StartPodParams.
  originGuildName: z.string().min(1).optional(),
})
type StartPodBody = z.infer<typeof startPodBodySchema>

const targetMessageParamsSchema = z.object({
  id: z.string().min(1),
  guildId: z.string().min(1),
})
type TargetMessageParams = z.infer<typeof targetMessageParamsSchema>

const targetMessageBodySchema = z.object({
  messageId: z.string().min(1),
})
type TargetMessageBody = z.infer<typeof targetMessageBodySchema>

const signupParamsSchema = z.object({ id: z.string().min(1) })
type SignupParams = z.infer<typeof signupParamsSchema>

const signupBodySchema = z.object({
  discordId: z.string().min(1),
  username: z.string().min(1),
  sourceGuildId: z.string().min(1),
  action: z.enum(['in', 'leave']),
})
type SignupBody = z.infer<typeof signupBodySchema>

const cancelParamsSchema = z.object({ id: z.string().min(1) })
type CancelParams = z.infer<typeof cancelParamsSchema>

const cancelBodySchema = z.object({ requestedBy: z.string().min(1) })
type CancelBody = z.infer<typeof cancelBodySchema>

export function registerPodRoutes(app: FastifyInstance, deps: PodRouteDeps): void {
  app.post<{ Body: StartPodBody }>(
    '/pods/start',
    { schema: { body: startPodBodySchema } },
    async (request, reply) => {
      const result = await podsService.startPod(deps, request.body)
      return reply.send(result)
    }
  )

  app.post<{ Params: TargetMessageParams; Body: TargetMessageBody }>(
    '/pods/:id/targets/:guildId/message',
    { schema: { params: targetMessageParamsSchema, body: targetMessageBodySchema } },
    async (request, reply) => {
      const result = await podsService.recordTargetMessage(deps, {
        podRoundId: request.params.id,
        guildId: request.params.guildId,
        messageId: request.body.messageId,
      })
      if (!result.ok) {
        return reply.code(httpStatusForError(result.error)).send({ error: result.error.message })
      }
      return reply.send({ ok: true })
    }
  )

  app.post<{ Params: SignupParams; Body: SignupBody }>(
    '/pods/:id/signup',
    { schema: { params: signupParamsSchema, body: signupBodySchema } },
    async (request, reply) => {
      const result = await podsService.recordSignup(deps, {
        podRoundId: request.params.id,
        ...request.body,
      })
      if (!result.ok) {
        return reply.code(httpStatusForError(result.error)).send({ error: result.error.message })
      }
      return reply.send(result.value)
    }
  )

  app.post<{ Params: CancelParams; Body: CancelBody }>(
    '/pods/:id/cancel',
    { schema: { params: cancelParamsSchema, body: cancelBodySchema } },
    async (request, reply) => {
      const result = await podsService.cancelPod(deps, {
        podRoundId: request.params.id,
        requestedBy: request.body.requestedBy,
      })
      if (!result.ok) {
        return reply.code(httpStatusForError(result.error)).send({ error: result.error.message })
      }
      return reply.send({ ok: true })
    }
  )
}
