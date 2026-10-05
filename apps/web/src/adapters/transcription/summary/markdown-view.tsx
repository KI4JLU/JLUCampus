import { useEffect } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { TableKit } from '@tiptap/extension-table'

/**
 * Markdown shown read-only, with the Tiptap and Markdown extensions the translator's AI editor
 * already uses, so summaries render their headings, lists, quotes and tables (T-48). Tiptap builds
 * the elements from its schema, so no HTML of the model's answer reaches the page.
 *
 * DS gap: the design system has no rich-text ("prose") styles (see the AI editor's `PROSE`); the
 * elements are styled from the root in the DS type scale and semantic tokens.
 */
const PROSE =
  'text-body-base text-on-surface outline-none [&_blockquote]:border-s-4 [&_blockquote]:border-outline-variant [&_blockquote]:ps-4 [&_blockquote]:text-on-surface-variant [&_code]:rounded [&_code]:bg-surface-container-high [&_code]:px-1 [&_code]:font-mono [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:font-headline-md [&_h1]:text-headline-md [&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:font-headline-md-mobile [&_h2]:text-headline-md-mobile [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-label-sm [&_h3]:text-body-base [&_hr]:my-4 [&_hr]:border-outline-variant [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:ps-6 [&_p]:my-2 [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-outline-variant [&_td]:p-2 [&_th]:border [&_th]:border-outline-variant [&_th]:bg-surface-container [&_th]:p-2 [&_th]:text-start [&_ul]:list-disc [&_ul]:ps-6 [&>*:first-child]:mt-0'

export interface MarkdownViewProps {
  markdown: string
  /** Names the region for screen readers. */
  label?: string
}

export default function MarkdownView({ markdown, label }: MarkdownViewProps): React.JSX.Element {
  const editor = useEditor({
    extensions: [StarterKit, TableKit.configure({ table: { resizable: false } }), Markdown],
    content: markdown,
    contentType: 'markdown',
    editable: false,
    immediatelyRender: true,
    editorProps: {
      attributes: { class: PROSE, ...(label ? { 'aria-label': label } : {}) }
    }
  })

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    if (editor.getMarkdown() !== markdown) {
      editor.commands.setContent(markdown, { contentType: 'markdown' })
    }
  }, [editor, markdown])

  return <EditorContent editor={editor} />
}
