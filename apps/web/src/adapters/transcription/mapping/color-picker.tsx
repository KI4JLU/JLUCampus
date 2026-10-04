import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@ki4jlu/design-system'
import {
  TRANSCRIPTION_SPEAKER_COLOR_IDS,
  TRANSCRIPTION_SPEAKER_COLORS,
  type TranscriptionSpeakerColorId
} from '@justcampus/shared'

/**
 * A speaker colour as a dot. DS gap: no categorical palette of ten and no coloured Avatar variant,
 * so the dot takes kiChat's speaker colour inline.
 */
export function ColorDot({ colorId }: { colorId: TranscriptionSpeakerColorId }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="block size-6 shrink-0 rounded-full"
      style={{ backgroundColor: TRANSCRIPTION_SPEAKER_COLORS[colorId] }}
    />
  )
}

/** kiChat's avatar picker (T-18): the voice's colour, and the ten to choose from. */
export function ColorPicker({
  value,
  label,
  onChange
}: {
  value: TranscriptionSpeakerColorId
  /** Names the button, e.g. `Change the colour of Voice 1`. */
  label: string
  onChange: (colorId: TranscriptionSpeakerColorId) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          title={t('transcription.common.changeColor')}
        >
          <ColorDot colorId={value} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <div role="group" aria-label={label} className="grid grid-cols-5 gap-1">
          {TRANSCRIPTION_SPEAKER_COLOR_IDS.map((colorId) => (
            <Button
              key={colorId}
              type="button"
              variant="ghost"
              size="icon"
              aria-pressed={colorId === value}
              aria-label={t('transcription.upload.mapping.colorN', { n: colorId })}
              onClick={() => {
                onChange(colorId)
                setOpen(false)
              }}
            >
              <ColorDot colorId={colorId} />
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
