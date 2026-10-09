/**
 * Elements of the app shell a hint can point at. Each carries a `data-tour` attribute that stays
 * put when classes, texts or the layout change, so hints keep finding them. The announcement
 * editor offers them as selector suggestions.
 */
export const TOUR = {
  dashboardLink: 'nav-dashboard',
  moreApps: 'more-apps',
  accountMenu: 'account-menu',
  dashboardEdit: 'dashboard-edit',
  dashboardAddWidget: 'dashboard-add-widget'
} as const

export type TourId = (typeof TOUR)[keyof typeof TOUR]

/** The `data-tour` value of a component's row in the sidebar. */
export function componentTourId(componentId: string): string {
  return `sidebar-component-${componentId}`
}

export function tourSelector(id: string): string {
  return `[data-tour="${id}"]`
}

export interface TourTarget {
  selector: string
  /** Under `announcements.tourTargets`. */
  label: keyof typeof TOUR
  /** The page the element is on, when only one has it. */
  path?: string
}

/**
 * The shell's targets. The account menu's attribute sits on a wrapper without a box of its own,
 * so its selector reaches into it for the menu's button.
 */
export const TOUR_TARGETS: readonly TourTarget[] = [
  { selector: tourSelector(TOUR.dashboardLink), label: 'dashboardLink' },
  { selector: tourSelector(TOUR.moreApps), label: 'moreApps' },
  { selector: `${tourSelector(TOUR.accountMenu)} > button`, label: 'accountMenu' },
  { selector: tourSelector(TOUR.dashboardEdit), label: 'dashboardEdit', path: '/' },
  { selector: tourSelector(TOUR.dashboardAddWidget), label: 'dashboardAddWidget', path: '/' }
]
