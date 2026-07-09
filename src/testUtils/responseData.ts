import type { APIInteractionResponse } from 'discord-api-types/v10'

// APIInteractionResponse is a union where several variants (Pong, deferred
// updates) have no `data` field at all, so TypeScript correctly refuses
// blanket `.data` access without narrowing by `.type` first. Tests don't
// care which specific response type they got beyond "it has a payload" —
// this asserts that and gives back a loosely-typed view covering the
// fields our tests actually assert on, instead of scattering `as any`
// across every test file.
export interface TestableResponseData {
  content?: string
  flags?: number
  components?: unknown[]
  custom_id?: string
  title?: string
}

export function responseData(response: APIInteractionResponse): TestableResponseData {
  const data = (response as { data?: TestableResponseData }).data
  if (!data) {
    throw new Error(`Expected an interaction response with a data payload, got response type ${response.type}`)
  }
  return data
}
