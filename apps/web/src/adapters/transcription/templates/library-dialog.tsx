import { useState } from 'react'
import { FileUserIcon, PlusIcon, SearchIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  PanelSection,
  Spinner
} from '@ki4jlu/design-system'
import type { TranscriptionTemplate } from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { toast } from '@/lib/toast'
import { useDeleteTemplate, useTranscriptionTemplates } from '../api'
import { templateActions } from './store'
import {
  matchesTemplateSearch,
  newTemplateDraft,
  templateDraft,
  templateSubtext
} from './structure'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

export interface TemplateLibraryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The template chosen with "Use". */
  onChoose: (templateId: string) => void
  /** The template in use, marked active. */
  activeId?: string | null
}

/**
 * kiChat's template chooser (T-50, T-54): the user's templates with a card for a new one, then the
 * built-in library, filtered by name and sections. Each can be used; the user's own are edited and
 * deleted after a confirmation, built-ins are customised as a copy.
 */
export function TemplateLibraryDialog({
  open,
  onOpenChange,
  onChoose,
  activeId = null
}: TemplateLibraryDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const templates = useTranscriptionTemplates()
  const [search, setSearch] = useState('')
  const [deleting, setDeleting] = useState<TranscriptionTemplate | null>(null)

  const matching = (templates.data ?? []).filter((template) =>
    matchesTemplateSearch(template, search)
  )
  const mine = matching.filter((template) => !template.builtIn)
  const library = matching.filter((template) => template.builtIn)
  const copyName = (name: string): string => t('transcription.export.copyName', { name })

  const startNew = (): void =>
    templateActions.openEditor(
      newTemplateDraft({
        name: t('transcription.export.newTemplateName'),
        sectionHeading: t('transcription.export.shortcuts.summary.heading'),
        sectionInstruction: t('transcription.export.shortcuts.summary.instruction')
      })
    )

  const card = (template: TranscriptionTemplate): React.JSX.Element => (
    <TemplateCard
      key={template.id}
      template={template}
      active={template.id === activeId}
      onUse={() => onChoose(template.id)}
      onEdit={() => templateActions.openEditor(templateDraft(template, false, copyName))}
      onDelete={() => setDeleting(template)}
    />
  )

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          onOpenChange(next)
          if (!next) setSearch('')
        }}
      >
        <DialogContent
          closeLabel={t('transcription.common.close')}
          // DS gap: DialogContent has no height cap or wide size of its own; the library scrolls.
          className="max-h-9/10 grid-cols-1 overflow-y-auto sm:max-w-3xl"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>{t('transcription.export.chooseTemplate')}</DialogTitle>
          </DialogHeader>
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            leadingIcon={<SearchIcon {...ICON} />}
            placeholder={t('transcription.export.searchTemplate')}
            aria-label={t('transcription.export.searchTemplate')}
          />
          {templates.isPending ? (
            <Spinner label={t('transcription.common.loading')} />
          ) : templates.isError ? (
            <div className="flex flex-wrap items-center gap-stack-sm">
              <p className="m-0">{t('transcription.export.templatesLoadFailed')}</p>
              <Button type="button" variant="outline" onClick={() => void templates.refetch()}>
                {t('transcription.common.retry')}
              </Button>
            </div>
          ) : (
            <>
              <PanelSection title={t('transcription.export.myTemplates')}>
                <div className="grid gap-stack-md sm:grid-cols-2">
                  {mine.map(card)}
                  <Card interactive>
                    <CardHeader>
                      <CardTitle>{t('transcription.export.newTemplate')}</CardTitle>
                      <CardDescription>{t('transcription.export.emptyStart')}</CardDescription>
                    </CardHeader>
                    <CardFooter>
                      <Button type="button" variant="outline" size="sm" onClick={startNew}>
                        <PlusIcon {...ICON} />
                        {t('transcription.export.newTemplate')}
                      </Button>
                    </CardFooter>
                  </Card>
                </div>
              </PanelSection>
              <PanelSection title={t('transcription.export.library')}>
                {library.length > 0 ? (
                  <div className="grid gap-stack-md sm:grid-cols-2">{library.map(card)}</div>
                ) : search.trim() ? (
                  <p className="m-0">{t('transcription.export.noTemplatesFound')}</p>
                ) : null}
              </PanelSection>
            </>
          )}
        </DialogContent>
      </Dialog>
      <DeleteTemplateDialog template={deleting} onClose={() => setDeleting(null)} />
    </>
  )
}

function TemplateCard({
  template,
  active,
  onUse,
  onEdit,
  onDelete
}: {
  template: TranscriptionTemplate
  active: boolean
  onUse: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const subtext = templateSubtext(template.structure)
  const editLabel = template.builtIn
    ? t('transcription.export.customise')
    : t('transcription.common.edit')
  return (
    <Card accent={active}>
      <CardHeader>
        <div className="flex items-start justify-between gap-stack-sm">
          <CardTitle className="flex min-w-0 items-center gap-stack-sm">
            <FileUserIcon {...ICON} />
            <span className="min-w-0 truncate">{template.name}</span>
          </CardTitle>
          {active ? (
            <Badge tone="primary" className="shrink-0">
              {t('transcription.export.active')}
            </Badge>
          ) : null}
        </div>
        {subtext ? <CardDescription>{subtext}</CardDescription> : null}
      </CardHeader>
      <CardContent className="flex flex-wrap gap-stack-sm">
        <Button
          type="button"
          size="sm"
          onClick={onUse}
          aria-label={`${t('transcription.export.use')}: ${template.name}`}
        >
          {t('transcription.export.use')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onEdit}
          aria-label={`${editLabel}: ${template.name}`}
        >
          {editLabel}
        </Button>
        {template.builtIn ? null : (
          <Button
            type="button"
            variant="ghost-destructive"
            size="sm"
            aria-label={t('transcription.export.deleteTemplate', { name: template.name })}
            onClick={onDelete}
          >
            {t('transcription.common.delete')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/** Asks before a template is deleted; cancelling keeps it (T-54). */
function DeleteTemplateDialog({
  template,
  onClose
}: {
  template: TranscriptionTemplate | null
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const remove = useDeleteTemplate()

  const confirm = (): void => {
    if (!template) return
    remove.mutate(template.id, {
      onSuccess: () => {
        templateActions.deleted(template.id)
        onClose()
      },
      onError: (error) =>
        toast({
          variant: 'error',
          title: t('transcription.common.error'),
          description:
            error instanceof ApiRequestError
              ? t('transcription.export.deleteFailed') +
                (error.body?.error.message ?? t('transcription.common.unknown'))
              : t('transcription.export.connectionError')
        })
    })
  }

  return (
    <Dialog open={template !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent closeLabel={t('transcription.common.close')}>
        <DialogHeader>
          <DialogTitle>{t('transcription.export.deleteTemplateTitle')}</DialogTitle>
          <DialogDescription>{t('transcription.export.confirmDeleteTemplate')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              {t('transcription.common.cancel')}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" disabled={remove.isPending} onClick={confirm}>
            {t('transcription.common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
