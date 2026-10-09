import type { Me } from '@justcampus/shared'

type Access = Pick<Me, 'componentIds' | 'features'>

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a)
  return set.size === new Set(b).size && b.every((item) => set.has(item))
}

/**
 * Whether the user's roles now allow other components or functions than at the previous `/me`
 * answer; the order of the lists does not count.
 */
export function accessChanged(previous: Access, next: Access): boolean {
  return (
    !sameSet(previous.componentIds, next.componentIds) || !sameSet(previous.features, next.features)
  )
}
