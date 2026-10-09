import { getRouteApi, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CloudOffIcon, SearchXIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@ki4jlu/design-system'
import { AdminGuard } from '@/components/admin-guard'
import { AnnouncementEditor } from '@/components/announcement-editor'
import { PageLoading, PageMessage } from '@/components/page-message'
import { ApiRequestError } from '@/lib/api'
import { adminAnnouncementQuery } from '@/lib/queries'

const route = getRouteApi('/app/admin/announcements/$announcementId')

export function AdminNewAnnouncementPage(): React.JSX.Element {
  return (
    <AdminGuard>
      <AnnouncementEditor announcement={null} />
    </AdminGuard>
  )
}

export function AdminAnnouncementEditorPage(): React.JSX.Element {
  const { announcementId } = route.useParams()
  // Another announcement starts over: no draft or pending save carries across.
  return (
    <AdminGuard>
      <EditAnnouncement key={announcementId} announcementId={announcementId} />
    </AdminGuard>
  )
}

function EditAnnouncement({ announcementId }: { announcementId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const announcement = useQuery(adminAnnouncementQuery(announcementId))

  if (announcement.isError) {
    // A malformed id in the address (`validation`) finds nothing either.
    const missing =
      announcement.error instanceof ApiRequestError &&
      (announcement.error.status === 404 || announcement.error.code === 'validation')
    return (
      <PageMessage
        icon={missing ? <SearchXIcon /> : <CloudOffIcon />}
        title={
          missing
            ? t('admin.announcements.form.notFoundTitle')
            : t('admin.announcements.form.loadFailedTitle')
        }
        description={
          missing
            ? t('admin.announcements.form.notFoundDescription')
            : t('admin.form.loadFailedDescription')
        }
        actions={
          <Button asChild>
            <Link to="/admin/announcements">{t('admin.announcements.form.back')}</Link>
          </Button>
        }
      />
    )
  }
  if (!announcement.data) return <PageLoading label={t('common.loading')} />
  return <AnnouncementEditor announcement={announcement.data} />
}
