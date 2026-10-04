import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CheckIcon,
  FlaskConicalIcon,
  GripVerticalIcon,
  InfoIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  PanelSection,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@ki4jlu/design-system'
import {
  TRANSCRIPTION_PREVIEW_SECTIONS_MAX,
  TRANSCRIPTION_TEMPLATE_NAME_MAX,
  TRANSCRIPTION_TEMPLATE_TEXT_MAX,
  type TranscriptionPlaceholder
} from '@justcampus/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ApiRequestError } from '@/lib/api'
import { meQuery } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { previewSummary, useSaveTemplate } from '../api'
import { useTranscriptionWorkspace } from '../use-workspace'
import {
  fillPlaceholders,
  PLACEHOLDERS,
  placeholderToken,
  placeholderValues,
  insertToken
} from './placeholders'
import {
  clearPreviewCaches,
  previewCacheKey,
  readPreviewCache,
  sectionPreview,
  staleSections,
  userCachePrefix,
  withPreviewResults,
  writePreviewCache,
  type PreviewCache
} from './preview-cache'
import { templateActions } from './store'
import {
  blockKey,
  moveBlock,
  moveBlockTo,
  removeBlock,
  toStructure,
  updateBlock,
  type EditorBlock,
  type TemplateDraft
} from './structure'

const MarkdownView = lazy(() => import('../summary/markdown-view'))

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/** How long a palette button says "Eingefügt", as in kiChat. */
const INSERTED_MS = 1200

/** The AI section shortcuts of kiChat's palette, in its order (T-51). */
const SHORTCUTS = [
  'summary',
  'todos',
  'decisions',
  'results',
  'keyPoints',
  'quotes',
  'topics',
  'free'
] as const
type Shortcut = (typeof SHORTCUTS)[number]

/** The field of a block that last had the focus, for inserting placeholders there (T-52). */
interface FocusedField {
  key: string
  field: 'text' | 'heading' | 'instruction'
  element: HTMLInputElement | HTMLTextAreaElement
}

type SectionBlock = Extract<EditorBlock, { type: 'section' }>

/**
 * kiChat's template editor (T-51 to T-53): the name, the element palette with placeholders, static
 * blocks and AI sections, the ordered blocks (arrows, drag and drop, delete), and the live preview
 * with test previews of the AI sections. Saving makes the template the one in use.
 */
