import { describe, expect, it } from 'vitest'
import {
  addToGroup,
  fitIntoGroup,
  cleanupEmptyGroups,
  defaultGroupName,
  dropTargetIndex,
  duplicateKey,
  findFile,
  handoverGroupIndex,
  moveFile,
  newGroup,
  queueFileFrom,
  removeFile,
  removeGroup,
  renumberGroups,
  restoredGroupName,
  serverWaveform,
  totalBytes,
  type QueueFile,
  type QueueGroup
} from './queue'

function file(name: string, size = 10, lastModified = 1): File {
  return new File([new Uint8Array(size)], name, { type: 'audio/wav', lastModified })
}

function group(name: string, files: string[] = [], saved = false): QueueGroup {
  return {
    ...newGroup(0, name),
    files: files.map((entry) => ({ ...queueFileFrom(file(entry)), id: entry })),
    saved: saved ? { id: 'transcript', title: name, revision: 1 } : null
  }
}

const names = (groups: readonly QueueGroup[]): string[][] =>
  groups.map((entry) => entry.files.map((row) => row.name))

describe('groups (T-06)', () => {
  it('numbers default names by place and keeps names the user gave', () => {
    expect(defaultGroupName(0)).toBe('Transcript 1')
    const groups = renumberGroups([
      group('Transcript 3'),
      group('Interview'),
      group(''),
      group('Gruppe 9')
    ])
    expect(groups.map((entry) => entry.name)).toEqual([
      'Transcript 1',
      'Interview',
      'Transcript 3',
      'Transcript 4'
    ])
  })

  it('drops empty groups and renumbers', () => {
    const groups = cleanupEmptyGroups([
      group('Transcript 1'),
      group('Transcript 2', ['a.wav']),
      group('Meeting', ['b.wav'])
    ])
    expect(groups.map((entry) => entry.name)).toEqual(['Transcript 1', 'Meeting'])
  })

  it('removes a group and renumbers the rest', () => {
    const groups = [group('Transcript 1', ['a.wav']), group('Transcript 2', ['b.wav'])]
    expect(removeGroup(groups, groups[0]!.id).map((entry) => entry.name)).toEqual(['Transcript 1'])
  })

  it('names a restored job after its file (T-15)', () => {
    expect(restoredGroupName('campus-test.wav')).toBe('campus-test')
    expect(restoredGroupName('archive.2024.mp3')).toBe('archive.2024')
    expect(restoredGroupName('.wav')).toBe('.wav')
  })
})

describe('adding files (T-03, T-05)', () => {
  it('adds every new file as its own row and creates the group if needed', () => {
    const { groups, added } = addToGroup([], 1, [
      queueFileFrom(file('a.wav')),
      queueFileFrom(file('b.mp3'))
    ])
    expect(groups).toHaveLength(2)
    expect(groups[1]?.name).toBe('Transcript 2')
    expect(names(groups)).toEqual([[], ['a.wav', 'b.mp3']])
    expect(added).toHaveLength(2)
  })

  it('skips duplicates of the group by name, size and last change only', () => {
    const start = addToGroup([], 0, [queueFileFrom(file('a.wav'))]).groups
    const { groups, added } = addToGroup(start, 0, [
      queueFileFrom(file('a.wav')),
      queueFileFrom(file('a.wav', 11)),
      queueFileFrom(file('a.wav', 10, 2)),
      queueFileFrom(file('c.wav')),
      queueFileFrom(file('c.wav'))
    ])
    expect(names(groups)).toEqual([['a.wav', 'a.wav', 'a.wav', 'c.wav']])
    expect(added.map((row) => duplicateKey(row))).toEqual([
      'a.wav_11_1',
      'a.wav_10_2',
      'c.wav_10_1'
    ])
    // The same file in another group is no duplicate.
    expect(addToGroup(groups, 1, [queueFileFrom(file('a.wav'))]).added).toHaveLength(1)
  })

  it('leaves duplicates out before the limit counts, so distinct files still fit', () => {
    const start = addToGroup([], 0, [queueFileFrom(file('a.wav'))]).groups
    // One place left: the duplicate a.wav takes none, b.wav gets it.
    const { groups, added, overflow } = addToGroup(
      start,
      0,
      [queueFileFrom(file('a.wav')), queueFileFrom(file('b.wav'))],
      1
    )
    expect(names(groups)).toEqual([['a.wav', 'b.wav']])
    expect(added.map((row) => row.name)).toEqual(['b.wav'])
    expect(overflow).toBe(false)
    // Duplicates within one selection count once; a distinct file beyond the room overflows.
    const fit = fitIntoGroup([], [file('c.wav'), file('c.wav'), file('d.wav'), file('e.wav')], 2)
    expect(fit.fitting.map((entry) => entry.name)).toEqual(['c.wav', 'd.wav'])
    expect(fit.overflow).toBe(true)
    // Only duplicates: nothing added, and no alert, even in a full group.
    expect(fitIntoGroup([file('c.wav')], [file('c.wav')], 0)).toEqual({
      fitting: [],
      overflow: false
    })
  })

  it('sends dropped files to the first empty, else the first unsaved group', () => {
    expect(dropTargetIndex([])).toBe(0)
    expect(dropTargetIndex([group('A', ['a']), group('B')])).toBe(1)
    expect(dropTargetIndex([group('A', ['a'], true), group('B', ['b'])])).toBe(1)
    expect(dropTargetIndex([group('A', ['a'], true)])).toBe(1)
  })

  it('puts recorded takes into the first group unless it is saved (T-58)', () => {
    expect(handoverGroupIndex([group('A', ['a']), group('B')], 'first')).toBe(0)
    expect(handoverGroupIndex([group('A')], 'first')).toBe(0)
    expect(handoverGroupIndex([group('A', ['a'], true), group('B')], 'first')).toBeNull()
    expect(handoverGroupIndex([], 'first')).toBeNull()
    expect(handoverGroupIndex([group('A', ['a'])], 'own')).toBeNull()
  })

  it('sums the sizes', () => {
    expect(totalBytes([group('A', ['a', 'b']), group('B', ['c'])])).toBe(30)
  })
})

