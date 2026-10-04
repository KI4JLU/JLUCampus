import type { TranscriptionTemplate } from '@justcampus/shared'
import { createStore, useStore } from '../export/store'
import type { TemplateDraft } from './structure'

/**
 * The summary template in use, the chooser and the editor (T-50, T-51). The choice lives as long
 * as the page, like kiChat's `selectedTemplate`; until the user picks one, a transcript's last
 * used template applies, else kiChat's default.
 */

/** kiChat's preselected template (`TranscriptExportDefaultTemplateName`, "Mein Interview-Format"). */
export const DEFAULT_SUMMARY_TEMPLATE_ID = 'mein-interview-format'

export interface TemplateState {
  /** The template the user picked; `null` before. */
  selectedId: string | null
  libraryOpen: boolean
  /** The template in the editor; `null` while it is closed. */
  draft: TemplateDraft | null
  /** Counts editor openings, so each starts afresh. */
  session: number
}

export const templateStore = createStore<TemplateState>({
  selectedId: null,
  libraryOpen: false,
  draft: null,
  session: 0
})

export function useTemplateState(): TemplateState {
  return useStore(templateStore)
}

export const templateActions = {
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
