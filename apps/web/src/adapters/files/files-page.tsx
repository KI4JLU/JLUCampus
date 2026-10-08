import { useEffect, useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  FolderIcon,
  FolderPlusIcon,
  MonitorIcon,
  MonitorOffIcon,
  ServerIcon,
  Trash2Icon,
  type LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Container,
  FileDropzone,
  Spinner,
  useWindowFileDrag
} from '@ki4jlu/design-system'
import type { DesktopFilesBridge, DesktopPlace, DesktopRecentFile } from '@justcampus/shared'
import { ComponentIcon } from '@/components/component-icon'
import { PageHeader } from '@/components/page-header'
import { PageMessage } from '@/components/page-message'
import { desktopBridge, desktopModule } from '@/desktop/bridge'
import { useComponentName } from '@/lib/component-name'
import { formatFeedDate } from '@/lib/feed'
import { toast } from '@/lib/toast'
import type { ComponentViewProps } from '../types'
import { formatFileSize, isUserPlace, placeName, showInFolderKey } from './format'
import { NetworkDriveDialog } from './network-drive-dialog'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

const PLACES_KEY = ['desktop', 'files', 'places'] as const
const RECENT_KEY = ['desktop', 'files', 'recent'] as const

const PLACE_ICONS: Record<DesktopPlace['kind'], LucideIcon> = {
  downloads: DownloadIcon,
  documents: FileTextIcon,
  desktop: MonitorIcon,
  folder: FolderIcon,
  network: ServerIcon
}

/**
 * The desktop app's files module as a component page. The browser never lists the component (see
 * `isAvailableHere`); should it get here anyway, it says where the page works.
 */
export function FilesPage({ component }: ComponentViewProps<'files'>): React.JSX.Element {
  const { t } = useTranslation()
  const bridge = desktopModule('files')
  if (!bridge) {
    return (
      <PageMessage
        icon={<MonitorOffIcon />}
        title={t('component.files.desktopOnlyTitle')}
        description={t('component.files.desktopOnlyDescription')}
        actions={
          <Button asChild>
            <Link to="/">{t('errors.toDashboard')}</Link>
          </Button>
        }
      />
    )
  }
  return <FilesView bridge={bridge} component={component} />
}

interface FilesViewProps extends ComponentViewProps<'files'> {
  bridge: DesktopFilesBridge
}

/**
 * The computer's standard folders, the folders and network shares the user added, and the newest
 * downloads, each opening in the system's file manager or default app. Folders dragged onto the
 * page are added.
 */
function FilesView({ bridge, component }: FilesViewProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const client = useQueryClient()
  const os = desktopBridge()?.os
  const [networkOpen, setNetworkOpen] = useState(false)
  const dragging = useWindowFileDrag()
  // The desktop app answers locally; a second try would not answer differently.
  const places = useQuery({ queryKey: PLACES_KEY, queryFn: () => bridge.places(), retry: false })
  const recent = useQuery({
    queryKey: RECENT_KEY,
    queryFn: () => bridge.recentDownloads(),
    retry: false
  })
  const refetchRecent = recent.refetch

  // New downloads arrive while the user is in another app. TanStack's focus refetch follows
  // `visibilitychange`, which a desktop window that only loses focus never fires.
  useEffect(() => {
    const onFocus = (): void => void refetchRecent()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refetchRecent])

  const refreshPlaces = (): Promise<void> => client.invalidateQueries({ queryKey: PLACES_KEY })

  const { mutate: pickFolder, isPending: picking } = useMutation({
    mutationFn: () => bridge.pickFolder(),
    onSuccess: (place) => {
      if (place) void refreshPlaces()
    },
    onError: () => toast({ variant: 'error', title: t('desktop.files.addFailed') })
  })

  const { mutate: removePlace } = useMutation({
    mutationFn: (id: string) => bridge.remove(id),
    onSettled: refreshPlaces,
    onError: () => toast({ variant: 'error', title: t('desktop.files.removeFailed') })
  })

  const addDropped = async (files: File[]): Promise<void> => {
    const added = await Promise.all(
      files.map(async (file) => {
        try {
          await bridge.addDropped(file)
          return true
        } catch {
          toast({ variant: 'error', title: t('desktop.files.dropNotFolder', { name: file.name }) })
          return false
        }
      })
    )
    if (added.some(Boolean)) await refreshPlaces()
  }

  const connect = async (address: string, name: string): Promise<void> => {
    await bridge.addNetwork(address, name)
    await refreshPlaces()
  }

  /** Opening happens outside the app; only its failure has anything to show here. */
  const run = (action: () => Promise<void>): void => {
    action().catch(() => toast({ variant: 'error', title: t('desktop.files.openFailed') }))
  }

  return (
    <div className="relative flex flex-1 flex-col">
      <Container size="reading" className="flex flex-col gap-stack-lg py-gutter md:py-margin-page">
        <PageHeader
          title={
            <>
              <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} />
              <span className="truncate">{componentName(component)}</span>
            </>
          }
          description={t('desktop.files.description')}
          actions={
            <>
              <Button variant="outline" size="sm" disabled={picking} onClick={() => pickFolder()}>
                <FolderPlusIcon {...ICON} />
                {t('desktop.files.addFolder')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setNetworkOpen(true)}>
                <ServerIcon {...ICON} />
                {t('desktop.files.connectNetwork')}
              </Button>
            </>
          }
        />
        <Card>
          <CardHeader>
            <CardTitle asChild>
              <h2>{t('desktop.files.places')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <QueryState
              pending={places.isPending}
              failed={places.isError}
              failedText={t('desktop.files.placesFailed')}
              onRetry={() => void places.refetch()}
            >
              <ul className="m-0 flex list-none flex-col p-0">
                {places.data?.map((place) => (
                  <PlaceRow
                    key={place.id}
                    place={place}
                    onOpen={() => run(() => bridge.open(place.id))}
                    onRemove={() => removePlace(place.id)}
                  />
                ))}
              </ul>
            </QueryState>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle asChild>
              <h2>{t('desktop.files.recent')}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <QueryState
              pending={recent.isPending}
              failed={recent.isError}
              failedText={t('desktop.files.recentFailed')}
              onRetry={() => void recent.refetch()}
            >
              {recent.data?.length === 0 ? (
                <p className="m-0 text-sm text-on-surface-variant">
                  {t('desktop.files.recentEmpty')}
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {recent.data?.map((file) => (
                    <RecentFileRow
                      key={file.id}
                      file={file}
                      showLabel={t(showInFolderKey(os))}
                      onOpen={() => run(() => bridge.openFile(file.id))}
                      onShow={() => run(() => bridge.showFile(file.id))}
                    />
                  ))}
                </ul>
              )}
            </QueryState>
          </CardContent>
        </Card>
      </Container>
      {dragging ? (
        // Shown only while files are dragged over the window; it holds nothing to focus.
        <div className="absolute inset-0 z-10 flex p-gutter">
          <FileDropzone
            className="flex-1"
            icon={<FolderPlusIcon />}
            title={t('desktop.files.dropTitle')}
            hint={t('desktop.files.dropHint')}
            onFiles={(files) => void addDropped(files)}
          />
        </div>
      ) : null}
      {networkOpen ? (
        <NetworkDriveDialog
          open={networkOpen}
          onOpenChange={setNetworkOpen}
          os={os}
          onConnect={connect}
        />
      ) : null}
    </div>
  )
}

