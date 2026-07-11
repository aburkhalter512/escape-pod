// Returned by service functions instead of thrown, for the three
// expected/recoverable business-rule outcomes this app has — lets routes
// and commands branch on `.ok`/`error.kind` instead of try/catch +
// `instanceof`. Genuinely unexpected failures (a Prisma outage, a real
// bug) are NOT part of this — those still propagate as real exceptions
// to each API surface's single top-level catch-all (server.ts's
// `/interactions` handler for Discord; `app.setErrorHandler` for HTTP).
export type ServiceError =
  | { kind: 'not_found'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'validation'; message: string }

export function notFound(message: string): ServiceError {
  return { kind: 'not_found', message }
}

export function forbidden(message: string): ServiceError {
  return { kind: 'forbidden', message }
}

export function validationError(message: string): ServiceError {
  return { kind: 'validation', message }
}

export type Result<T, E = ServiceError> = { ok: true; value: T } | { ok: false; error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

// Shared by every HTTP route that surfaces a ServiceError — keeps the
// kind→status mapping in one place instead of repeated per route.
export function httpStatusForError(error: ServiceError): number {
  switch (error.kind) {
    case 'not_found':
      return 404
    case 'forbidden':
      return 403
    case 'validation':
      return 422
  }
}

// Satisfied by Fastify's app.log from route wrappers, and by console from
// LocalBackendClient's construction in server.ts — service functions never
// have direct access to a Fastify instance.
export interface Logger {
  error(obj: unknown, msg: string): void
}
