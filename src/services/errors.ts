// Thrown by service functions instead of writing an HTTP response directly
// — lets the same functions be called both from Fastify route wrappers
// (which map these to status codes) and from LocalBackendClient (which
// lets them propagate as plain thrown errors, same as HttpBackendClient
// used to do for any non-2xx response).
export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}
export class ValidationError extends Error {}

// Satisfied by Fastify's app.log from route wrappers, and by console from
// LocalBackendClient's construction in server.ts — service functions never
// have direct access to a Fastify instance.
export interface Logger {
  error(obj: unknown, msg: string): void
}