export function TemplateEditor({ draft }: { draft: TemplateDraft }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { currentDocument, component } = useTranscriptionWorkspace()
  const me = useQuery(meQuery).data
  const save = useSaveTemplate()
  const nameId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(draft.name)
  const [nameInvalid, setNameInvalid] = useState(false)
  const [blocks, setBlocks] = useState<EditorBlock[]>(draft.blocks)
  const focused = useRef<FocusedField | null>(null)
  const [inserted, setInserted] = useState<string | null>(null)
  const insertedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const transcriptId = currentDocument?.transcript.id ?? null
  const storageKey = me ? previewCacheKey(me.id, component.id) : null
  // The user's stored previews, read again when the user is known or changes.
  const [stored, setStored] = useState<{ key: string | null; cache: PreviewCache }>(() => ({
    key: storageKey,
    cache: storageKey ? readPreviewCache(window.localStorage, storageKey) : {}
  }))
  if (stored.key !== storageKey) {
    setStored({
      key: storageKey,
      cache: storageKey ? readPreviewCache(window.localStorage, storageKey) : {}
    })
  }
  const cache = stored.cache
  const [generating, setGenerating] = useState<ReadonlySet<string>>(new Set())
  const [sectionErrors, setSectionErrors] = useState<Readonly<Record<string, string>>>({})

  // Other people's previews go; sign-out takes the user's too (`sign-out.ts`).
  useEffect(() => {
    if (me) clearPreviewCaches(window.localStorage, userCachePrefix(me.id))
  }, [me])

  useEffect(
    () => () => {
      if (insertedTimer.current) clearTimeout(insertedTimer.current)
    },
    []
  )

  const values = useMemo(
    () =>
      placeholderValues(
        {
          title: currentDocument?.transcript.title ?? null,
          createdAt: currentDocument?.transcript.createdAt ?? null,
          segments: currentDocument?.segments ?? [],
          duration: currentDocument?.transcript.duration ?? null
        },
        i18n.language,
        (minutes) => t('transcription.export.minutesShort', { minutes })
      ),
    [currentDocument, i18n.language, t]
  )

  const flash = (id: string): void => {
    setInserted(id)
    if (insertedTimer.current) clearTimeout(insertedTimer.current)
    insertedTimer.current = setTimeout(() => setInserted(null), INSERTED_MS)
  }

  const addBlock = (block: EditorBlock, id: string): void => {
    setBlocks((current) => [...current, block])
    flash(id)
  }

  /** Puts a token at the cursor of the field last used, else appends it as a text block (T-52). */
  const insertPlaceholder = (placeholder: TranscriptionPlaceholder): void => {
    const token = placeholderToken(placeholder)
    const target = focused.current
    const block = target ? blocks.find((item) => item.key === target.key) : undefined
    if (!target || !block || !target.element.isConnected) {
      addBlock({ type: 'text', text: token, key: blockKey() }, `placeholder-${placeholder}`)
      return
    }
    const current = (block as Record<string, unknown>)[target.field]
    const { value, cursor } = insertToken(
      typeof current === 'string' ? current : '',
      target.element.selectionStart,
      target.element.selectionEnd,
      token
    )
    setBlocks((items) => updateBlock(items, target.key, { [target.field]: value }))
    flash(`placeholder-${placeholder}`)
    requestAnimationFrame(() => {
      target.element.focus()
      target.element.setSelectionRange(cursor, cursor)
    })
  }

  const shortcutBlock = (shortcut: Shortcut): EditorBlock => ({
    type: 'section',
    key: blockKey(),
    heading: t(`transcription.export.shortcuts.${shortcut}.heading`),
    instruction: t(`transcription.export.shortcuts.${shortcut}.instruction`)
  })

  // The sections a preview can be asked for: those with an instruction, as many as allowed.
  const previewable = blocks
    .filter((block): block is SectionBlock => block.type === 'section')
    .filter((block) => block.instruction.trim())
    .slice(0, TRANSCRIPTION_PREVIEW_SECTIONS_MAX)
  const stale = staleSections(cache, transcriptId, name, previewable)

  const runPreview = async (sections: SectionBlock[], wanted: SectionBlock[]): Promise<void> => {
    if (!transcriptId) {
      toast({ variant: 'error', title: t('transcription.export.noTranscriptLoaded') })
      return
    }
    if (wanted.length === 0) return
    const templateName = name
    const requested = sections.map((section) => ({
      id: section.key,
      heading: section.heading,
      instruction: section.instruction
    }))
    const ids = wanted.map((section) => section.key)
    const asked = requested.filter((section) => ids.includes(section.id))
    const without = (map: Readonly<Record<string, string>>): Record<string, string> =>
      Object.fromEntries(Object.entries(map).filter(([key]) => !ids.includes(key)))
    setGenerating((current) => new Set([...current, ...ids]))
    setSectionErrors(without)
    try {
      const response = await previewSummary({
        transcriptId,
        sections: requested,
        staleSectionIds: ids
      })
      setStored((current) => {
        const next = withPreviewResults(
          current.cache,
          transcriptId,
          templateName,
          asked,
          response.results
        )
        if (current.key) writePreviewCache(window.localStorage, current.key, next)
        return { key: current.key, cache: next }
      })
      const failed = Object.fromEntries(
        ids.flatMap((id) =>
          response.results[id] !== undefined
            ? []
            : [[id, response.errors[id] ?? t('transcription.export.generationFailed')]]
        )
      )
      if (Object.keys(failed).length > 0) setSectionErrors((current) => ({ ...current, ...failed }))
    } catch (error) {
      const message =
        error instanceof ApiRequestError
          ? t('transcription.export.generationFailedPrefix') +
            (error.body?.error.message ?? t('transcription.common.error'))
          : wanted.length === 1
            ? t('transcription.export.sectionConnectionError')
            : t('transcription.export.previewConnectionError')
      toast({ variant: 'error', title: message })
      setSectionErrors((current) => ({
        ...current,
        ...Object.fromEntries(ids.map((id) => [id, message]))
      }))
    } finally {
      setGenerating((current) => new Set([...current].filter((id) => !ids.includes(id))))
    }
  }

  const submit = (): void => {
    const trimmed = name.trim()
    if (!trimmed) {
      setNameInvalid(true)
      nameRef.current?.focus()
      toast({
        variant: 'error',
        title: t('transcription.export.nameRequiredTitle'),
        description: t('transcription.export.nameRequiredShort')
      })
      return
    }
    save.mutate(
      {
        id: draft.id,
        name: trimmed,
        description: draft.description,
        structure: toStructure(blocks)
      },
      {
        onSuccess: (template) => {
          templateActions.select(template.id)
          templateActions.closeEditor(false)
        },
        onError: (error) =>
          toast({
            variant: 'error',
            title: t('transcription.common.error'),
            description:
              error instanceof ApiRequestError
                ? t('transcription.export.saveFailed') +
                  (error.body?.error.message ?? t('transcription.common.unknown'))
                : t('transcription.export.formatSaveConnectionError')
          })
      }
    )
  }

  const placeholderLabels: Record<TranscriptionPlaceholder, string> = {
    title: t('transcription.export.insertTitle'),
    date: t('transcription.export.insertDate'),
    participants: t('transcription.export.insertParticipants'),
    duration: t('transcription.export.insertDuration')
  }
  const shortcutLabels: Record<Shortcut, string> = {
    summary: t('transcription.export.insertSummary'),
    todos: t('transcription.export.insertTodos'),
    decisions: t('transcription.export.insertDecisions'),
    results: t('transcription.export.insertResults'),
    keyPoints: t('transcription.export.insertKeyPoints'),
    quotes: t('transcription.export.insertQuotes'),
    topics: t('transcription.export.insertTopics'),
    free: t('transcription.export.insertFreeAi')
  }
  const busy = generating.size > 0

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-stack-sm">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('transcription.common.back')}
              onClick={() => templateActions.closeEditor(true)}
            >
              <ArrowLeftIcon {...ICON} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('transcription.common.back')}</TooltipContent>
        </Tooltip>
        <CardTitle asChild>
          <h2>{t('transcription.export.editTemplate')}</h2>
        </CardTitle>
        <div className="flex min-w-48 flex-1 flex-col">
          <Label htmlFor={nameId} className="sr-only">
            {t('transcription.export.templateNamePlaceholder')}
          </Label>
          <Input
            id={nameId}
            ref={nameRef}
            value={name}
            maxLength={TRANSCRIPTION_TEMPLATE_NAME_MAX}
            placeholder={t('transcription.export.templateNamePlaceholder')}
            aria-invalid={nameInvalid || undefined}
            onChange={(event) => {
              setName(event.target.value)
              setNameInvalid(false)
            }}
          />
        </div>
        <Button type="button" disabled={save.isPending} onClick={submit}>
          {save.isPending ? (
            <Spinner size="sm" label={t('transcription.common.saving')} />
          ) : (
            <SaveIcon {...ICON} />
          )}
          {t('transcription.common.save')}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-stack-lg lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-stack-lg">
          <PanelSection title={t('transcription.export.elementPalette')}>
            <div className="flex flex-col gap-stack-md">
              <PaletteGroup label={t('transcription.export.paletteData')}>
                {PLACEHOLDERS.map((placeholder) => (
                  <PaletteButton
                    key={placeholder}
                    label={placeholderLabels[placeholder]}
                    inserted={inserted === `placeholder-${placeholder}`}
                    onClick={() => insertPlaceholder(placeholder)}
                  />
                ))}
              </PaletteGroup>
              <PaletteGroup label={t('transcription.export.paletteStatic')}>
                <PaletteButton
                  label={t('transcription.export.insertHeading')}
                  inserted={inserted === 'heading'}
                  onClick={() =>
                    addBlock(
                      {
                        type: 'heading',
                        level: 2,
                        text: t('transcription.export.newHeading'),
                        key: blockKey()
                      },
                      'heading'
                    )
                  }
                />
                <PaletteButton
                  label={t('transcription.export.insertTextField')}
                  inserted={inserted === 'text'}
                  onClick={() =>
                    addBlock(
                      { type: 'text', text: t('transcription.export.newText'), key: blockKey() },
                      'text'
                    )
                  }
                />
                <PaletteButton
                  label={t('transcription.export.insertDivider')}
                  inserted={inserted === 'divider'}
                  onClick={() => addBlock({ type: 'divider', key: blockKey() }, 'divider')}
                />
              </PaletteGroup>
              <PaletteGroup label={t('transcription.export.paletteAi')}>
                {SHORTCUTS.map((shortcut) => (
                  <PaletteButton
                    key={shortcut}
                    label={shortcutLabels[shortcut]}
                    inserted={inserted === `ai-${shortcut}`}
                    onClick={() => addBlock(shortcutBlock(shortcut), `ai-${shortcut}`)}
                  />
                ))}
              </PaletteGroup>
            </div>
          </PanelSection>
          <BlockList
            blocks={blocks}
            onChange={setBlocks}
            onFocusField={(field) => {
              focused.current = field
            }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-stack-lg">
          <PanelSection
            title={t('transcription.export.resultLooksLike')}
            aside={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={stale.length === 0 || busy}
                onClick={() => void runPreview(previewable, stale)}
              >
                {busy ? (
                  <Spinner size="sm" label={t('transcription.export.generatingPreview')} />
                ) : (
                  <FlaskConicalIcon {...ICON} />
                )}
                {busy
                  ? t('transcription.export.generatingPreview')
                  : t('transcription.export.testPreview')}
              </Button>
            }
          >
            <div className="flex flex-col gap-stack-md">
              <Alert variant="info">
                <InfoIcon aria-hidden="true" />
                <AlertDescription>{t('transcription.export.testPreviewNotice')}</AlertDescription>
              </Alert>
              <Card>
                <CardContent className="flex flex-col gap-stack-md">
                  <EditorPreview
                    blocks={blocks}
                    fill={(text) => fillPlaceholders(text, values)}
                    preview={(block) => sectionPreview(cache, transcriptId, name, block)}
                    generating={generating}
                    errors={sectionErrors}
                    onRefresh={(block) =>
                      void runPreview(
                        previewable.some((section) => section.key === block.key)
                          ? previewable
                          : [block],
                        [block]
                      )
                    }
                  />
                </CardContent>
              </Card>
            </div>
          </PanelSection>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * A row of palette buttons under its label.
 * DS gap: no heading for a group of actions; `Label` gives it the label's look.
 */
function PaletteGroup({
  label,
  children
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-stack-sm">
      <Label id={id}>{label}</Label>
      <div className="flex flex-wrap gap-stack-sm">{children}</div>
    </div>
  )
}

/** A palette button that says "Eingefügt" for a moment after its use. */
function PaletteButton({
  label,
  inserted,
  onClick
}: {
  label: string
  inserted: boolean
  onClick: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={label}
      // Keeps the field's focus and cursor for the placeholder it inserts.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {inserted ? (
        <>
          <CheckIcon {...ICON} />
          <span aria-live="polite">{t('transcription.export.inserted')}</span>
        </>
      ) : (
        label
      )}
    </Button>
  )
}

