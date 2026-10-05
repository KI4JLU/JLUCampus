/**
 * Recording (stream "recording"): microphone permission and devices, regular recording with WAV
 * conversion, the recorded takes and their upload into one queue group (T-55 to T-58).
 * `RecordingProvider` also runs the live session of `../live`, since both share the microphone,
 * the lifecycle and the takes.
 */
export { RecordingProvider } from './provider'
export { RecordingSettings, RecordView } from './views'
