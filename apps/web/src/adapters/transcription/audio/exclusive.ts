/** The element of the module that played last. */
let current: HTMLMediaElement | null = null

/**
 * One sound at a time across the module, as kiChat's players: call it when `element` starts
 * playing, and whatever else plays (a queue file, a sample, a take, the result) pauses.
 */
export function playExclusively(element: HTMLMediaElement): void {
  if (current && current !== element && !current.paused) current.pause()
  current = element
}
