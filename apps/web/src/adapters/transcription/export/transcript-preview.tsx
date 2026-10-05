import { useTranslation } from 'react-i18next'
import { ChatBubble } from '@ki4jlu/design-system'
import type { TranscriptFormatFlags } from '@justcampus/shared'
import { formatClock, type FormattedTranscript, type TranscriptBlock } from './format'
import { SpeakerAvatar } from './parts'

/**
 * The formatted transcript as the export previews it (T-43): per block the avatar, the name and
 * the time as the format asks, the text in a speech bubble or plain. It follows every change of
 * the format at once.
 */
export function TranscriptPreview({
  formatted,
  flags
}: {
  formatted: FormattedTranscript
  flags: TranscriptFormatFlags
}): React.JSX.Element {
  const { t } = useTranslation()
  if (formatted.allHidden) {
    return (
      <p className="m-0 flex justify-center py-gutter">
        {t('transcription.export.allSpeakersHidden')}
      </p>
    )
  }
  return (
    <ol
      aria-label={t('transcription.export.resultLooksLike')}
      className="m-0 flex list-none flex-col gap-stack-md p-0"
    >
      {formatted.blocks.map((block, index) => (
        <li key={`${index}-${block.speaker}-${block.start}`} className="flex flex-col">
          {flags.bubbles ? (
            <ChatBubble from="assistant" className="flex flex-col gap-stack-sm">
              <BlockContent block={block} flags={flags} />
            </ChatBubble>
          ) : (
            <div className="flex flex-col gap-stack-sm">
              <BlockContent block={block} flags={flags} />
            </div>
          )}
        </li>
      ))}
    </ol>
  )
}

function BlockContent({
  block,
  flags
}: {
  block: TranscriptBlock
  flags: TranscriptFormatFlags
}): React.JSX.Element {
  const time = flags.timestamps && flags.order !== 'speaker'
  return (
    <>
      {flags.avatars || flags.speakers || time ? (
        <div className="flex flex-wrap items-center gap-stack-sm">
          {flags.avatars ? <SpeakerAvatar name={block.name} colorId={block.colorId} /> : null}
          {flags.speakers ? <strong>{block.name}</strong> : null}
          {time ? (
            <time dateTime={`PT${Math.floor(block.start)}S`}>[{formatClock(block.start)}]</time>
          ) : null}
        </div>
      ) : null}
      {block.lines.map((line, index) => (
        <p key={index} className="m-0">
          {line}
        </p>
      ))}
    </>
  )
}
