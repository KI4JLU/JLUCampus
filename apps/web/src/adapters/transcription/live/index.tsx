/**
 * Live transcription (stream "recording"): on-prem and OpenAI Realtime over WebRTC, the running
 * text and its appearance controls (T-59 to T-61). The session itself is `session.ts`; it runs in
 * `RecordingProvider`, which shares the microphone, the lifecycle and the takes with recording.
 */
export { LiveSettings, LiveView } from './views'
