/**
 * Recording (stream "recording"): microphone permission and devices, regular recording of the
 * microphone mixed with added sources (more microphones, tabs, windows, screens), the takes in the
 * recorder's own format with a backup in the browser, and their upload into one queue group (T-55
 * to T-58). `RecordingProvider` also runs the live session of `../live`, since both share the
 * microphone, the lifecycle and the takes.
 */
export { RecordingProvider } from './provider'
export { RecordView } from './views'
