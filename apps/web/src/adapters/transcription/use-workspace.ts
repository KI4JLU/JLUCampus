import { createContext, useContext } from 'react'
import type { TranscriptionWorkspace } from './workspace'

/** Provided by `TranscriptionWorkspaceProvider` in `workspace.tsx`. */
export const WorkspaceContext = createContext<TranscriptionWorkspace | null>(null)

/** The shared state of the transcription page; only inside `TranscriptionWorkspaceProvider`. */
export function useTranscriptionWorkspace(): TranscriptionWorkspace {
  const workspace = useContext(WorkspaceContext)
  if (!workspace)
    throw new Error('useTranscriptionWorkspace outside TranscriptionWorkspaceProvider')
  return workspace
}
