import type { FastifySchemaCompiler } from 'fastify/types/schema.js'
import type { ZodType } from 'zod'

// Wires Zod schemas directly into Fastify's own validation hook, instead of
// pulling in fastify-type-provider-zod — that package's peer dependencies
// (@fastify/swagger, openapi-types) are for OpenAPI doc generation, which
// this internal, bot-only API has no use for. Routes declare `schema: {
// body: someZodSchema, params: someZodSchema }`; Fastify calls this
// compiler once per declared part and 400s automatically when it returns
// an error (tasks/003-backend-route-input-validation.md).
export const zodValidatorCompiler: FastifySchemaCompiler<ZodType> = ({ schema }) => {
  return (data: unknown) => {
    const result = schema.safeParse(data)
    if (result.success) {
      return { value: result.data }
    }
    return { error: result.error }
  }
}
