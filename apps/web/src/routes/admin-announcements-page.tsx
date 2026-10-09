import { useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  Container,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@ki4jlu/design-system'
import { AdminAnnouncementRow } from '@/components/admin-announcement-row'
import { AdminGuard } from '@/components/admin-guard'
import {
  DeleteAnnouncementDialog,
  ResetAnnouncementDialog,
  type AnnouncementTarget
} from '@/components/announcement-dialogs'
import { PageHeader } from '@/components/page-header'
import { PageLoading } from '@/components/page-message'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { currentLanguage } from '@/i18n'
import { textIn } from '@/lib/announcements'
import { adminAnnouncementsQuery } from '@/lib/queries'

export function AdminAnnouncementsPage(): React.JSX.Element {
  return (
    <AdminGuard>
      <Announcements />
    </AdminGuard>
  )
}

/**
 * News and element hints for users, newest first. The menu at the end of a row edits, shows the
 * announcement to everyone again or deletes it, the last two after a confirmation.
 */
function Announcements(): React.JSX.Element {
  const { t } = useTranslation()
  const language = currentLanguage()
  const { data: announcements, isPending, isError } = useQuery(adminAnnouncementsQuery)
  const [resetting, setResetting] = useState<AnnouncementTarget | null>(null)
  const [deleting, setDeleting] = useState<AnnouncementTarget | null>(null)
  // The menu button that opened a dialog, which gets the focus back as it closes.
  const opener = useRef<HTMLElement | null>(null)

  const focusBack = (event: Event): void => {
    if (!opener.current?.isConnected) return
    event.preventDefault()
    opener.current.focus()
  }

  return (
    <Container className="flex flex-col gap-gutter py-gutter md:py-margin-page">
      <PageHeader
        title={t('admin.announcements.title')}
        description={t('admin.announcements.description')}
        actions={
          <Button asChild>
            <Link to="/admin/announcements/new">
              <PlusIcon aria-hidden="true" width="1em" height="1em" />
              {t('admin.announcements.newAnnouncement')}
            </Link>
          </Button>
        }
      />
      <Card>
        <div className="overflow-x-auto">
          {isPending ? (
            <PageLoading label={t('common.loading')} />
          ) : isError ? (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertDescription>{t('admin.announcements.loadFailed')}</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableCaption className="sr-only">
                {t('admin.announcements.table.caption')}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.announcements.table.title')}</TableHead>
                  <TableHead>{t('admin.announcements.table.kind')}</TableHead>
                  <TableHead>{t('admin.announcements.table.status')}</TableHead>
                  <TableHead>{t('admin.announcements.table.seen')}</TableHead>
                  <TableHead className="text-right">{t('admin.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {announcements.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-on-surface-variant">
                      {t('admin.announcements.table.empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  announcements.map((announcement) => {
                    const target = {
                      id: announcement.id,
                      title: textIn(announcement.texts, language).title
                    }
                    return (
                      <AdminAnnouncementRow
                        key={announcement.id}
                        announcement={announcement}
                        title={target.title}
                        onReset={(button) => {
                          opener.current = button
                          setResetting(target)
                        }}
                        onDelete={(button) => {
                          opener.current = button
                          setDeleting(target)
                        }}
                      />
                    )
                  })
                )}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
      <ResetAnnouncementDialog
        target={resetting}
        onClose={() => setResetting(null)}
        onCloseAutoFocus={focusBack}
      />
      <DeleteAnnouncementDialog
        target={deleting}
        onClose={() => setDeleting(null)}
        onCloseAutoFocus={focusBack}
      />
    </Container>
  )
}
