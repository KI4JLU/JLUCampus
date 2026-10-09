import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeftIcon,
  BookMarkedIcon,
  BookmarkIcon,
  ChevronRightIcon,
  EyeIcon,
  FileCode2Icon,
  FileTextIcon,
  LanguagesIcon,
  PenLineIcon,
  RefreshCwIcon,
  SettingsIcon,
  SparklesIcon,
  UserRoundIcon,
  WandSparklesIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Checkbox,
  Label,
  NavItem,
  PanelSection,
  Spinner,
  Switch
} from '@ki4jlu/design-system'
import {
  REPHRASE_STYLES,
  REPHRASE_TONES,
  type TranslatorEngine,
  type TranslatorGlossary
} from '@justcampus/shared'
import type { TranslatorState, TranslatorMode } from './translator-store'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

const MODE_ICONS: Record<TranslatorMode, ReactNode> = {
  translate: <LanguagesIcon {...ICON} />,
  documents: <FileTextIcon {...ICON} />,
  rephrase: <WandSparklesIcon {...ICON} />,
  create: <PenLineIcon {...ICON} />
}

type Subview = 'model' | 'glossaries' | 'style' | null

export interface TranslatorSidebarProps {
  id: string
  state: TranslatorState
  /** The modes offered, in order. */
  modes: readonly TranslatorMode[]
  engines: readonly TranslatorEngine[]
  /** The engine the current mode works with. */
  engine: TranslatorEngine | null
  /** What the model picker calls the models' group. */
  llmProvider: string | null
  glossaries: readonly TranslatorGlossary[] | undefined
  /** Whether the user may use glossaries; without, their row is left out. */
  glossariesOffered: boolean
  onMode: (mode: TranslatorMode) => void
  onEngine: (engine: TranslatorEngine) => void
  onLive: (live: boolean) => void
  onShowChanges: (show: boolean) => void
  onAiContextMenu: (on: boolean) => void
  onFormatting: (on: boolean) => void
  onGlossaries: (ids: string[]) => void
  onManageGlossaries: () => void
  onStyle: (style: (typeof REPHRASE_STYLES)[number]) => void
  onTone: (tone: (typeof REPHRASE_TONES)[number]) => void
  onFormality: (formality: 'formal' | 'informal') => void
  onResetStyle: () => void
  /** Whether the modes head the column; narrow screens show them above the work area instead. */
  showModes?: boolean
}

/**
 * The translator's settings, in the shell's column right of the work area: the modes, the language
 * model, the editing tools of the mode, and the adjustments. Model, glossaries and writing style
 * open views of their own within the column, with a heading and a way back.
 */
