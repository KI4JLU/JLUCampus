/**
 * Segment logic of the result workspace: speaker blocks, renaming and colours, reassigning,
 * inserting and moving text between speakers, redaction ranges, the undo stack and the time line
 * of several source files (T-24 to T-34), as pure functions over `TranscriptionSegment[]` with
 * tests beside them.
 */
export * from './blocks'
export * from './edit'
export * from './labels'
export * from './payload'
export * from './redaction'
export * from './text'
export * from './timeline'
export * from './undo'
