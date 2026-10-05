import { useEffect } from 'react'
import { useTranscriptionWorkspace } from '../use-workspace'
import { takeTranscriptionTarget } from './target-store'

/**
 * Opens what a dashboard widget asked for (`setTranscriptionTarget`) when the page mounts. It
 * renders nothing; `RecordingProvider` mounts it inside the workspace.
 */
export function WidgetTargetReceiver(): null {
  const { component, setView, openTranscript } = useTranscriptionWorkspace()

  useEffect(() => {
    const target = takeTranscriptionTarget(component.id)
    if (!target) return
    if ('transcriptId' in target) void openTranscript(target.transcriptId)
    else setView(target.view)
    // Once per page: later changes of the workspace are the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.id])

  return null
}
