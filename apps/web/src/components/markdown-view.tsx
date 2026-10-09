import { useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { Heading, type Level } from '@tiptap/extension-heading'
import { TableKit } from '@tiptap/extension-table'
import { Marked, type marked } from 'marked'

/**
 * Markdown shown read-only, with the Tiptap and Markdown extensions the translator's AI editor
 * already uses, so summaries and announcements render their headings, lists, quotes, links and
 * tables (T-48). Tiptap builds the elements from its schema, so no HTML in the text reaches the
 * page.
 *
 * DS gap: the design system has no rich-text ("prose") styles (see the AI editor's `PROSE`); the
 * elements are styled from the root in the DS type scale and semantic tokens.
 */
const PROSE =
  'text-body-base text-on-surface outline-none [&_a]:text-primary [&_a]:underline [&_blockquote]:border-s-4 [&_blockquote]:border-outline-variant [&_blockquote]:ps-4 [&_blockquote]:text-on-surface-variant [&_code]:rounded [&_code]:bg-surface-container-high [&_code]:px-1 [&_code]:font-mono [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:font-headline-md [&_h1]:text-headline-md [&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:font-headline-md-mobile [&_h2]:text-headline-md-mobile [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:font-label-sm [&_h3]:text-body-base [&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:font-label-sm [&_h4]:text-body-base [&_h5]:mt-3 [&_h5]:mb-1 [&_h5]:font-label-sm [&_h5]:text-body-base [&_h6]:mt-3 [&_h6]:mb-1 [&_h6]:font-label-sm [&_h6]:text-body-base [&_hr]:my-4 [&_hr]:border-outline-variant [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:ps-6 [&_p]:my-2 [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-outline-variant [&_td]:p-2 [&_th]:border [&_th]:border-outline-variant [&_th]:bg-surface-container [&_th]:p-2 [&_th]:text-start [&_ul]:list-disc [&_ul]:ps-6 [&>*:first-child]:mt-0'

/**
 * A parser of its own per view: the Markdown extension sets its options on the parser it is given
 * and adds its tokenizers to it on every mount, by default to the one `marked` shares with every
 * other editor. The extension types it as the `marked` module but only uses what an instance has
 * (`Lexer`, `lexer`, `use`, `defaults`).
 */
function ownParser(breaks: boolean): typeof marked {
  return new Marked({ gfm: true, breaks }) as unknown as typeof marked
}

/** Headings rendered `offset` levels lower, so a text's `#` fits under the heading above it. */
function headingWithOffset(offset: number): typeof Heading {
  return Heading.extend({
    renderHTML({ node, HTMLAttributes }) {
      const level = Math.min(Number(node.attrs.level) + offset, 6) as Level
      return [`h${level}`, HTMLAttributes, 0]
    }
  })
}

export interface MarkdownViewProps {
  markdown: string
  /** Names the region for screen readers. */
  label?: string
  /** Single line breaks stay line breaks, as in text written by people rather than a model. */
  breaks?: boolean
  /** How many levels the text's headings move down, e.g. 2 under an `<h2>`: `#` becomes `<h3>`. */
  headingOffset?: number
}

export default function MarkdownView({
  markdown,
  label,
  breaks = false,
  headingOffset = 0
}: MarkdownViewProps): React.JSX.Element {
  // Both are read when the editor is created; later changes do not rebuild it.
  const [extensions] = useState(() => [
    StarterKit.configure(headingOffset > 0 ? { heading: false } : {}),
    ...(headingOffset > 0 ? [headingWithOffset(headingOffset)] : []),
    TableKit.configure({ table: { resizable: false } }),
    Markdown.configure({ marked: ownParser(breaks) })
  ])
  const editor = useEditor({
    extensions,
    content: markdown,
    contentType: 'markdown',
    editable: false,
    immediatelyRender: true,
    editorProps: {
      // Tiptap marks its element as a textbox, which read-only text is not.
      attributes: {
        class: PROSE,
        ...(label ? { role: 'region', 'aria-label': label } : { role: 'none' })
      }
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
