import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeftRightIcon, LanguagesIcon, WandSparklesIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, Label, Stack, Textarea } from '@ki4jlu/design-system'
import { TRANSLATE_TEXT_MAX } from '@justcampus/shared'
import { cn } from '@/lib/utils'
import { BOARD_INSET, boardTextSize, sourceBoardHtml } from './board-html'
import { CopyButton, IconAction } from './copy-button'
import { LanguageMenu } from './language-menu'
import { isTranslateShortcut, textErrorMessage } from './languages'
import { OutputBoard } from './output-board'
import { splitIntoSentences } from './sentences'
import type { TranslatorStore } from './translator-store'

interface TextBoardProps {
  id: string
  store: TranslatorStore
  /** The module lacks its settings: nothing can be sent. */
  disabled: boolean
  /** Whether the user may rewrite texts, and so pass the translation on to rewriting. */
  canRephrase: boolean
}

/**
 * A count as HAWKI writes it: in the browser's number format. The limit is part of its text and
 * written the German way in every language.
 */
const count = (length: number): string => length.toLocaleString()
const LIMIT = TRANSLATE_TEXT_MAX.toLocaleString('de-DE')

/**
 * Translating and rewriting, laid out after HAWKI's translator: the languages on top, the source
 * and the editable result side by side with their counts and actions below, and the main button
 * across the foot of the card. The button only works when something changed since the result;
 * live editing needs none and hides it.
 *
 * DS gap: there is no Separator, and Card's sub-parts come without rules, so the rules between
 * the card's parts are borders in the DS's divider token (`outline-variant`).
 */
