import { Link } from '@tanstack/react-router'
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Switch, TableCell, TableRow } from '@ki4jlu/design-system'
import { isBuiltInType, isDesktopComponentType, type AdminComponent } from '@justcampus/shared'
import { externalUrlOf, sourceUrlOf } from '@/adapters/registry'
import { useComponentName } from '@/lib/component-name'
import { ComponentIcon } from './component-icon'

interface AdminComponentRowProps {
  component: AdminComponent
  isFirst: boolean
  isLast: boolean
  onToggle: (enabled: boolean) => void
  onMove: (offset: -1 | 1) => void
  onDelete: () => void
}

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

export function AdminComponentRow({
  component,
  isFirst,
  isLast,
  onToggle,
  onMove,
  onDelete
}: AdminComponentRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const name = useComponentName()(component)
  // Built in (modules, desktop components): created by the server, so they cannot be deleted.
  const isBuiltIn = isBuiltInType(component.type)
  const isDesktop = isDesktopComponentType(component.type)
  const url = sourceUrlOf(component)
  return (
    <TableRow>
      <TableCell className="w-10">
        <span className="flex text-lg text-on-surface-variant">
          <ComponentIcon
            icon={component.icon}
            iconUrl={component.iconUrl}
            siteUrl={externalUrlOf(component)}
          />
        </span>
      </TableCell>
      <TableCell className="font-medium">{name}</TableCell>
      <TableCell className="whitespace-nowrap">
        <span className="flex items-center gap-2">
          {t(`componentTypes.${component.type}`)}
          {isBuiltIn ? (
            <Badge tone="secondary" appearance="filled">
              {t(isDesktop ? 'admin.table.desktop' : 'admin.table.module')}
            </Badge>
          ) : null}
        </span>
      </TableCell>
      <TableCell>
        {url ? (
          <span className="block max-w-72 truncate text-on-surface-variant">{url}</span>
        ) : (
          <span className="text-on-surface-variant">
            <span aria-hidden="true">—</span>
            <span className="sr-only">{t('admin.table.noUrl')}</span>
          </span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={component.enabled}
          onCheckedChange={onToggle}
          aria-label={t('admin.table.enabledFor', { name })}
        />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            disabled={isFirst}
            aria-label={t('admin.table.moveUp', { name })}
            onClick={() => onMove(-1)}
          >
            <ArrowUpIcon {...ICON} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            disabled={isLast}
            aria-label={t('admin.table.moveDown', { name })}
            onClick={() => onMove(1)}
          >
            <ArrowDownIcon {...ICON} />
          </Button>
          <Button variant="ghost" size="icon" asChild>
            <Link
              to="/admin/components/$componentId"
              params={{ componentId: component.id }}
              aria-label={t('admin.table.edit', { name })}
            >
              <PencilIcon {...ICON} />
            </Link>
          </Button>
          {/*
           * Built-in components cannot be deleted. Their button stays as an invisible placeholder (hidden from
           * pointer, keyboard and screenreaders alike), so every row's buttons line up.
           */}
          <Button
            variant="ghost-destructive"
            size="icon"
            aria-label={t('admin.table.delete', { name })}
            disabled={isBuiltIn}
            onClick={isBuiltIn ? undefined : onDelete}
            className={isBuiltIn ? 'invisible' : undefined}
          >
            <Trash2Icon {...ICON} />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  )
}
