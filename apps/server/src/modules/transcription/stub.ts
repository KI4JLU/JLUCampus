import type { Handler } from 'hono'

import { ApiError } from '../../api.js'
import type { AppEnvironment } from '../types.js'

/** Answers `501 not_implemented` for a route that is declared but not built yet. */
export const notImplemented: Handler<AppEnvironment> = () => {
  throw new ApiError(501, 'not_implemented', 'Not implemented yet')
}
