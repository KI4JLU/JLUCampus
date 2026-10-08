export {
  WaveformPlayer,
  type WaveformPlayerHandle,
  type WaveformPlayerProps,
  type WaveformRegion,
  type WaveformSegment,
  type WaveformTimeline
} from './waveform-player'
export { segmentTitle } from './draw'
export {
  blobWaveform,
  computePeaks,
  decodesLocally,
  decodeWaveform,
  formatMegabytes,
  formatTime,
  GLOBAL_PEAK_RESOLUTION,
  globalPeaks,
  jobTimePeaks,
  jobWaveform,
  overviewPeaks,
  PEAK_RESOLUTION,
  placeholderPeaks,
  serverTimePeaks,
  sourceWaveform,
  urlWaveform,
  type DecodedWaveform,
  type JobTimePeaks,
  type TimelineRange
} from './peaks'
export { playExclusively } from './exclusive'