/** The type's name as the block's head shows it. */
function useBlockTypeLabel(): (block: EditorBlock) => string {
  const { t } = useTranslation()
  return (block) => {
    switch (block.type) {
      case 'heading':
        return t('transcription.export.heading')
      case 'text':
        return t('transcription.export.textSection')
      case 'divider':
        return t('transcription.export.divider')
      case 'section':
        return t('transcription.export.aiSectionGenerated')
    }
  }
}

/** A block's name for screen reader announcements: its type and the start of its text. */
function useBlockName(): (block: EditorBlock | undefined) => string {
  const typeLabel = useBlockTypeLabel()
  return (block) => {
    if (!block) return ''
    const text =
      block.type === 'section' ? block.heading : block.type === 'divider' ? '' : block.text
    const short = text.trim().slice(0, 40)
    return short ? `${typeLabel(block)}: ${short}` : typeLabel(block)
  }
}

/**
 * The template's blocks in order. Each moves with its arrows or by dragging its handle, with the
 * pointer or the keyboard (space, arrows, space), and can be deleted.
 */
function BlockList({
  blocks,
  onChange,
  onFocusField
}: {
  blocks: EditorBlock[]
  onChange: (change: (blocks: EditorBlock[]) => EditorBlock[]) => void
  onFocusField: (field: FocusedField) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const blockName = useBlockName()
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const positionOf = (key: unknown): number => blocks.findIndex((block) => block.key === key) + 1
  const nameOf = (key: unknown): string => blockName(blocks.find((block) => block.key === key))
  const total = blocks.length
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      t('transcription.export.dnd.pickedUp', {
        name: nameOf(active.id),
        position: positionOf(active.id),
        total
      }),
    onDragOver: ({ active, over }) =>
      over
        ? t('transcription.export.dnd.over', {
            name: nameOf(active.id),
            position: positionOf(over.id),
            total
          })
        : undefined,
    onDragEnd: ({ active, over }) =>
      over
        ? t('transcription.export.dnd.dropped', {
            name: nameOf(active.id),
            position: positionOf(over.id),
            total
          })
        : t('transcription.export.dnd.cancelled', { name: nameOf(active.id) }),
    onDragCancel: ({ active }) =>
      t('transcription.export.dnd.cancelled', { name: nameOf(active.id) })
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={({ active, over }) => {
        if (over) onChange((current) => moveBlockTo(current, String(active.id), String(over.id)))
      }}
      accessibility={{
        announcements,
        screenReaderInstructions: { draggable: t('transcription.export.dnd.instructions') }
      }}
    >
      <SortableContext
        items={blocks.map((block) => block.key)}
        strategy={verticalListSortingStrategy}
      >
        <ol className="m-0 flex list-none flex-col gap-stack-md p-0">
          {blocks.map((block, index) => (
            <BlockEditor
              key={block.key}
              block={block}
              first={index === 0}
              last={index === blocks.length - 1}
              name={blockName(block)}
              onMove={(direction) => onChange((current) => moveBlock(current, index, direction))}
              onDelete={() => onChange((current) => removeBlock(current, block.key))}
              onUpdate={(change) => onChange((current) => updateBlock(current, block.key, change))}
              onFocusField={onFocusField}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  )
}

function IconAction({
  label,
  onClick,
  disabled,
  destructive,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  destructive?: boolean
  children: ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant={destructive ? 'ghost-destructive' : 'ghost'}
          size="icon"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function BlockEditor({
  block,
  first,
  last,
  name,
  onMove,
  onDelete,
  onUpdate,
  onFocusField
}: {
  block: EditorBlock
  first: boolean
  last: boolean
  /** The block's name for its controls' labels. */
  name: string
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
  onUpdate: (change: Partial<Omit<EditorBlock, 'key' | 'type'>>) => void
  onFocusField: (field: FocusedField) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const typeLabel = useBlockTypeLabel()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: block.key })
  const focus =
    (field: FocusedField['field']) =>
    (event: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>): void =>
      onFocusField({ key: block.key, field, element: event.currentTarget })

  return (
    <li
      ref={setNodeRef}
      // Where the dragged block is drawn; the library computes it.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('flex flex-col', isDragging && 'opacity-60')}
    >
      <Card>
        <CardContent className="flex flex-col gap-stack-sm">
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  ref={setActivatorNodeRef}
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="cursor-grab touch-none"
                  {...attributes}
                  {...listeners}
                  aria-label={`${t('transcription.export.dragToMove')}: ${name}`}
                >
                  <GripVerticalIcon {...ICON} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('transcription.export.dragToMove')}</TooltipContent>
            </Tooltip>
            <Badge tone={block.type === 'section' ? 'secondary' : 'neutral'}>
              {typeLabel(block)}
            </Badge>
            <span className="ml-auto flex items-center">
              <IconAction
                label={`${t('transcription.export.moveUp')}: ${name}`}
                disabled={first}
                onClick={() => onMove(-1)}
              >
                <ArrowUpIcon {...ICON} />
              </IconAction>
              <IconAction
                label={`${t('transcription.export.moveDown')}: ${name}`}
                disabled={last}
                onClick={() => onMove(1)}
              >
                <ArrowDownIcon {...ICON} />
              </IconAction>
              <IconAction
                label={`${t('transcription.common.delete')}: ${name}`}
                destructive
                onClick={onDelete}
              >
                <Trash2Icon {...ICON} />
              </IconAction>
            </span>
          </div>
          {block.type === 'heading' ? (
            <div className="flex flex-wrap items-center gap-stack-sm">
              <Select
                value={String(block.level)}
                onValueChange={(value) => onUpdate({ level: Number(value) as 1 | 2 | 3 })}
              >
                <SelectTrigger aria-label={t('transcription.export.headingLevel')} className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {([1, 2, 3] as const).map((level) => (
                    <SelectItem key={level} value={String(level)}>
                      {`H${level} (${'#'.repeat(level)})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={block.text}
                maxLength={TRANSCRIPTION_TEMPLATE_TEXT_MAX}
                aria-label={t('transcription.export.heading')}
                placeholder={t('transcription.export.headingTextPlaceholder')}
                onFocus={focus('text')}
                onChange={(event) => onUpdate({ text: event.target.value })}
                className="min-w-40 flex-1"
              />
            </div>
          ) : block.type === 'text' ? (
            <Textarea
              value={block.text}
              rows={2}
              maxLength={TRANSCRIPTION_TEMPLATE_TEXT_MAX}
              aria-label={t('transcription.export.textSection')}
              placeholder={t('transcription.export.enterTextPlaceholder')}
              onFocus={focus('text')}
              onChange={(event) => onUpdate({ text: event.target.value })}
            />
          ) : block.type === 'section' ? (
            <>
              <Input
                value={block.heading}
                maxLength={TRANSCRIPTION_TEMPLATE_TEXT_MAX}
                aria-label={t('transcription.export.section')}
                placeholder={t('transcription.export.sectionNamePlaceholder')}
                onFocus={focus('heading')}
                onChange={(event) => onUpdate({ heading: event.target.value })}
              />
              <Textarea
                value={block.instruction}
                rows={3}
                maxLength={TRANSCRIPTION_TEMPLATE_TEXT_MAX}
                aria-label={t('transcription.export.instructionPlaceholder')}
                placeholder={t('transcription.export.instructionPlaceholder')}
                onFocus={focus('instruction')}
                onChange={(event) => onUpdate({ instruction: event.target.value })}
              />
            </>
          ) : null}
        </CardContent>
      </Card>
    </li>
  )
}

/**
 * The template as it will look (T-52, T-53): the static blocks with the placeholders filled, as
 * Markdown, and each AI section with its test output, marked when its instruction changed since.
 */
function EditorPreview({
  blocks,
  fill,
  preview,
  generating,
  errors,
  onRefresh
}: {
  blocks: EditorBlock[]
  fill: (text: string) => string
  preview: (block: SectionBlock) => ReturnType<typeof sectionPreview>
  generating: ReadonlySet<string>
  errors: Readonly<Record<string, string>>
  onRefresh: (block: SectionBlock) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const parts: ReactNode[] = []
  let markdown: string[] = []
  const flush = (key: string): void => {
    if (markdown.length === 0) return
    parts.push(<PreviewMarkdown key={`md-${key}`} markdown={markdown.join('\n\n')} />)
    markdown = []
  }
  for (const block of blocks) {
    if (block.type === 'heading') markdown.push(`${'#'.repeat(block.level)} ${fill(block.text)}`)
    else if (block.type === 'text') markdown.push(fill(block.text))
    else if (block.type === 'divider') markdown.push('---')
    else {
      flush(block.key)
      parts.push(
        <SectionPreview
          key={block.key}
          heading={fill(block.heading) || t('transcription.export.section')}
          state={preview(block)}
          generating={generating.has(block.key)}
          error={errors[block.key] ?? null}
          canRefresh={Boolean(block.instruction.trim())}
          onRefresh={() => onRefresh(block)}
        />
      )
    }
  }
  flush('end')
  return <>{parts}</>
}

function PreviewMarkdown({ markdown }: { markdown: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Suspense fallback={<Spinner label={t('transcription.common.loading')} />}>
      <MarkdownView markdown={markdown} />
    </Suspense>
  )
}

function SectionPreview({
  heading,
  state,
  generating,
  error,
  canRefresh,
  onRefresh
}: {
  heading: string
  state: ReturnType<typeof sectionPreview>
  generating: boolean
  error: string | null
  canRefresh: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const refreshLabel = t('transcription.export.refreshSection', { heading })
  return (
    <PanelSection
      title={heading}
      aside={
        <span className="flex items-center gap-1">
          {state.status === 'stale' && !generating ? (
            <>
              <Badge tone="warning">{t('transcription.export.instructionChanged')}</Badge>
              <Button
                type="button"
                variant="link"
                size="sm"
                disabled={!canRefresh}
                aria-label={refreshLabel}
                onClick={onRefresh}
              >
                {t('transcription.export.refresh')}
              </Button>
            </>
          ) : null}
          <IconAction label={refreshLabel} disabled={!canRefresh || generating} onClick={onRefresh}>
            <RefreshCwIcon {...ICON} />
          </IconAction>
        </span>
      }
    >
      {generating ? (
        <div
          role="status"
          aria-label={t('transcription.export.generatingPreview')}
          className="flex flex-col gap-stack-sm"
        >
          {/* DS gap: there is no Skeleton; the bars use the surface tokens. */}
          <div
            aria-hidden="true"
            className="h-3 w-full animate-pulse rounded-full bg-surface-container-high"
          />
          <div
            aria-hidden="true"
            className="h-3 w-2/3 animate-pulse rounded-full bg-surface-container-high"
          />
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : state.status === 'empty' ? (
        <p className="m-0">{t('transcription.export.noAiContentYet')}</p>
      ) : (
        <PreviewMarkdown markdown={state.output} />
      )}
    </PanelSection>
  )
}
