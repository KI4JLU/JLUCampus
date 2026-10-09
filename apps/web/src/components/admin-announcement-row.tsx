import { useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { EllipsisIcon, PencilIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  TableCell,
  TableRow
} from '@ki4jlu/design-system'
import type { AdminAnnouncement } from '@justcampus/shared'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

interface AdminAnnouncementRowProps {
  announcement: AdminAnnouncement
  /** The title in the admin's UI language. */
  title: string
  /** Both get the menu's button, which takes the focus back from the dialog they open. */
  onReset: (opener: HTMLElement | null) => void
  onDelete: (opener: HTMLElement | null) => void
}

/** One announcement in the admin list, with its actions in a menu at the end of the row. */
export function AdminAnnouncementRow({
  announcement,
  title,
  onReset,
  onDelete
}: AdminAnnouncementRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const trigger = useRef<HTMLButtonElement>(null)
  return (
    <TableRow>
      <TableCell className="font-medium">{title}</TableCell>
      <TableCell className="whitespace-nowrap">
        {t(`admin.announcements.kinds.${announcement.kind}`)}
      </TableCell>
      <TableCell>
        {announcement.enabled ? (
          <Badge tone="success" appearance="filled">
            {t('admin.announcements.status.active')}
          </Badge>
        ) : (
          <Badge tone="neutral" appearance="filled">
            {t('admin.announcements.status.draft')}
          </Badge>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap tabular-nums">
        {t('admin.announcements.table.seenCount', { count: announcement.seenCount })}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                ref={trigger}
                variant="ghost"
                size="icon"
                aria-label={t('admin.announcements.actions.menu', { title })}
              >
                <EllipsisIcon {...ICON} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link
                  to="/admin/announcements/$announcementId"
                  params={{ announcementId: announcement.id }}
                >
                  <PencilIcon {...ICON} />
                  {t('admin.announcements.actions.edit')}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onReset(trigger.current)}>
                <RotateCcwIcon {...ICON} />
                {t('admin.announcements.actions.reset')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete(trigger.current)}>
                <Trash2Icon {...ICON} />
                {t('common.delete')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  )
}
