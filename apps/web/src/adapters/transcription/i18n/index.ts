import deCommon from './de/common.json'
import deExport from './de/export.json'
import deRecording from './de/recording.json'
import deResult from './de/result.json'
import deUpload from './de/upload.json'
import enCommon from './en/common.json'
import enExport from './en/export.json'
import enRecording from './en/recording.json'
import enResult from './en/result.json'
import enUpload from './en/upload.json'

/**
 * The transcription module's texts, one file per area, merged into the app's `translation`
 * resources under `transcription`: `t('transcription.upload.addSpeaker')`. Each area's file belongs
 * to the code of the same name; `common` holds what several areas show.
 *
 * Texts from kiChat's catalog (docs/TRANSCRIPTION-REQUIREMENTS.md, section 4) are verbatim. Their
 * key is the reference key without `Transcript` (and without `Export` in `export.json`), starting
 * lower case: `TranscriptExportCopied` is `transcription.export.copied`. kiChat's `{name}`
 * placeholders are i18next's `{{name}}`.
 */
export const transcriptionResources = {
  de: {
    common: deCommon,
    upload: deUpload,
    result: deResult,
    export: deExport,
    recording: deRecording
  },
  en: {
    common: enCommon,
    upload: enUpload,
    result: enResult,
    export: enExport,
    recording: enRecording
  }
}

export type TranscriptionResources = typeof transcriptionResources.de
