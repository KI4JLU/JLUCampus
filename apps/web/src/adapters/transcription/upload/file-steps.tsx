import { Fragment, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { CheckIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { QueueFile } from './queue'
import {
  FILE_STEPS,
  fileSteps,
  type FileStep,
  type FileSteps as Steps,
  type StepIndex
} from './steps'
import { errorText, percentText, statusText } from './texts'

/** How long the finished steps stay: the last check turns green, rests, and the row collapses. */
const LEAVE_MS = 1300
/** How long a step change glides: the next circle over to the active place, its body open. */
const MOVE_MS = 450
const MOVE_EASE = 'cubic-bezier(0.2, 0, 0, 1)'

const CIRCLE =
  'grid size-6 shrink-0 place-items-center rounded-full border font-label-sm text-label-sm transition duration-500 ease-out motion-reduce:transition-none'
const LAYER =
  'col-start-1 row-start-1 transition-opacity duration-500 motion-reduce:transition-none'
const TEXT = 'font-label-sm text-label-sm'
const MARK = { 'aria-hidden': true, className: 'size-3.5', strokeWidth: 3 } as const

/** What the active step shows beside its circle; kept for a step while its body closes. */
interface Body {
  steps: Steps
  error: string | null
}

function sameBody(a: Body | null, b: Body | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.error === b.error &&
    a.steps.active === b.steps.active &&
    a.steps.state === b.steps.state &&
    a.steps.percent === b.steps.percent &&
    a.steps.detail === b.steps.detail
  )
}

/**
 * A file's way through its four steps (`steps.ts`) on one line: the steps done as checks on the
 * left, the active one with its name and a bar over the remaining width, the upcoming ones as
 * numbers on the right. When the active step changes, every circle stays the same element: the
 * finished one turns into a green check where it is, the next one glides over to the active place
 * as the old step's body closes and its own opens out of it, the bar growing with it. Once the file
 * is completed, the last check turns green and the line collapses; a file completed when its row
 * appears shows none. Screen readers get the steps as a list, the active one's bar as the
 * progressbar, and hear when the active step or its status changes, not every percent.
 *
 * DS gap: no Stepper / Progress; circles, lines and bar are composed from the DS colour tokens
 * (the pastel `primary-fixed-dim` for the active step and its fill, as asked for over `primary`),
 * the glow of a bar without percentage eases with an arbitrary symmetric curve, and the glide of a
 * step change animates the bodies' `flex-grow` with the Web Animations API on an arbitrary curve.
 */
export function FileSteps({ file }: { file: QueueFile }): React.JSX.Element | null {
  const { t } = useTranslation()
  // Remembered so a failed transcription shows in the step it failed in.
  const [previous, setPrevious] = useState<StepIndex | null>(null)
  const steps = fileSteps(file, previous)
  if (steps && steps.state !== 'error' && steps.active !== previous) setPrevious(steps.active)
  const finished = steps === null
  const [gone, setGone] = useState(finished)
  if (!finished && gone) setGone(false)
  useEffect(() => {
    if (!finished || gone) return
    const timer = setTimeout(() => setGone(true), LEAVE_MS)
    return () => clearTimeout(timer)
  }, [finished, gone])

  const body: Body | null = steps
    ? { steps, error: steps.state === 'error' && file.error ? errorText(t, file.error) : null }
    : null
  // The body last shown, so a step left keeps what it showed while its body closes.
  const [shown, setShown] = useState(body)
  const [closing, setClosing] = useState<Body[]>([])
  if (!sameBody(body, shown)) {
    setShown(body)
    if (shown && shown.steps.active !== body?.steps.active) {
      const left = shown.steps.active
      setClosing((bodies) => [
        ...bodies.filter((b) => b.steps.active !== left && b.steps.active !== body?.steps.active),
        shown
      ])
    }
  }
  if (gone) return null

  const label = (step: FileStep): string => t(`transcription.upload.steps.${step}`)
  const active = steps?.active ?? FILE_STEPS.length
  const current = steps
    ? [
        t(`transcription.upload.steps.${steps.state}`, { step: label(FILE_STEPS[steps.active]) }),
        body?.error ?? (steps.detail ? statusText(t, steps.detail) : null)
      ]
        .filter(Boolean)
        .join(', ')
    : t('transcription.upload.transcriptionComplete')

  return (
    // Collapses its row when it leaves; only then clipped, so the active circle's ring shows.
    <div
      className={cn(
        'grid grid-cols-1 transition-[grid-template-rows,opacity] duration-500 ease-out motion-reduce:transition-none',
        finished ? 'grid-rows-[0fr] opacity-0 delay-700' : 'grid-rows-[1fr]'
      )}
    >
      <div className={cn('min-h-0', finished && 'overflow-hidden')}>
        <ol
          aria-label={t('transcription.upload.steps.label', { name: file.name })}
          className="sr-only"
        >
          {FILE_STEPS.map((step, index) => (
            <li key={step}>
              {index === active
                ? current
                : t(`transcription.upload.steps.${index < active ? 'done' : 'upcoming'}`, {
                    step: label(step)
                  })}
            </li>
          ))}
        </ol>
        <span aria-live="polite" className="sr-only">
          {current}
        </span>
        {/* No gap: a body closed to nothing takes no room, the lines space the circles. */}
        <div className="flex min-w-0 items-center py-1">
          {FILE_STEPS.map((step, index) => {
            const live = body?.steps.active === index ? body : null
            const shut = live ? undefined : closing.find((b) => b.steps.active === index)
            return (
              <Fragment key={step}>
                {index > 0 ? <Line done={index <= active} /> : null}
                <Circle
                  index={index}
                  state={
                    index < active || !steps ? 'done' : index > active ? 'upcoming' : steps.state
                  }
                />
                {/* One key, so a body left keeps its element and closes from where it is. */}
                {live ? (
                  <StepBody
                    key="body"
                    body={live}
                    label={label(step)}
                    name={file.name}
                    moving={closing.length > 0}
                  />
                ) : shut ? (
                  <StepBody
                    key="body"
                    body={shut}
                    label={label(step)}
                    name={file.name}
                    closing
                    onClosed={() =>
                      setClosing((bodies) => bodies.filter((b) => b.steps.active !== index))
                    }
                  />
                ) : null}
              </Fragment>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Line({ done }: { done: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'mx-1.5 h-0.5 w-3 shrink-0 rounded-full transition-colors duration-500 motion-reduce:transition-none',
        done ? 'bg-success' : 'bg-outline-variant'
      )}
    />
  )
}

/**
 * A step's circle, the same element whatever the step's state, so its colours cross-fade: the
 * number (a cross when it failed) and the check lie on top of each other and swap by opacity.
 */
function Circle({
  index,
  state
}: {
  index: number
  state: Steps['state'] | 'done' | 'upcoming'
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        CIRCLE,
        state === 'done'
          ? 'border-success bg-success text-on-success'
          : state === 'upcoming'
            ? 'border-outline-variant text-on-surface-variant'
            : state === 'error'
              ? 'border-error bg-error text-on-error'
              : state === 'waiting'
                ? 'border-2 border-primary-fixed-dim text-on-surface'
                : 'border-primary-fixed-dim bg-primary-fixed-dim text-on-primary-fixed ring-2 ring-primary-fixed-dim/40'
      )}
    >
      <span className={cn(LAYER, state === 'done' && 'opacity-0')}>
        {state === 'error' ? <XIcon {...MARK} /> : index + 1}
      </span>
      <CheckIcon {...MARK} className={cn(MARK.className, LAYER, state !== 'done' && 'opacity-0')} />
    </span>
  )
}

/**
 * The active step's body beside its circle: its name, what it waits for or why it failed, and its
 * bar with the percentage while it runs. Taking the remaining width, it opens from nothing when
 * the step becomes active through a change (not when the row appears), and closes to nothing,
 * no longer read out, when the step is left; both glide from where it is, so a change during a
 * change goes on smoothly.
 */
function StepBody({
  body,
  label,
  name,
  moving = false,
  closing = false,
  onClosed
}: {
  body: Body
  label: string
  name: string
  /** Another step's body is closing, so this one opens. */
  moving?: boolean
  closing?: boolean
  onClosed?: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { state, percent, detail } = body.steps
  const { error } = body
  const ref = useRef<HTMLDivElement>(null)
  // Opens only if it came with a step change, not when the row appeared.
  const [enter] = useState(moving)
  const mounted = useRef(false)
  const closed = useEffectEvent(() => onClosed?.())
  useLayoutEffect(() => {
    const element = ref.current
    const first = !mounted.current
    mounted.current = true
    if (!element || (first && !enter && !closing)) return
    // From its current share and opacity, which a running animation shows in the computed style.
    const style = getComputedStyle(element)
    const [grow, opacity] = first ? [0, 0] : [Number(style.flexGrow), Number(style.opacity)]
    const to = closing ? 0 : 1
    for (const running of element.getAnimations()) running.cancel()
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const animation = element.animate(
      { flexGrow: [grow, to], opacity: [opacity, to] },
      { duration: reduced ? 0 : MOVE_MS, easing: MOVE_EASE, fill: closing ? 'forwards' : 'none' }
    )
    // Closed, it stays shut until it is gone.
    if (closing) animation.onfinish = () => closed()
  }, [closing, enter])

  return (
    // Clips what does not fit while it opens or closes; the circle with its ring stays outside.
    <div
      ref={ref}
      aria-hidden={closing || undefined}
      className="flex min-w-0 flex-1 overflow-hidden"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 ps-2">
        <span
          aria-hidden="true"
          className={cn(TEXT, 'shrink-0', state === 'error' ? 'text-error' : 'text-on-surface')}
        >
          {label}
        </span>
        {error !== null ? (
          <span aria-hidden="true" className={cn(TEXT, 'min-w-0 flex-1 text-error')}>
            {error}
          </span>
        ) : (
          <>
            {detail ? (
              <span
                aria-hidden="true"
                className={cn(TEXT, 'min-w-0 truncate text-on-surface-variant')}
              >
                {statusText(t, detail)}
              </span>
            ) : null}
            {state === 'running' ? (
              <div
                role="progressbar"
                aria-label={t('transcription.upload.steps.progressOf', { name, step: label })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
                className={cn(
                  'relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full',
                  percent !== null
                    ? 'bg-outline-variant'
                    : 'bg-primary-fixed-dim/80 motion-reduce:bg-primary-fixed-dim/60'
                )}
              >
                {percent !== null ? (
                  <div
                    className="h-full rounded-full bg-primary-fixed-dim transition-[width] duration-500 ease-out motion-reduce:transition-none"
                    style={{ width: `${percent}%` }}
                  />
                ) : (
                  // Without a percentage a light grey glow with soft ends glides over the light blue
                  // bar, from just left of it to just right of it, so the loop has no seam; when motion
                  // is reduced, the still bar only turns a shade paler.
                  <div className="absolute inset-y-0 left-full w-2/5 bg-linear-to-r from-transparent via-secondary-fixed to-transparent animate-in slide-in-from-left-[350%] repeat-infinite animation-duration-2000 ease-[cubic-bezier(0.45,0,0.55,1)] motion-reduce:hidden" />
                )}
              </div>
            ) : (
              <span
                aria-hidden="true"
                className="h-0.5 min-w-4 flex-1 rounded-full bg-outline-variant"
              />
            )}
            {percent !== null ? (
              <span
                aria-hidden="true"
                className={cn(TEXT, 'shrink-0 text-on-surface-variant tabular-nums')}
              >
                {percentText(i18n.language, percent)}
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
