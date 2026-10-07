/**
 * Recording (stream "recording"): microphone permission and devices, regular recording with WAV
 * conversion, meetings (microphone and another tab's audio, kept as WebM with a backup in the
 * browser), the recorded takes and their upload into one queue group (T-55 to T-58).
 * `RecordingProvider` also runs the live session of `../live`, since both share the microphone,
 * the lifecycle and the takes.
 */
export { RecordingProvider } from './provider'
export { MeetingSettings, MeetingView } from './meeting-views'
export { RecordingSettings, RecordView } from './views'
