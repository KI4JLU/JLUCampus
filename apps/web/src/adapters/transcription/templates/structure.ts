import { arrayMove } from '@dnd-kit/sortable'
import type { TranscriptionTemplate, TranscriptionTemplateBlock } from '@justcampus/shared'

/**
 * A summary template's blocks while they are edited (T-51): each with a key for the list, the
 * drag and drop and, for AI sections, the preview's section id.
 */
export type EditorBlock = TranscriptionTemplateBlock & { key: string }

/** What the editor works on: kiChat's `editorTemplate`. */
export interface TemplateDraft {
  /** `null` for a new template or a copy of a built-in; saving creates it then. */
  id: string | null
  name: string
  description: string
  blocks: EditorBlock[]
}

let counter = 0
/** A key unique within the page. */
export function blockKey(): string {
  counter += 1
  return `b${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/** Keys for a template's blocks; sections keep a saved id while it is unique. */
export function toEditorBlocks(structure: readonly TranscriptionTemplateBlock[]): EditorBlock[] {
  const used = new Set<string>()
  return structure.map((block) => {
    const saved = block.type === 'section' ? block.id : undefined
    const key = saved && !used.has(saved) ? saved : blockKey()
    used.add(key)
    return { ...block, key }
  })
}

/** The blocks as they are saved, in order; sections keep their key as id. */
export function toStructure(blocks: readonly EditorBlock[]): TranscriptionTemplateBlock[] {
  return blocks.map((block): TranscriptionTemplateBlock => {
    switch (block.type) {
      case 'heading':
        return { type: 'heading', level: block.level, text: block.text }
      case 'text':
        return { type: 'text', text: block.text }
      case 'divider':
        return { type: 'divider' }
      case 'section':
        return {
          type: 'section',
          id: block.key,
          heading: block.heading,
          instruction: block.instruction
        }
    }
  })
}

/** Swaps a block with its neighbour above (`-1`) or below (`1`), as kiChat's arrows do. */
export function moveBlock(
  blocks: readonly EditorBlock[],
  index: number,
  direction: -1 | 1
): EditorBlock[] {
  const target = index + direction
  if (index < 0 || index >= blocks.length || target < 0 || target >= blocks.length) {
    return [...blocks]
  }
  const next = [...blocks]
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  return next
}

/** Moves a dragged block to where another one was. */
export function moveBlockTo(
  blocks: readonly EditorBlock[],
  fromKey: string,
  toKey: string
): EditorBlock[] {
  const from = blocks.findIndex((block) => block.key === fromKey)
  const to = blocks.findIndex((block) => block.key === toKey)
  if (from === -1 || to === -1 || from === to) return [...blocks]
  return arrayMove([...blocks], from, to)
}

export function removeBlock(blocks: readonly EditorBlock[], key: string): EditorBlock[] {
  return blocks.filter((block) => block.key !== key)
}

/** Changes one block, keeping its key and type. */
export function updateBlock(
  blocks: readonly EditorBlock[],
  key: string,
  change: Partial<Omit<EditorBlock, 'key' | 'type'>>
): EditorBlock[] {
  return blocks.map((block) =>
    block.key === key ? ({ ...block, ...change } as EditorBlock) : block
  )
}

/** The texts a new template starts with. */
export interface NewTemplateTexts {
  name: string
  sectionHeading: string
  sectionInstruction: string
}

/**
 * kiChat's new template: the title as heading, date and participants as text, and one summary
 * section.
 */
export function newTemplateDraft(texts: NewTemplateTexts): TemplateDraft {
  return {
    id: null,
    name: texts.name,
    description: '',
    blocks: toEditorBlocks([
      { type: 'heading', level: 1, text: '{{titel}}' },
      { type: 'text', text: 'Datum: {{datum}} · {{teilnehmer}}' },
      { type: 'section', heading: texts.sectionHeading, instruction: texts.sectionInstruction }
    ])
  }
}

/**
 * A template opened in the editor: the user's own as it is, a built-in (or `copy`) as a new
 * template named by `copyName` (T-50).
 */
export function templateDraft(
  template: TranscriptionTemplate,
  copy: boolean,
  copyName: (name: string) => string
): TemplateDraft {
  const asCopy = copy || template.builtIn
  return {
    id: asCopy ? null : template.id,
    name: asCopy ? copyName(template.name) : template.name,
    description: template.description,
    blocks: toEditorBlocks(template.structure)
  }
}

/** The AI sections' headings, ` · ` between them: the line under a template's name (T-50). */
export function templateSubtext(structure: readonly TranscriptionTemplateBlock[]): string {
  return structure
    .flatMap((block) =>
      block.type === 'section' && block.heading.trim() ? [block.heading.trim()] : []
    )
    .join(' · ')
}

/** Whether a template's name or subtext contains the search, ignoring case and outer blanks. */
export function matchesTemplateSearch(template: TranscriptionTemplate, search: string): boolean {
  const query = search.trim().toLowerCase()
  if (!query) return true
  return (
    template.name.toLowerCase().includes(query) ||
    templateSubtext(template.structure).toLowerCase().includes(query)
  )
}
