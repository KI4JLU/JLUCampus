import { useEffect } from 'react'
import type { TranscriptionTemplate } from '@justcampus/shared'
import { onSignOut } from '@/lib/sign-out-cleanups'
import { createStore, useStore } from '../export/store'
import type { TemplateDraft } from './structure'

/**
 * The summary template in use, the chooser and the editor (T-50, T-51). The choice lives as long
 * as the page, like kiChat's `selectedTemplate`; until the user picks one, a transcript's last
 * used template applies, else kiChat's default. It belongs to one user in one module (`scope`):
 * another user, another module or a sign-out start afresh, so nobody sees another person's
 * template in the editor (T-54).
 */

/** kiChat's preselected template (`TranscriptExportDefaultTemplateName`, "Mein Interview-Format"). */
export const DEFAULT_SUMMARY_TEMPLATE_ID = 'mein-interview-format'

export interface TemplateState {
  /** `<user>:<module>` the state belongs to; `null` while the user is not known. */
  scope: string | null
  /** The template the user picked; `null` before. */
  selectedId: string | null
  libraryOpen: boolean
  /** The template in the editor; `null` while it is closed. */
  draft: TemplateDraft | null
  /** Counts editor openings, so each starts afresh. */
  session: number
}

const EMPTY: Omit<TemplateState, 'scope' | 'session'> = {
  selectedId: null,
  libraryOpen: false,
  draft: null
}

export const templateStore = createStore<TemplateState>({ ...EMPTY, scope: null, session: 0 })

/** The scope of the templates of one user in one module. */
export function templateScope(userId: string | undefined, componentId: string): string | null {
  return userId ? `${userId}:${componentId}` : null
}

/** The state if it belongs to `scope`, else an empty one; a new scope clears the store. */
export function useTemplateState(scope: string | null): TemplateState {
  const state = useStore(templateStore)
  useEffect(() => templateActions.enterScope(scope), [scope])
  return state.scope === scope ? state : { ...EMPTY, scope, session: state.session }
}

export const templateActions = {
  /** Starts afresh unless the state already belongs to `scope`. */
  enterScope: (scope: string | null): void => {
    if (templateStore.get().scope !== scope) templateActions.reset(scope)
  },
  /** Forgets the choice and closes the editor and chooser, e.g. on sign-out. */
  reset: (scope: string | null = null): void =>
    templateStore.set((state) => ({ ...EMPTY, scope, session: state.session + 1 })),
  select: (id: string): void => templateStore.set({ selectedId: id }),
  openLibrary: (): void => templateStore.set({ libraryOpen: true }),
  setLibraryOpen: (libraryOpen: boolean): void => templateStore.set({ libraryOpen }),
  openEditor: (draft: TemplateDraft): void =>
    templateStore.set((state) => ({ draft, libraryOpen: false, session: state.session + 1 })),
  /** Leaves the editor; back to the chooser unless the template was saved. */
  closeEditor: (backToLibrary: boolean): void =>
    templateStore.set({ draft: null, libraryOpen: backToLibrary }),
  /** After a template was deleted: forget it if it was the one in use (T-54). */
  deleted: (id: string): void => {
    if (templateStore.get().selectedId === id) templateStore.set({ selectedId: null })
  }
}

/**
 * The template summaries use: the picked one, the transcript's last one, kiChat's default, or the
 * first there is; a picked one that no longer exists gives way to the next (T-54).
 */
export function activeTemplate(
  templates: readonly TranscriptionTemplate[] | undefined,
  selectedId: string | null,
  lastUsedId: string | null
): TranscriptionTemplate | null {
  if (!templates || templates.length === 0) return null
  for (const id of [selectedId, lastUsedId, DEFAULT_SUMMARY_TEMPLATE_ID]) {
    const found = id ? templates.find((template) => template.id === id) : undefined
    if (found) return found
  }
  return templates[0] ?? null
}

// The editor may hold the user's own template; the next person must not find it.
onSignOut(() => templateActions.reset())
