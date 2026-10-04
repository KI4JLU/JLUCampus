import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z, type ZodType } from 'zod'

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code:
      | 'not_found'
      | 'forbidden'
      | 'validation'
      | 'conflict'
      | 'rate_limited'
      | 'feed_unavailable'
      | 'module_unavailable'
      | 'not_implemented',
    message: string,
    readonly issues?: Array<{ path: Array<string | number>; message: string }>
  ) {
    super(message)
  }
}

export function validationIssues(
  error: z.ZodError
): Array<{ path: Array<string | number>; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
    message: issue.message
  }))
}

export async function parseBody<T>(
  context: { req: { json: () => Promise<unknown> } },
  schema: ZodType<T>
): Promise<T> {
  let body: unknown
  try {
    body = await context.req.json()
  } catch {
    throw new ApiError(400, 'validation', 'Request body is not valid JSON', [
      { path: [], message: 'Expected a JSON request body' }
    ])
  }

  const result = schema.safeParse(body)
  if (!result.success) {
    throw new ApiError(
      400,
      'validation',
      'Request validation failed',
      validationIssues(result.error)
    )
  }
  return result.data
}
