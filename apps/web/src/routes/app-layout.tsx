import { useMemo } from 'react'
import { Outlet } from '@tanstack/react-router'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import type { Component } from '@justcampus/shared'
import { isAvailableHere } from '@/adapters/registry'
import { AnnouncementHost } from '@/components/announcement-host'
import { AppFrame } from '@/components/app-frame'
import { DesktopServices } from '@/desktop/desktop-services'
import { componentsQuery, meQuery, sidebarQuery } from '@/lib/queries'

/** Every signed-in route: the session is loaded by the route's `beforeLoad`. */
export function AppLayout(): React.JSX.Element {
  const { data: me } = useSuspenseQuery(meQuery)
  const { data: components } = useQuery(componentsQuery)
  const { data: sidebarIds } = useQuery(sidebarQuery)

  const sidebarComponents = useMemo(() => {
    if (!components || !sidebarIds) return []
    const byId = new Map(components.map((component) => [component.id, component]))
    return sidebarIds.flatMap((id): Component[] => {
      const component = byId.get(id)
      // Desktop components stay in the saved sidebar but show only in the desktop app.
      return component && isAvailableHere(component) ? [component] : []
    })
  }, [components, sidebarIds])

  return (
    <>
      <AnnouncementHost>
        <AppFrame me={me} sidebarComponents={sidebarComponents}>
          <Outlet />
        </AppFrame>
      </AnnouncementHost>
      <DesktopServices sidebarComponents={sidebarComponents} />
    </>
  )
}
