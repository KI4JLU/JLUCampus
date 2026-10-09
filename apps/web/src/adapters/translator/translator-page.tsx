import { lazy, Suspense, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { TriangleAlertIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Container,
  SegmentedControl,
  Spinner
} from '@ki4jlu/design-system'
import { toTranslatorLanguage } from '@justcampus/shared'
import { ComponentIcon } from '@/components/component-icon'
import { PageHeader } from '@/components/page-header'
import { PageSidePanel } from '@/components/page-side-panel'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  detectLanguage,
  fetchSuggestions,
  rephraseText,
  translateText,
  useTranslatorEngines,
  useTranslatorGlossaries
} from '@/lib/queries'
import { useComponentName } from '@/lib/component-name'
import { useFeature } from '@/lib/features'
import { SIDE_PANEL_MEDIA } from '@/lib/page-side-panel'
import { useMediaQuery } from '@/lib/use-media-query'
import { cn } from '@/lib/utils'
import type { ComponentViewProps } from '../types'
import { IconAction } from './copy-button'
import { DocumentTranslator, type DocumentDropTarget } from './document-translator'
import { GlossaryDialog } from './glossary-dialog'
import { TextBoard } from './text-board'
import { TranslatorSidebar, type TranslatorSidebarProps } from './translator-sidebar'
import {
  parseSession,
  SESSION_KEY,
  TRANSLATOR_MODES,
  TranslatorStore,
  type TranslatorMode
} from './translator-store'

// The editor brings a rich-text engine and the export libraries; only who opens it loads them.
const KiEditor = lazy(() =>
  import('./editor/ki-editor').then((module) => ({ default: module.KiEditor }))
)

