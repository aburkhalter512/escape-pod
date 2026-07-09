import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { zodValidatorCompiler } from './validation.js'

// zodValidatorCompiler's declared return type is Fastify's own
// FastifyValidationResult, a union (boolean | promise | { error?, value? })
// since Fastify supports several validator shapes generally — but our
// implementation only ever returns the { error?, value? } shape. Narrowing
// locally here documents that as the actual contract under test.
interface ValidationOutcome {
  value?: unknown
  error?: Error
}

describe('zodValidatorCompiler', () => {
  const schema = z.object({ name: z.string().min(1) })
  const routeSchemaDef = { schema, method: 'POST', url: '/test' }

  it('returns { value } with the parsed data when it matches the schema', () => {
    const validate = zodValidatorCompiler(routeSchemaDef)
    const result = validate({ name: 'PlayerOne' }) as ValidationOutcome

    expect(result).toEqual({ value: { name: 'PlayerOne' } })
  })

  it('returns { error } as a real Error instance when the data does not match', () => {
    const validate = zodValidatorCompiler(routeSchemaDef)
    const result = validate({ name: '' }) as ValidationOutcome

    expect(result.error).toBeInstanceOf(Error)
  })

  it('strips unknown keys not declared on the schema (zod default behavior)', () => {
    const validate = zodValidatorCompiler(routeSchemaDef)
    const result = validate({ name: 'PlayerOne', extra: 'field' }) as ValidationOutcome

    expect(result.value).toEqual({ name: 'PlayerOne' })
  })

  it('rejects the wrong type for a declared field', () => {
    const validate = zodValidatorCompiler(routeSchemaDef)
    const result = validate({ name: 123 }) as ValidationOutcome

    expect(result.value).toBeUndefined()
    expect(result.error).toBeInstanceOf(Error)
  })

  it('rejects entirely missing data (undefined)', () => {
    const validate = zodValidatorCompiler(routeSchemaDef)
    const result = validate(undefined) as ValidationOutcome

    expect(result.error).toBeInstanceOf(Error)
  })
})
