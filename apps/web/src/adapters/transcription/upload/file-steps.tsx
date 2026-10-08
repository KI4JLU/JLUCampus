import { Fragment, useEffect, useState } from 'react'
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

/** How long the finished steps stay: the last check pops in, rests, and the row collapses. */
const LEAVE_MS = 1300

const CIRCLE =
  'flex size-6 shrink-0 items-center justify-center rounded-full font-label-sm text-label-sm'
const TEXT = 'font-label-sm text-label-sm'
const MARK = { 'aria-hidden': true, className: 'size-3.5', strokeWidth: 3 } as const

/**
 * A file's way through its four steps (`steps.ts`) on one line: the steps done as checks on the
 * left, the active one with its name and a bar over the remaining width, the upcoming ones as
 * numbers on the right. Once the file is completed, the last check pops in and the line collapses;
 * a file completed when its row appears shows none. Screen readers get the steps as a list, the
 * active one's bar as the progressbar, and hear when the active step or its status changes, not
 * every percent.
 *
 * DS gap: no Stepper / Progress; circles, lines and bar are composed from the DS colour tokens.
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
  if (gone) return null

  const label = (step: FileStep): string => t(`transcription.upload.steps.${step}`)
  const active = steps?.active ?? FILE_STEPS.length
  const current = steps
    ? [
        t(`transcription.upload.steps.${steps.state}`, { step: label(FILE_STEPS[steps.active]) }),
        steps.state === 'error' && file.error
          ? errorText(t, file.error)
          : steps.detail
            ? statusText(t, steps.detail)
            : null
      ]
        .filter(Boolean)
        .join(', ')
    : t('transcription.upload.transcriptionComplete')

  return (
    // Collapses its row when it leaves; only then clipped, so the active circle's ring shows.
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-500 ease-out motion-reduce:transition-none',
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
        <div className="flex min-w-0 items-center gap-1.5 py-1">
          {FILE_STEPS.slice(0, active).map((step, index) => (
            // A step turning done mounts its check, which pops in.
            <Fragment key={step}>
              {index > 0 ? <Line done /> : null}
              <span
                aria-hidden="true"
                className={cn(
                  CIRCLE,
                  'bg-success text-on-success animate-in fade-in zoom-in-50 duration-300 motion-reduce:animate-none'
                )}
              >
                <CheckIcon {...MARK} />
              </span>
            </Fragment>
          ))}
          {steps ? (
            <>
              {active > 0 ? <Line done /> : null}
              <ActiveStep
                key={steps.active}
                steps={steps}
                label={label(FILE_STEPS[steps.active])}
                name={file.name}
                error={steps.state === 'error' && file.error ? errorText(t, file.error) : null}
              />
              {FILE_STEPS.slice(active + 1).map((step, offset) => (
                <Fragment key={step}>
                  <Line />
                  <span
                    aria-hidden="true"
                    className={cn(CIRCLE, 'border border-outline-variant text-on-surface-variant')}
                  >
                    {active + offset + 2}
                  </span>
                </Fragment>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Line({ done = false }: { done?: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn('h-0.5 w-3 shrink-0 rounded-full', done ? 'bg-success' : 'bg-outline-variant')}
    />
  )
}

/**
 * The active step, keyed by its index so each step slides in: its number (a cross when it failed),
 * its name, what it waits for or why it failed, and its bar with the percentage while it runs.
 */
function ActiveStep({
  steps,
  label,
  name,
  error
}: {
  steps: Steps
  label: string
  name: string
  error: string | null
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { active, state, percent, detail } = steps
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 animate-in fade-in slide-in-from-left-2 duration-500 motion-reduce:animate-none">
      <span
        aria-hidden="true"
        className={cn(
          CIRCLE,
          state === 'error'
            ? 'bg-error text-on-error'
            : state === 'waiting'
              ? 'border-2 border-primary text-primary'
              : 'bg-primary text-on-primary ring-2 ring-primary/25'
        )}
      >
        {state === 'error' ? <XIcon {...MARK} /> : active + 1}
      </span>
      <span
        aria-hidden="true"
        className={cn(TEXT, 'shrink-0', state === 'error' ? 'text-error' : 'text-primary')}
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
              className="relative h-1.5 min-w-8 flex-1 overflow-hidden rounded-full bg-outline-variant"
            >
              {percent !== null ? (
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
                  style={{ width: `${percent}%` }}
                />
              ) : (
                // Without a percentage a third of the bar sweeps across it; a still, paler bar
                // when motion is reduced.
                <div className="absolute inset-y-0 left-full w-1/3 rounded-full bg-primary animate-in slide-in-from-left-[400%] repeat-infinite animation-duration-1400 ease-in-out motion-reduce:left-0 motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-40" />
              )}
            </div>
          ) : (
            <span
              aria-hidden="true"
              className="h-0.5 min-w-4 flex-1 rounded-full bg-outline-variant"
            />
          )}
          {percent !== null ? (
            <span aria-hidden="true" className={cn(TEXT, 'shrink-0 text-primary tabular-nums')}>
              {percentText(i18n.language, percent)}
            </span>
          ) : null}
        </>
      )}
    </div>
  )
}
