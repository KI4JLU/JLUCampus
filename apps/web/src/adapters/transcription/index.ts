import { TRANSCRIPTION_DEFAULT_CONFIG } from '@justcampus/shared'
import type { ComponentAdapter } from '../types'
import { TranscriptionConfigFields } from './config-fields'
import { TranscriptionPage } from './page'
import { QuickTile, RecentTile } from './widgets'

/** A module (see `SINGLETON_COMPONENT_TYPES`): built into the app, so it has no address. */
export const transcriptionAdapter: ComponentAdapter<'transcription'> = {
  type: 'transcription',
  Page: TranscriptionPage,
  ConfigFields: TranscriptionConfigFields,
  defaultConfig: TRANSCRIPTION_DEFAULT_CONFIG,
  widgets: { quick: { Tile: QuickTile }, recent: { Tile: RecentTile } }
}
