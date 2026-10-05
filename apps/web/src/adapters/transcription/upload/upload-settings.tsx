import { useId } from 'react'
import { GlobeIcon, UsersIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Checkbox,
  Label,
  PanelSection,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@ki4jlu/design-system'
import {
  TRANSCRIPTION_LANGUAGES,
  TRANSCRIPTION_SPEAKER_COUNTS,
  transcriptionLanguageSchema,
  transcriptionSpeakerCountSchema,
  type TranscriptionLanguage,
  type TranscriptionSpeakerCount
} from '@justcampus/shared'
import { useTranscriptionWorkspace } from '../use-workspace'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/**
 * The upload settings in the side column (T-09): spoken language and number of speakers, both
 * `Auto` by default, and the AI correction, on by default. They apply to files added from now on,
 * and dispatch sends them again, so they can change until a file is transcribed.
 */
export function UploadSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const { uploadSettings, setUploadSettings, capabilities } = useTranscriptionWorkspace()
  const correctionOffered = capabilities?.llmCorrection ?? true

  const languageLabel: Record<TranscriptionLanguage, string> = {
    auto: t('transcription.upload.auto'),
    de: t('transcription.upload.languageGerman'),
    en: t('transcription.upload.languageEnglish')
  }
  const speakerLabel: Record<TranscriptionSpeakerCount, string> = {
    auto: t('transcription.upload.auto'),
    single: t('transcription.upload.singleSpeaker'),
    multi: t('transcription.upload.multipleSpeakers')
  }

  return (
    <PanelSection title={t('transcription.common.sidebarTitle')}>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-language`} className="flex items-center gap-2">
          <GlobeIcon {...ICON} />
          {t('transcription.upload.language')}
        </Label>
        <Select
          value={uploadSettings.language}
          onValueChange={(value) => {
            const parsed = transcriptionLanguageSchema.safeParse(value)
            if (parsed.success) setUploadSettings({ language: parsed.data })
          }}
        >
          <SelectTrigger id={`${id}-language`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSCRIPTION_LANGUAGES.map((language) => (
              <SelectItem key={language} value={language}>
                {languageLabel[language]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-speakers`} className="flex items-center gap-2">
          <UsersIcon {...ICON} />
          {t('transcription.upload.detectSpeakers')}
        </Label>
        <Select
          value={uploadSettings.speakerCount}
          onValueChange={(value) => {
            const parsed = transcriptionSpeakerCountSchema.safeParse(value)
            if (parsed.success) setUploadSettings({ speakerCount: parsed.data })
          }}
        >
          <SelectTrigger id={`${id}-speakers`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSCRIPTION_SPEAKER_COUNTS.map((count) => (
              <SelectItem key={count} value={count}>
                {speakerLabel[count]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-3">
        <Checkbox
          id={`${id}-correction`}
          checked={uploadSettings.llmCorrection}
          disabled={!correctionOffered}
          onCheckedChange={(checked) => setUploadSettings({ llmCorrection: checked === true })}
        />
        <Label htmlFor={`${id}-correction`}>{t('transcription.upload.optimizeSpeakersAI')}</Label>
      </div>
    </PanelSection>
  )
}