export function TranslatorSidebar(props: TranslatorSidebarProps): React.JSX.Element {
  const { t } = useTranslation()
  const { id, state, engine, showModes = true } = props
  const [subview, setSubview] = useState<Subview>(null)
  const opener = useRef<HTMLButtonElement | null>(null)
  const mode = state.mode
  const documents = mode === 'documents'

  const open = (view: Exclude<Subview, null>, trigger: HTMLButtonElement): void => {
    opener.current = trigger
    setSubview(view)
  }
  const close = (): void => {
    setSubview(null)
    // Back where the view was opened from, once the main view is there again.
    requestAnimationFrame(() => opener.current?.focus())
  }

  const styleValue = state.style
    ? t(`component.translator.styles.${state.style}`)
    : state.tone
      ? t(`component.translator.tones.${state.tone}`)
      : state.formality !== 'default'
        ? t(`component.translator.formalities.${state.formality}`)
        : t('component.translator.styleDefault')
  const glossaryCount = `${state.glossaryIds.length}/${props.glossaries?.length ?? 0}`
  const deepl = engine?.kind === 'deepl'
  const models =
    mode === 'create' ? props.engines.filter((option) => option.kind === 'llm') : props.engines

  return (
    <>
      {/* Kept while a view is open, so the row that opened it can take the focus back. */}
      <div hidden={subview !== null} className="flex flex-col gap-stack-lg">
        {showModes ? (
          <ul aria-label={t('component.translator.mode')} className="m-0 grid list-none gap-1 p-0">
            {props.modes.map((option) => {
              const active = mode === option
              return (
                <li key={option}>
                  <NavItem
                    type="button"
                    level="sub"
                    active={active}
                    // A choice within the page, not a page of its own.
                    aria-current={active ? 'true' : undefined}
                    onClick={() => props.onMode(option)}
                  >
                    {MODE_ICONS[option]}
                    <span>{t(`component.translator.modes.${option}`)}</span>
                  </NavItem>
                </li>
              )
            })}
          </ul>
        ) : null}

        <PanelSection titleId={`${id}-model-title`} title={t('component.translator.engine')}>
          <SidebarRow
            icon={<UserRoundIcon {...ICON} />}
            label={engine?.label ?? t('component.translator.selectModel')}
            disabled={documents || props.engines.length === 0}
            onOpen={(trigger) => open('model', trigger)}
            describedBy={`${id}-model-title`}
          />
        </PanelSection>

        {documents ? null : (
          <PanelSection title={t('component.translator.tools')}>
            {mode === 'create' ? (
              <>
                <ToggleRow
                  id={`${id}-ai-menu`}
                  icon={<SparklesIcon {...ICON} />}
                  label={t('component.translator.aiContextMenu')}
                  checked={state.aiContextMenu}
                  onChange={props.onAiContextMenu}
                />
                <ToggleRow
                  id={`${id}-formatting`}
                  icon={<FileCode2Icon {...ICON} />}
                  label={t('component.translator.formatting')}
                  checked={state.formatting}
                  onChange={props.onFormatting}
                />
              </>
            ) : (
              <>
                <ToggleRow
                  id={`${id}-live`}
                  icon={<RefreshCwIcon {...ICON} />}
                  label={t('component.translator.live')}
                  // DeepL has no live mode: the switch stays, greyed out.
                  checked={state.live}
                  disabled={deepl}
                  onChange={props.onLive}
                />
                {mode === 'rephrase' ? (
                  <ToggleRow
                    id={`${id}-changes`}
                    icon={<EyeIcon {...ICON} />}
                    label={t('component.translator.showChanges')}
                    checked={state.showChanges}
                    onChange={props.onShowChanges}
                  />
                ) : null}
              </>
            )}
          </PanelSection>
        )}

        <PanelSection title={t('component.translator.options')}>
          {props.glossariesOffered && (mode === 'translate' || documents) ? (
            <SidebarRow
              icon={<BookMarkedIcon {...ICON} />}
              label={t('component.translator.glossaries.title')}
              value={glossaryCount}
              onOpen={(trigger) => open('glossaries', trigger)}
            />
          ) : null}
          <SidebarRow
            icon={<BookmarkIcon {...ICON} />}
            label={t('component.translator.styleTitle')}
            value={styleValue}
            onOpen={(trigger) => open('style', trigger)}
          />
        </PanelSection>
      </div>

      {subview === 'model' ? (
        <Subview
          title={t('component.translator.engine')}
          hint={models.length === 0 ? t('component.translator.noModels') : undefined}
          onBack={close}
        >
          <ModelList
            engines={models}
            selected={engine?.id ?? null}
            llmProvider={props.llmProvider}
            onSelect={(choice) => {
              props.onEngine(choice)
              close()
            }}
          />
        </Subview>
      ) : null}

      {subview === 'glossaries' ? (
        <Subview
          title={t('component.translator.glossaries.title')}
          aside={glossaryCount}
          hint={
            props.glossaries?.length === 0 ? t('component.translator.glossaries.none') : undefined
          }
          onBack={close}
          footer={
            <Button
              type="button"
              variant="outline"
              onClick={props.onManageGlossaries}
              className="w-full"
            >
              <SettingsIcon {...ICON} />
              {t('component.translator.glossaries.manage')}
            </Button>
          }
        >
          {props.glossaries === undefined ? (
            <Spinner label={t('component.translator.glossaries.loading')} className="self-center" />
          ) : props.glossaries.length > 0 ? (
            <GlossaryChoice
              id={id}
              glossaries={props.glossaries}
              selected={state.glossaryIds}
              onChange={props.onGlossaries}
            />
          ) : null}
        </Subview>
      ) : null}

      {subview === 'style' ? (
        <Subview title={t('component.translator.styleTitle')} onBack={close}>
          <StylePanel
            state={state}
            full={mode === 'rephrase' || mode === 'create'}
            onStyle={(style) => {
              props.onStyle(style)
              close()
            }}
            onTone={(tone) => {
              props.onTone(tone)
              close()
            }}
            onFormality={(formality) => {
              props.onFormality(formality)
              close()
            }}
            onReset={props.onResetStyle}
          />
        </Subview>
      ) : null}
    </>
  )
}

