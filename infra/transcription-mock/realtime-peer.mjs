/**
 * A real WebRTC peer for the realtime mock, built on `werift` (a root devDependency), so live
 * transcription runs end to end in development: the browser's audio arrives over DTLS-SRTP and
 * the transcript goes back as OpenAI realtime events on the `oai-events` data channel.
 *
 * Nothing is recognised. While audio packets arrive, every `ITEM_SECONDS` one item is sent: the
 * on-prem bridge's `input_audio_buffer.committed`, the next sentence of a fixed German script word
 * by word as `conversation.item.input_audio_transcription.delta`, then `…completed` with the whole
 * sentence. The browser's `input_audio_buffer.commit` (on-prem stop) finishes at once with one last
 * item, empty if no audio came since the last one, so stopping does not wait; half a second later
 * the peer closes, as the bridge does after finalising.
 *
 * An offer werift cannot take (no ICE credentials or fingerprint, say) is refused as a real bridge
 * would refuse it: `answerWithPeer` throws `OfferRefused`. Only a missing `werift` makes it return
 * `null`; the caller then answers with the signaling-only stub. A peer that does not connect
 * within `CONNECT_MS` (the admin connection test's offer never does) is closed.
 */

/** Seconds of received audio per transcript item. */
export const ITEM_SECONDS = 3
/** Pause between two deltas of an item. */
const DELTA_MS = 80
/** A session without audio for this long is closed. */
const IDLE_MS = 120_000
/** A peer not connected after this long is closed. */
const CONNECT_MS = 30_000
/** After the final item the bridge gives the data channel this long before it closes. */
const FINALIZE_CLOSE_MS = 500

/** An offer the peer cannot negotiate; the bridge answers it with an error. */
export class OfferRefused extends Error {}

/** The script, one sentence per item, then from the start again. */
export const SCRIPT = [
  'Guten Morgen und willkommen zur Live-Transkription.',
  'Dies ist ein Test des lokalen Mocks.',
  'Jede dritte Sekunde Audio ergibt einen Satz.',
  'Die Wörter kommen einzeln an, der Satz zum Schluss vollständig.',
  'Beim Beenden wird der letzte Abschnitt abgeschlossen.'
]

/** The deltas of a sentence: its first word, then each further word with its leading space. */
export function sentenceDeltas(sentence) {
  return sentence.split(' ').map((word, index) => (index === 0 ? word : ` ${word}`))
}

let werift
/** `werift`, loaded on first use; `null` when it is not installed. */
async function loadWerift() {
  if (werift === undefined) {
    try {
      werift = await import('werift')
    } catch {
      werift = null
    }
  }
  return werift
}

/** Whether an offer carries what a DTLS peer needs. */
export function isNegotiable(offer) {
  return /^a=ice-ufrag:/m.test(offer) && /^a=fingerprint:/m.test(offer)
}

const peers = new Set()

/**
 * Answers `offer` with a werift peer that transcribes as described above, after gathering its
 * candidates (nobody trickles). `null` without werift; `OfferRefused` for an offer it cannot take.
 *
 * @param {string} offer
 * @returns {Promise<string | null>}
 */
export async function answerWithPeer(offer) {
  if (!isNegotiable(offer)) {
    throw new OfferRefused('The offer has no ICE credentials or DTLS fingerprint')
  }
  const lib = await loadWerift()
  if (!lib) return null
  const { RTCPeerConnection, RTCRtpCodecParameters } = lib
  const peer = new RTCPeerConnection({
    codecs: {
      audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48_000, channels: 2 })]
    }
  })
  try {
    const session = new MockSession(peer)
    peers.add(session)
    await peer.setRemoteDescription({ type: 'offer', sdp: offer })
    await peer.setLocalDescription(await peer.createAnswer())
    await gathered(peer)
    const answer = peer.localDescription?.sdp
    if (!answer) throw new Error('The peer made no answer')
    return answer
  } catch (error) {
    await Promise.resolve(peer.close()).catch(() => {})
    throw new OfferRefused(`The offer cannot be negotiated: ${error?.message ?? error}`)
  }
}

/** Closes every peer, e.g. when the mock stops. */
export async function closePeers() {
  await Promise.all([...peers].map((session) => session.close()))
}

function gathered(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000)
    peer.iceGatheringStateChange.subscribe((state) => {
      if (state !== 'complete') return
      clearTimeout(timer)
      resolve()
    })
  })
}

/** One browser's session: counts its audio and sends the script's items. */
class MockSession {
  constructor(peer) {
    this.peer = peer
    this.channel = null
    this.packets = 0
    this.item = 0
    this.sending = Promise.resolve()
    this.lastAudio = Date.now()
    this.closed = false

    peer.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe(() => {
        this.packets += 1
        this.lastAudio = Date.now()
      })
    })
    peer.onDataChannel.subscribe((channel) => {
      if (channel.label !== 'oai-events') return
      this.channel = channel
      channel.onMessage.subscribe((data) => this.receive(String(data)))
    })
    peer.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed' || state === 'disconnected') void this.close()
    })
    this.timer = setInterval(() => this.tick(), ITEM_SECONDS * 1000)
    this.connectTimer = setTimeout(() => {
      if (peer.connectionState !== 'connected') void this.close()
    }, CONNECT_MS)
    // A forgotten session must not keep the mock (or a test run) alive.
    this.timer.unref?.()
    this.connectTimer.unref?.()
  }

  tick() {
    if (Date.now() - this.lastAudio > IDLE_MS) {
      void this.close()
      return
    }
    if (this.packets === 0 || !this.channel) return
    this.packets = 0
    this.queueItem()
  }

  receive(text) {
    let event
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    // On-prem stop: finish with what came since the last item, then close as the bridge does
    // (its `keep_open` commit goes on with the next item instead).
    if (event?.type === 'input_audio_buffer.commit') {
      const withText = this.packets > 0
      this.packets = 0
      this.queueItem(withText)
      if (!event.keep_open) {
        this.sending = this.sending
          .then(() => new Promise((resolve) => setTimeout(resolve, FINALIZE_CLOSE_MS)))
          .then(() => this.close())
      }
    }
  }

  /** Sends the next item after those already on their way. */
  queueItem(withText = true) {
    const itemId = `item_mock_${++this.item}`
    const sentence = withText ? SCRIPT[(this.item - 1) % SCRIPT.length] : ''
    this.sending = this.sending.then(() => this.sendItem(itemId, sentence)).catch(() => {})
  }

  async sendItem(itemId, sentence) {
    this.send({ type: 'input_audio_buffer.committed', item_id: itemId })
    for (const delta of sentence ? sentenceDeltas(sentence) : []) {
      this.send({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: itemId,
        content_index: 0,
        delta
      })
      await new Promise((resolve) => setTimeout(resolve, DELTA_MS))
    }
    this.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      content_index: 0,
      transcript: sentence
    })
  }

  send(event) {
    if (this.closed || this.channel?.readyState !== 'open') return
    try {
      this.channel.send(JSON.stringify(event))
    } catch {
      // The channel closed meanwhile.
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    clearTimeout(this.connectTimer)
    peers.delete(this)
    await Promise.resolve(this.peer.close()).catch(() => {})
  }
}
