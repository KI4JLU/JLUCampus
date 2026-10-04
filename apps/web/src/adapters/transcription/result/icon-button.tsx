import { forwardRef, type ComponentProps } from 'react'
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@ki4jlu/design-system'

interface IconButtonProps extends Omit<ComponentProps<typeof Button>, 'size' | 'aria-label'> {
  /** Accessible name and tooltip. */
  label: string
}

/** A ghost icon button with its name as a tooltip; forwards its ref, so it can be a trigger. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', children, ...props },
  ref
) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button ref={ref} type="button" variant={variant} size="icon" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
})
