import { useQuery } from '@tanstack/react-query'
import type { FeatureKey } from '@justcampus/shared'
import { meQuery } from './queries'

/**
 * Whether the signed-in user may use a module function (`Me.features`; admins may use all). The
 * server refuses a function's requests without it, so the page leaves the function out. While the
 * user is not known yet, nothing is allowed.
 */
export function useFeature(feature: FeatureKey): boolean {
  const { data } = useQuery({ ...meQuery, select: (me) => me.features.includes(feature) })
  return data ?? false
}
