import { FileUpIcon, MicIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@ki4jlu/design-system'
import { useTranscriptionWorkspace } from './use-workspace'
import type { TranscriptionView } from './workspace'

interface Choice {
  view: TranscriptionView
  icon: React.JSX.Element
  title: string
  description: string
  available: boolean
}

/**
 * The entry choice (T-01): upload files, or record. Recording leads to regular recording, or to
 * live transcription when only that is set up. A choice the module does not offer stays visible,
 * disabled, and says so.
 */
export function ChoiceView(): React.JSX.Element {
  const { t } = useTranslation()
  const { capabilities, setView } = useTranscriptionWorkspace()
  const batch = capabilities?.batch ?? false
  const live = (capabilities?.realtimeModes.length ?? 0) > 0
  const choices: Choice[] = [
    {
      view: 'upload',
      icon: <FileUpIcon aria-hidden="true" className="size-5" />,
      title: t('transcription.common.choiceUploadTitle'),
      description: t('transcription.common.choiceUploadDesc'),
      available: batch
    },
    {
      view: batch ? 'record' : 'live',
      icon: <MicIcon aria-hidden="true" className="size-5" />,
      title: t('transcription.common.choiceRecordTitle'),
      description: t('transcription.common.choiceRecordDesc'),
      available: batch || live
    }
  ]

  return (
    <div className="grid gap-stack-lg md:grid-cols-2">
      {choices.map((choice) => (
        // The whole lit card opens the choice; its button stays the one control for the keyboard,
        // and its click reaches the card's. DS gap: `interactive` sets no pointer cursor.
        <Card
          key={choice.title}
          interactive={choice.available}
          className={choice.available ? 'cursor-pointer' : undefined}
          onClick={choice.available ? () => setView(choice.view) : undefined}
        >
          <CardHeader>
            <CardTitle asChild>
              <h2 className="flex items-center gap-2">
                {choice.icon}
                {choice.title}
              </h2>
            </CardTitle>
            <CardDescription>{choice.description}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-stack-sm">
            <Button type="button" disabled={!choice.available}>
              {choice.title}
            </Button>
            {choice.available || !capabilities ? null : (
              <Badge tone="neutral" appearance="filled">
                {t('transcription.common.notAvailable')}
              </Badge>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