/** Whether a drag carries files from the computer. */
function carriesFiles(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

/**
 * The translator, laid out after HAWKI's: the work area under a notice that the feature is being
 * tested, and the settings in the shell's column on the right, collapsible and resizable like the
 * navigation: the modes (translate a text, translate documents, rewrite a text, create a text with
 * the AI editor), the language model and the settings of the mode. Below `lg` the modes sit above
 * the work area and the settings in a card below it. The state lives in the tab's session, so a
 * reload keeps text and settings. Documents, rewriting, the editor and glossaries are functions a
 * user's roles may not allow; the page leaves them out then.
 */
export function TranslatorPage({ component }: ComponentViewProps<'translator'>): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const id = useId()
  const engines = useTranslatorEngines()
  const canDocuments = useFeature('translator.documents')
  const canRephrase = useFeature('translator.rephrase')
  const canCompose = useFeature('translator.compose')
  const canGlossaries = useFeature('translator.glossaries')
  const glossaries = useTranslatorGlossaries(canGlossaries)
  const [manageGlossaries, setManageGlossaries] = useState(false)
  const dropTarget = useRef<DocumentDropTarget | null>(null)
  const wide = useMediaQuery(SIDE_PANEL_MEDIA)
  // The AI editor's maximised view, kept while other modes are shown, as HAWKI's is. It fills the
  // work area; from `lg` up the settings column beside it stays usable.
  const [editorMaximized, setEditorMaximized] = useState(false)

  const [store] = useState(() => {
    const defaultTarget = toTranslatorLanguage(component.config.defaultTargetLanguage) ?? 'en-gb'
    let stored: string | null = null
    let storage: Storage | null = null
    try {
      storage = window.sessionStorage
      stored = storage.getItem(SESSION_KEY)
    } catch {
      storage = null
    }
    return new TranslatorStore(
      {
        translate: translateText,
        rephrase: rephraseText,
        detect: detectLanguage,
        suggest: fetchSuggestions
      },
      parseSession(stored, defaultTarget),
      storage
    )
  })
  useEffect(() => () => store.dispose(), [store])
  const state = useSyncExternalStore(store.subscribe, store.getState)

  const list = engines.data
  const documents = (list?.documents ?? false) && canDocuments
  useEffect(() => {
    store.setContext({
      engines: list?.engines ?? [],
      defaultEngine: list?.defaultEngine ?? null,
      documents,
      rephrase: canRephrase,
      create: canCompose,
      // Without the function no glossary applies, so none stays selected.
      glossaryIds: !canGlossaries
        ? []
        : glossaries.data
          ? glossaries.data.glossaries.map((glossary) => glossary.id)
          : null
    })
  }, [store, list, documents, canRephrase, canCompose, canGlossaries, glossaries.data])

  const notSetUp = list?.engines.length === 0
  const hasLlm = list?.engines.some((engine) => engine.kind === 'llm') ?? false
  const permitted = (mode: TranslatorMode): boolean =>
    mode === 'documents'
      ? canDocuments
      : mode === 'rephrase'
        ? canRephrase
        : mode === 'create'
          ? canCompose
          : true
  const modes = TRANSLATOR_MODES.filter(
    (mode) =>
      permitted(mode) && (mode !== 'documents' || documents) && (mode !== 'create' || hasLlm)
  )
  // A mode that is not offered (any more) shows translating instead; what the module offers is
  // known with the engines, what the user may use at once.
  const mode: TranslatorMode =
    (list && !modes.includes(state.mode)) || !permitted(state.mode) ? 'translate' : state.mode
  const engine = store.engineFor(mode)
  const maximized = mode === 'create' && editorMaximized

  const switchMode = (next: TranslatorMode): void => store.switchMode(next)

  const sidebarProps: TranslatorSidebarProps = {
    id: `${id}-sidebar`,
    state: { ...state, mode },
    modes,
    engines: list?.engines ?? [],
    engine,
    llmProvider: list?.llmProvider ?? null,
    glossaries: glossaries.data?.glossaries,
    glossariesOffered: canGlossaries,
    onMode: switchMode,
    onEngine: (choice) => store.selectEngine(choice.id),
    onLive: (live) => store.setLive(live),
    onShowChanges: (show) => store.setShowChanges(show),
    onAiContextMenu: (on) => store.setAiContextMenu(on),
    onFormatting: (on) => store.setFormatting(on),
    onGlossaries: (ids) => store.setGlossaries(ids),
    onManageGlossaries: () => setManageGlossaries(true),
    onStyle: (style) => store.selectStyle(style),
    onTone: (tone) => store.selectTone(tone),
    onFormality: (formality) => store.selectFormality(formality),
    onResetStyle: () => store.resetStyle()
  }

  return (
    <>
      <div
        className={cn('min-h-0 flex-1', maximized ? 'overflow-hidden' : 'overflow-y-auto')}
        onDragEnter={(event) => {
          // Files dragged over the text go to the document translator, as in HAWKI. The settings
          // column is rendered from here too, so drags over it arrive as well.
          if (!carriesFiles(event) || mode === 'documents' || !documents) return
          if (mode === 'translate' || mode === 'rephrase') {
            event.preventDefault()
            switchMode('documents')
          }
        }}
        onDragOver={(event) => {
          if (carriesFiles(event) && mode === 'documents') event.preventDefault()
        }}
        onDrop={(event) => {
          if (!carriesFiles(event) || mode !== 'documents') return
          event.preventDefault()
          dropTarget.current?.addFiles(Array.from(event.dataTransfer.files))
        }}
      >
        <Container
          size="page"
          className={cn(
            'flex flex-col gap-stack-lg py-gutter md:py-margin-page',
            maximized && 'h-full'
          )}
        >
          <PageHeader
            title={
              <>
                <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} />
                <span className="truncate">{componentName(component)}</span>
              </>
            }
          />
          {state.noticeClosed ? null : (
            <Alert variant="warning">
              <AlertDescription>{t('component.translator.notice')}</AlertDescription>
              <AlertAction>
                <IconAction
                  label={t('component.translator.closeNotice')}
                  onClick={() => store.closeNotice()}
                >
                  <XIcon aria-hidden="true" className="size-4" />
                </IconAction>
              </AlertAction>
            </Alert>
          )}
          {/* From `lg` up the modes head the column on the right. */}
          {wide || modes.length < 2 ? null : (
            <SegmentedControl
              aria-label={t('component.translator.mode')}
              options={modes.map((option) => ({
                value: option,
                label: t(`component.translator.modesShort.${option}`)
              }))}
              value={mode}
              onValueChange={(next) => {
                const choice = modes.find((option) => option === next)
                if (choice) switchMode(choice)
              }}
              className="self-start"
            />
          )}
          {notSetUp ? (
            <Alert variant="warning">
              <TriangleAlertIcon aria-hidden="true" />
              <AlertTitle>{t('component.translator.notSetUpTitle')}</AlertTitle>
              <AlertDescription>{t('component.translator.notSetUpDescription')}</AlertDescription>
            </Alert>
          ) : null}
          {documents ? (
            // Kept while other modes are shown, so a batch goes on translating meanwhile.
            <div hidden={mode !== 'documents'}>
              <DocumentTranslator
                ref={dropTarget}
                target={state.docTargetLang}
                onTarget={(language) => store.setDocTargetLang(language)}
                formality={state.formality}
                glossaryIds={state.glossaryIds}
              />
            </div>
          ) : null}
          {mode === 'documents' ? null : mode === 'create' ? (
            <Suspense
              fallback={
                <Spinner label={t('component.translator.editor.loading')} className="self-center" />
              }
            >
              <KiEditor
                store={store}
                maximized={editorMaximized}
                onMaximized={setEditorMaximized}
              />
            </Suspense>
          ) : (
            <TextBoard
              id={id}
              store={store}
              disabled={notSetUp || !list}
              canRephrase={canRephrase}
            />
          )}
          <PageSidePanel
            label={t('component.translator.settings')}
            fallback={
              // Narrow, the maximised editor takes the whole area; the settings return with it.
              maximized ? null : (
                <Card>
                  <CardHeader>
                    <CardTitle asChild>
                      <h2>{t('component.translator.settings')}</h2>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <TranslatorSidebar {...sidebarProps} showModes={false} />
                  </CardContent>
                </Card>
              )
            }
          >
            <TranslatorSidebar {...sidebarProps} />
          </PageSidePanel>
        </Container>
      </div>
      {canGlossaries ? (
        <GlossaryDialog
          open={manageGlossaries}
          onOpenChange={setManageGlossaries}
          list={glossaries.data}
        />
      ) : null}
    </>
  )
}