interface QueryStateProps {
  pending: boolean
  failed: boolean
  failedText: string
  onRetry: () => void
  children: React.ReactNode
}

/** A card's content once loaded; a spinner before, a retry after a failure. */
function QueryState({
  pending,
  failed,
  failedText,
  onRetry,
  children
}: QueryStateProps): React.JSX.Element {
  const { t } = useTranslation()
  if (pending) {
    return (
      <div className="flex justify-center py-4">
        <Spinner label={t('common.loading')} />
      </div>
    )
  }
  if (failed) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-stack-sm">
        <p className="m-0 text-sm text-error">{failedText}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </div>
    )
  }
  return <>{children}</>
}

const ROW =
  'flex items-center gap-stack-md border-b border-outline-variant py-3 first:pt-0 last:border-b-0 last:pb-0'

interface PlaceRowProps {
  place: DesktopPlace
  onOpen: () => void
  onRemove: () => void
}

/** A place: icon by kind, name, where it points, and for network shares whether they answer. */
function PlaceRow({ place, onOpen, onRemove }: PlaceRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const hintId = useId()
  const Icon = PLACE_ICONS[place.kind]
  const name = placeName(place, t)
  const network = place.kind === 'network'
  const hint = network && !place.available ? t('desktop.files.vpnHint') : null

  return (
    <li className={ROW}>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-container text-lg text-on-primary-container">
        <Icon {...ICON} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate font-medium text-on-surface">{name}</span>
          {network ? (
            <Badge tone={place.available ? 'success' : 'warning'} appearance="filled" dot>
              {t(place.available ? 'desktop.files.reachable' : 'desktop.files.unreachable')}
            </Badge>
          ) : !place.available ? (
            <Badge tone="warning" appearance="filled">
              {t('desktop.files.missing')}
            </Badge>
          ) : null}
        </div>
        <p
          className="m-0 truncate font-mono text-sm text-on-surface-variant"
          title={place.location}
        >
          {place.location}
        </p>
        {hint ? (
          <p id={hintId} className="m-0 text-sm text-on-surface-variant">
            {hint}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          aria-label={t('desktop.files.openPlace', { name })}
          aria-describedby={hint ? hintId : undefined}
          onClick={onOpen}
        >
          {t('desktop.files.open')}
        </Button>
        {isUserPlace(place) ? (
          <Button
            variant="ghost-destructive"
            size="icon"
            aria-label={t('desktop.files.remove', { name })}
            title={t('desktop.files.remove', { name })}
            onClick={onRemove}
          >
            <Trash2Icon {...ICON} />
          </Button>
        ) : null}
      </div>
    </li>
  )
}

interface RecentFileRowProps {
  file: DesktopRecentFile
  /** "Show in Explorer" and its kin, by operating system. */
  showLabel: string
  onOpen: () => void
  onShow: () => void
}

/** A recent download: name, size and age, opened with its app or shown in its folder. */
function RecentFileRow({ file, showLabel, onOpen, onShow }: RecentFileRowProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const date = formatFeedDate(file.modifiedAt, language)

  return (
    <li className={`${ROW} flex-wrap`}>
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-container text-lg text-on-surface-variant">
        <FileIcon {...ICON} />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="m-0 truncate font-medium text-on-surface" title={file.name}>
          {file.name}
        </p>
        <p className="m-0 text-sm text-on-surface-variant">
          {formatFileSize(file.size, language)}
          {date ? (
            <>
              <span aria-hidden="true"> · </span>
              <time dateTime={file.modifiedAt} title={date.full}>
                {date.label}
              </time>
            </>
          ) : null}
          {file.openable ? null : (
            <>
              <span aria-hidden="true"> · </span>
              {t('desktop.files.notOpenable')}
            </>
          )}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1">
        {file.openable ? (
          <Button
            variant="outline"
            size="sm"
            aria-label={t('desktop.files.openFile', { name: file.name })}
            onClick={onOpen}
          >
            {t('desktop.files.open')}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${showLabel}: ${file.name}`}
          onClick={onShow}
        >
          {showLabel}
        </Button>
      </div>
    </li>
  )
}