/** A row that opens a view of the column: icon, label, the current value, a chevron. */
function SidebarRow({
  icon,
  label,
  value,
  disabled,
  describedBy,
  onOpen
}: {
  icon: ReactNode
  label: string
  value?: string
  disabled?: boolean
  describedBy?: string
  onOpen: (trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  return (
    <NavItem
      type="button"
      level="sub"
      disabled={disabled}
      aria-describedby={describedBy}
      onClick={(event) => onOpen(event.currentTarget)}
      // DS gap: NavItem has no disabled state; this is the one `Label` and `Switch` use.
      className="disabled:cursor-not-allowed disabled:opacity-60"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {value ? <Badge className="shrink-0">{value}</Badge> : null}
      <ChevronRightIcon {...ICON} />
    </NavItem>
  )
}

/** A switch with its icon and label. */
function ToggleRow({
  id,
  icon,
  label,
  checked,
  disabled,
  onChange
}: {
  id: string
  icon: ReactNode
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    // The switch comes first, so the label greys out with it (`peer-disabled`); shown reversed.
    <div className="flex min-h-10 flex-row-reverse items-center justify-between gap-3 px-3">
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        className="peer"
      />
      <Label htmlFor={id} className="flex min-w-0 items-center gap-3">
        {icon}
        <span className="truncate">{label}</span>
      </Label>
    </div>
  )
}

/** A view within the column: a way back, then its heading and content. */
function Subview({
  title,
  aside,
  hint,
  onBack,
  footer,
  children
}: {
  title: string
  aside?: string
  /** Muted text under the heading, as when there is nothing to choose. */
  hint?: string
  onBack: () => void
  footer?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const back = useRef<HTMLButtonElement>(null)
  useEffect(() => back.current?.focus(), [])
  return (
    <div
      role="region"
      aria-label={title}
      className="flex flex-col items-start gap-stack-md"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onBack()
      }}
    >
      <Button ref={back} type="button" variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeftIcon {...ICON} />
        {t('component.translator.back')}
      </Button>
      <PanelSection title={title} aside={aside} hint={hint} className="self-stretch">
        {children}
      </PanelSection>
      {footer}
    </div>
  )
}

/** The engines by provider: DeepL, then the AI models under their provider's name. */
function ModelList({
  engines,
  selected,
  llmProvider,
  onSelect
}: {
  engines: readonly TranslatorEngine[]
  selected: string | null
  llmProvider: string | null
  onSelect: (engine: TranslatorEngine) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const groups = [
    { name: 'DeepL', engines: engines.filter((engine) => engine.kind === 'deepl') },
    {
      name: llmProvider || t('component.translator.llmProvider'),
      engines: engines.filter((engine) => engine.kind === 'llm')
    }
  ].filter((group) => group.engines.length > 0)
  return (
    <>
      {groups.map((group) => (
        <PanelSection key={group.name} title={group.name}>
          <ul className="m-0 grid list-none grid-cols-1 gap-1 p-0">
            {group.engines.map((engine) => {
              const active = engine.id === selected
              return (
                <li key={engine.id}>
                  <NavItem
                    type="button"
                    level="sub"
                    active={active}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => onSelect(engine)}
                  >
                    <Badge appearance="text" tone="success" dot aria-hidden="true" />
                    <span className="truncate">{engine.label}</span>
                  </NavItem>
                </li>
              )
            })}
          </ul>
        </PanelSection>
      ))}
    </>
  )
}

/** The glossaries with a checkbox each; several can be on at once. */
function GlossaryChoice({
  id,
  glossaries,
  selected,
  onChange
}: {
  id: string
  glossaries: readonly TranslatorGlossary[]
  selected: readonly string[]
  onChange: (ids: string[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <ul className="m-0 grid list-none grid-cols-1 gap-1 p-0">
      {glossaries.map((glossary) => {
        const checkboxId = `${id}-glossary-${glossary.id}`
        return (
          <li key={glossary.id} className="flex min-h-10 items-center gap-3 px-3">
            <Checkbox
              id={checkboxId}
              checked={selected.includes(glossary.id)}
              onCheckedChange={(value) =>
                onChange(
                  value === true
                    ? [...selected, glossary.id]
                    : selected.filter((other) => other !== glossary.id)
                )
              }
            />
            <Label htmlFor={checkboxId} className="flex min-w-0 flex-1 items-baseline gap-2">
              <span className="truncate">{glossary.name}</span>
              <span className="shrink-0">
                {`• ${t('component.translator.glossaries.terms', { count: glossary.entryCount })}`}
              </span>
            </Label>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Writing style, tone and formality, one at a time: "Standard" clears them. Translating offers
 * the formality alone; rewriting and the editor offer all three.
 */
function StylePanel({
  state,
  full,
  onStyle,
  onTone,
  onFormality,
  onReset
}: {
  state: TranslatorState
  full: boolean
  onStyle: (style: (typeof REPHRASE_STYLES)[number]) => void
  onTone: (tone: (typeof REPHRASE_TONES)[number]) => void
  onFormality: (formality: 'formal' | 'informal') => void
  onReset: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const standard = !state.style && !state.tone && state.formality === 'default'
  return (
    <>
      <ChoiceRow
        label={t('component.translator.styleDefault')}
        active={standard}
        onSelect={onReset}
      />
      {full ? (
        <>
          <ChoiceGroup
            title={t('component.translator.style')}
            options={REPHRASE_STYLES.map((style) => ({
              key: style,
              label: t(`component.translator.styles.${style}`),
              active: state.style === style,
              onSelect: () => onStyle(style)
            }))}
          />
          <ChoiceGroup
            title={t('component.translator.tone')}
            options={REPHRASE_TONES.map((tone) => ({
              key: tone,
              label: t(`component.translator.tones.${tone}`),
              active: state.tone === tone,
              onSelect: () => onTone(tone)
            }))}
          />
        </>
      ) : null}
      <ChoiceGroup
        title={t('component.translator.formality')}
        options={(['formal', 'informal'] as const).map((formality) => ({
          key: formality,
          label: t(`component.translator.formalities.${formality}`),
          active: state.formality === formality,
          onSelect: () => onFormality(formality)
        }))}
      />
    </>
  )
}

function ChoiceGroup({
  title,
  options
}: {
  title: string
  options: Array<{ key: string; label: string; active: boolean; onSelect: () => void }>
}): React.JSX.Element {
  return (
    <PanelSection title={title}>
      {options.map((option) => (
        <ChoiceRow
          key={option.key}
          label={option.label}
          active={option.active}
          onSelect={option.onSelect}
        />
      ))}
    </PanelSection>
  )
}

/** One choice of the style view, pressed while it is the current one. */
function ChoiceRow({
  label,
  active,
  onSelect
}: {
  label: string
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <NavItem
      type="button"
      level="sub"
      active={active}
      aria-pressed={active}
      // A setting, not the current page: `aria-pressed` tells which one is on.
      aria-current={undefined}
      onClick={onSelect}
    >
      <span>{label}</span>
    </NavItem>
  )
}