export function TextBoard({ id, store, disabled, canRephrase }: TextBoardProps): React.JSX.Element {
  const { t } = useTranslation()
  const state = store.getState()
  const mode = store.textMode
  const buffer = store.buffer
  const translating = mode === 'translate'
  const textRef = useRef<HTMLTextAreaElement>(null)
  const replacedAll = useRef(false)
  const [focused, setFocused] = useState(false)
  const [hoveringSource, setHoveringSource] = useState(false)
  const [hoveredSource, setHoveredSource] = useState<number | null>(null)
  const [activeSource, setActiveSource] = useState<number | null>(null)
  // The result the source board was put away for, by pointing at or into the source.
  const [dismissed, setDismissed] = useState<object | null>(null)

  const target = store.targetText
  const small = buffer.source.length > 50 || target.length > 50
  const canRun = !disabled && store.hasChanges
  const run = (): void => {
    if (canRun) void store.run()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!isTranslateShortcut(event)) return
    event.preventDefault()
    run()
  }

  // As in HAWKI, a result lays the source out as the sentences it was made from, until the
  // pointer or the focus goes into the source; the sentence a result sentence belongs to is
  // marked there while that one is pointed at. So a swap whose request failed still shows the
  // text the result was made from.
  const processed = state.processed[mode]
  const unchanged = buffer.source.trim() === (processed?.text ?? '')
  const marked = activeSource ?? hoveredSource
  const showSourceBoard =
    !focused &&
    !hoveringSource &&
    !!target &&
    ((marked !== null && unchanged) || (processed !== null && dismissed !== processed))

  // HAWKI starts over on any input event of an emptied field, also one a script sends without a
  // change of the value, which React does not report.
  useEffect(() => {
    const element = textRef.current
    if (!element) return
    const onInput = (): void => {
      if (!element.value.trim()) store.setSource(element.value)
    }
    element.addEventListener('input', onInput)
    return () => element.removeEventListener('input', onInput)
  }, [store])
  const error = state.error ? textErrorMessage(state.error, mode) : null

  return (
    <Card className="@container overflow-hidden">
      {/* The swap button in the middle: both languages take an equal share beside it. */}
      <Stack
        direction="row"
        gap="sm"
        align="center"
        justify="center"
        className="min-h-14 border-b border-outline-variant p-stack-sm"
      >
        <div className={cn('flex min-w-0', translating && 'flex-1 justify-end')}>
          <LanguageMenu
            label={t('component.translator.source')}
            allowAuto
            value={buffer.sourceLang}
            onChange={(language) => store.setSourceLang(language)}
          />
        </div>
        {translating ? (
          <>
            <IconAction label={t('component.translator.swap')} onClick={() => store.swap()}>
              <ArrowLeftRightIcon aria-hidden="true" className="size-4" />
            </IconAction>
            <div className="flex min-w-0 flex-1 justify-start">
              <LanguageMenu
                label={t('component.translator.target')}
                value={buffer.targetLang}
                onChange={(language) => store.setTargetLang(language)}
              />
            </div>
          </>
        ) : null}
      </Stack>
      <div className="grid @2xl:grid-cols-2">
        <div className="flex min-w-0 flex-col">
          <div
            className="relative flex min-h-0 flex-1 flex-col"
            onMouseEnter={() => {
              setHoveringSource(true)
              setDismissed(processed)
            }}
            onMouseLeave={() => setHoveringSource(false)}
          >
            <Label htmlFor={`${id}-text`} className="sr-only">
              {t(translating ? 'component.translator.text' : 'component.translator.rephraseText')}
            </Label>
            <Textarea
              ref={textRef}
              id={`${id}-text`}
              variant="inline"
              value={buffer.source}
              maxLength={TRANSLATE_TEXT_MAX}
              dir="auto"
              lang={buffer.sourceLang === 'auto' ? undefined : buffer.sourceLang}
              aria-describedby={`${id}-count ${id}-hint`}
              aria-keyshortcuts="Control+Enter Meta+Enter"
              onBeforeInput={() => {
                const element = textRef.current
                replacedAll.current =
                  !!element &&
                  element.value.length > 0 &&
                  element.selectionStart === 0 &&
                  element.selectionEnd === element.value.length
              }}
              onChange={(event) => {
                store.setSource(event.target.value, replacedAll.current)
                replacedAll.current = false
              }}
              onKeyDown={onKeyDown}
              onFocus={() => {
                setFocused(true)
                setDismissed(processed)
              }}
              onBlur={() => setFocused(false)}
              className={cn('min-h-72 flex-1 resize-none', BOARD_INSET, boardTextSize(small))}
            />
            {showSourceBoard ? (
              <div
                aria-hidden="true"
                // Over the field, which stays there for the keyboard and screenreaders. DS gap: no
                // rich-text surface for a field; this one takes the field's (Card's) surface to
                // cover its text, and its insets and size.
                className={cn(
                  'pointer-events-none absolute inset-0 overflow-hidden bg-surface-container-lowest whitespace-pre-wrap break-words text-on-surface',
                  BOARD_INSET,
                  boardTextSize(small)
                )}
                // Escaped in `sourceBoardHtml`.
                dangerouslySetInnerHTML={{
                  __html: sourceBoardHtml(
                    unchanged ? buffer.source : buffer.lastSourceText,
                    unchanged ? splitIntoSentences(buffer.source.trim()) : buffer.sourceSentences,
                    activeSource,
                    hoveredSource
                  )
                }}
              />
            ) : null}
            {buffer.source ? null : (
              // DS gap: a field's placeholder is one line in one size; HAWKI's has two, the
              // second smaller. Both take the placeholder's colour (fieldVariants).
              <div
                id={`${id}-hint`}
                className={cn(
                  'pointer-events-none absolute inset-x-0 top-0 grid gap-gutter text-on-surface-variant',
                  BOARD_INSET,
                  boardTextSize(false)
                )}
              >
                <p className="m-0">{t('component.translator.placeholder')}</p>
                <p className={cn('m-0 max-w-md', boardTextSize(true))}>
                  {t('component.translator.placeholderDocuments')}
                </p>
              </div>
            )}
            {buffer.source ? (
              <IconAction
                label={t('component.translator.clear')}
                onClick={() => {
                  store.clearSource()
                  textRef.current?.focus()
                }}
                className="absolute end-3 top-3"
              >
                <XIcon aria-hidden="true" className="size-4" />
              </IconAction>
            ) : null}
          </div>
          <PaneFooter>
            <Badge id={`${id}-count`} appearance="text" tone="neutral">
              {t('component.translator.count', {
                length: count(buffer.source.length),
                max: LIMIT
              })}
            </Badge>
            <CopyButton text={buffer.source || undefined} whenEmpty="confirm" />
          </PaneFooter>
        </div>
        <div className="flex min-w-0 flex-col border-t border-outline-variant @2xl:border-t-0 @2xl:border-l">
          <OutputBoard
            id={`${id}-result`}
            store={store}
            label={t(
              translating ? 'component.translator.result' : 'component.translator.rephrased'
            )}
            language={
              translating
                ? buffer.targetLang
                : buffer.sourceLang === 'auto'
                  ? undefined
                  : buffer.sourceLang
            }
            small={small}
            onSourceHover={setHoveredSource}
            onSourceActive={setActiveSource}
          />
          <PaneFooter>
            <Badge appearance="text" tone="neutral">
              {t('component.translator.resultCount', { length: count(target.length) })}
            </Badge>
            <Stack direction="row" gap="sm" align="center">
              {target && translating && canRephrase ? (
                <IconAction
                  label={t('component.translator.improveResult')}
                  onClick={() => store.improveTarget()}
                  disabled={state.loading}
                >
                  <WandSparklesIcon aria-hidden="true" className="size-4" />
                </IconAction>
              ) : null}
              {target && !translating ? (
                <IconAction
                  label={t('component.translator.translateResult')}
                  onClick={() => store.translateTarget()}
                  disabled={state.loading}
                >
                  <LanguagesIcon aria-hidden="true" className="size-4" />
                </IconAction>
              ) : null}
              <CopyButton text={store.outputText || undefined} whenEmpty="confirm" />
            </Stack>
          </PaneFooter>
        </div>
      </div>
      {store.liveActive ? null : (
        <div className="border-t border-outline-variant p-stack-sm">
          <Button
            type="button"
            disabled={!canRun}
            aria-keyshortcuts="Control+Enter Meta+Enter"
            onClick={run}
            className="w-full"
          >
            {t(translating ? 'component.translator.translate' : 'component.translator.rephrase')}
          </Button>
        </div>
      )}
      {error ? (
        <div role="alert" className="border-t border-outline-variant px-stack-md py-stack-sm">
          <Badge appearance="text" tone="error">
            {'key' in error ? t(error.key) : error.text}
          </Badge>
        </div>
      ) : null}
    </Card>
  )
}

/** The foot of a pane: its character count and what can be done with its text. */
function PaneFooter({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Stack
      direction="row"
      gap="sm"
      align="center"
      justify="between"
      className="min-h-14 border-t border-outline-variant px-stack-md py-stack-sm"
    >
      {children}
    </Stack>
  )
}
