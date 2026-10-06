import { useId, type ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ki4jlu/design-system'

interface FormSectionProps {
  title: string
  /** Muted line under the title; says what the section is for, not how to fill it in. */
  description?: ReactNode
  /** The section's fields; a section with nothing to fill in has only its description. */
  children?: ReactNode
}

/**
 * One titled card of a form page, such as the admin's component editor. Its title is an `<h2>`
 * under the page's `<h1>`, and the section is named by it.
 */
export function FormSection({ title, description, children }: FormSectionProps): React.JSX.Element {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId}>
      <Card>
        <CardHeader>
          <CardTitle asChild>
            <h2 id={titleId}>{title}</h2>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        {children ? (
          <CardContent className="flex flex-col gap-stack-md">{children}</CardContent>
        ) : null}
      </Card>
    </section>
  )
}
