import type { DesktopComponentType, SingletonComponentType } from '@justcampus/shared'

import { transcriptionModule } from './transcription/index.js'
import { translatorModule } from './translator/index.js'
import type { ServerModule } from './types.js'

export const moduleRegistry = {
  translator: translatorModule,
  transcription: transcriptionModule
} satisfies { [T in SingletonComponentType]: ServerModule<T> }

/**
 * Name and icon of each desktop component when the server creates it. The component's page lives
 * in the desktop app, so the server holds nothing else for it.
 */
export const desktopComponentDefaults = {
  files: { name: 'Dateien & Laufwerke', icon: 'hard-drive' }
} satisfies { [T in DesktopComponentType]: { name: string; icon: string } }