describe('moving and removing (T-07, T-08)', () => {
  const queue = (): QueueGroup[] => [group('A', ['a', 'b', 'c']), group('B', ['d'])]

  it('reorders within a group and moves between groups', () => {
    expect(names(moveFile(queue(), { groupIndex: 0, fileIndex: 0 }, 0, 2))).toEqual([
      ['b', 'c', 'a'],
      ['d']
    ])
    expect(names(moveFile(queue(), { groupIndex: 0, fileIndex: 1 }, 1, 0))).toEqual([
      ['a', 'c'],
      ['b', 'd']
    ])
    expect(names(moveFile(queue(), { groupIndex: 1, fileIndex: 0 }, 0, null))).toEqual([
      ['a', 'b', 'c', 'd'],
      []
    ])
  })

  it('moves nothing into or out of a saved group', () => {
    const groups = [group('A', ['a']), group('B', ['b'], true)]
    expect(names(moveFile(groups, { groupIndex: 0, fileIndex: 0 }, 1))).toEqual([['a'], ['b']])
    expect(names(moveFile(groups, { groupIndex: 1, fileIndex: 0 }, 0))).toEqual([['a'], ['b']])
  })

  it('removes a file and the group it leaves empty', () => {
    const groups = removeFile(queue(), 'd')
    expect(names(groups)).toEqual([['a', 'b', 'c']])
    expect(findFile(groups, 'b')).toMatchObject({ groupIndex: 0, fileIndex: 1 })
    expect(findFile(groups, 'd')).toBeNull()
  })
})

describe('the server waveform of a file (T-12)', () => {
  const uploaded = (change: Partial<QueueFile>): QueueFile => ({
    ...queueFileFrom(file('large.wav')),
    jobId: 'job',
    uploaded: true,
    ...change
  })

  it('is asked for once the analysis ended, with or without voices', () => {
    expect(serverWaveform(uploaded({ phase: 'analysisFailed', voices: null }))).toEqual({
      jobId: 'job',
      revision: 'analysisFailed'
    })
    expect(serverWaveform(uploaded({ phase: 'ready', voices: [] }))?.jobId).toBe('job')
    expect(serverWaveform(uploaded({ phase: 'failed' }))?.jobId).toBe('job')
    expect(serverWaveform(uploaded({ phase: 'completed' }))?.jobId).toBe('job')
  })

  it('is not asked for before the analysis could store it', () => {
    expect(serverWaveform(uploaded({ phase: 'uploading' }))).toBeNull()
    expect(serverWaveform(uploaded({ phase: 'analyzing' }))).toBeNull()
    expect(serverWaveform(uploaded({ phase: 'analysisFailed', uploaded: false }))).toBeNull()
    expect(serverWaveform(uploaded({ phase: 'ready', jobId: null }))).toBeNull()
  })

  it('changes its revision with the phase, so a missing waveform is asked for again', () => {
    const failed = serverWaveform(uploaded({ phase: 'analysisFailed' }))
    const ready = serverWaveform(uploaded({ phase: 'ready' }))
    expect(failed?.revision).not.toBe(ready?.revision)
  })
})
