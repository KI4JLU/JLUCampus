/**
 * Recorded takes as real WAV files, after kiChat's `LiveTranscriptionManager`: MediaRecorder never
 * records WAV (Chrome records WebM/Opus, Safari MP4), so the recording is decoded with Web Audio
 * and encoded anew as PCM16 with the decoded sample rate and channel count. WebM bytes are never
 * labelled WAV (T-57).
 */

/** What the encoder reads of a decoded `AudioBuffer`. */
export interface PcmSource {
  numberOfChannels: number
  sampleRate: number
  /** Frames per channel. */
  length: number
  getChannelData: (channel: number) => Float32Array
}

const HEADER_BYTES = 44

/** A PCM16 RIFF/WAVE file of the decoded audio, channels interleaved. */
export function encodeWav(source: PcmSource): ArrayBuffer {
  const channels = source.numberOfChannels
  const blockAlign = channels * 2
  const dataSize = source.length * blockAlign
  const buffer = new ArrayBuffer(HEADER_BYTES + dataSize)
  const view = new DataView(buffer)
  const writeText = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index))
  }

  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, source.sampleRate, true)
  view.setUint32(28, source.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, dataSize, true)

  const data = Array.from({ length: channels }, (_, channel) => source.getChannelData(channel))
  let offset = HEADER_BYTES
  for (let frame = 0; frame < source.length; frame++) {
    for (const samples of data) {
      const sample = Math.max(-1, Math.min(1, samples[frame] ?? 0))
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      offset += 2
    }
  }
  return buffer
}

/**
 * The name kiChat gives a take, `<username>-YYYYMMDD-HHMMSS.wav`, in local time of the moment the
 * recording started. Meeting takes stay WebM and carry `.webm` instead.
 */
export function recordingFilename(
  username: string,
  startedAt: Date,
  extension: 'wav' | 'webm' = 'wav'
): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}`
  const time = `${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`
  return `${username}-${date}-${time}.${extension}`
}

/**
 * The user name in a take's filename. Campus knows no account name, so the local part of the
 * e-mail address stands in for kiChat's username, else the display name; characters a filename
 * should not carry become `-`. `user` when nothing is left, as in kiChat.
 */
export function recordingUsername(
  user: { email?: string | null; name?: string | null } | null
): string {
  const candidates = [user?.email?.split('@')[0], user?.name]
  for (const candidate of candidates) {
    const cleaned = (candidate ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
    if (cleaned) return cleaned.slice(0, 64)
  }
  return 'user'
}

/** A take's size as kiChat writes it in the status: `1.2 MB`, below a megabyte `340 KB`. */
export function formatFileSize(bytes: number): string {
  if (!bytes) return '0 KB'
  const megabytes = bytes / (1024 * 1024)
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`
  return `${Math.ceil(bytes / 1024)} KB`
}

type AudioContextConstructor = new () => AudioContext

/** Decodes the browser's recording and returns it as a WAV file named `filename`. */
export async function recordingToWav(recording: Blob, filename: string): Promise<File> {
  const Context: AudioContextConstructor | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext
  if (!Context) throw new Error('Web Audio is not supported')
  const context = new Context()
  try {
    const decoded = await context.decodeAudioData(await recording.arrayBuffer())
    return new File([encodeWav(decoded)], filename, { type: 'audio/wav' })
  } finally {
    void context.close()
  }
}
