import { randomBytes, randomInt, randomUUID } from 'node:crypto'

/**
 * SDP as the live paths need it (RFC 8866, RFC 8829): what makes a bridge's answer usable for a
 * WebRTC peer, and the offer the admin connection test sends, shaped like a browser's.
 */

interface MediaSection {
  /** The `m=` line. */
  media: string
  attributes: string[]
}

interface ParsedSdp {
  session: string[]
  sections: MediaSection[]
}

function parseSdp(sdp: string): ParsedSdp {
  const session: string[] = []
  const sections: MediaSection[] = []
  for (const line of sdp.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith('m=')) sections.push({ media: line, attributes: [] })
    else if (sections.length > 0) sections.at(-1)!.attributes.push(line)
    else session.push(line)
  }
  return { session, sections }
}

/** `m=<media> <port> <proto> <fmt> …` of WebRTC: DTLS-SRTP media or an SCTP data channel. */
const WEBRTC_MEDIA =
  /^m=(audio|video|application) (\d+) (UDP\/TLS\/RTP\/SAVPF|UDP\/DTLS\/SCTP|TCP\/DTLS\/SCTP|DTLS\/SCTP) \S/

/**
 * Why an SDP answer cannot complete a WebRTC connection, or `null` if it can as far as its text
 * shows: the session lines, one WebRTC media section per section of the offer (RFC 3264), and
 * for every accepted section ICE credentials and a DTLS fingerprint, there or for the session.
 */
export function sdpAnswerProblem(sdp: string, offer: string | null = null): string | null {
  if (!/^v=0\r?\n/.test(sdp)) return 'no v=0 line'
  const { session, sections } = parseSdp(sdp)
  for (const type of ['o', 's', 't']) {
    if (!session.some((line) => line.startsWith(`${type}=`))) return `no ${type}= line`
  }
  if (sections.length === 0) return 'no media section'
  if (offer !== null) {
    const offered = parseSdp(offer).sections.length
    if (sections.length !== offered) {
      return `${sections.length} media sections for the offer's ${offered}`
    }
  }
  const has = (lines: readonly string[], prefix: string): boolean =>
    lines.some((line) => line.startsWith(prefix))
  let accepted = 0
  for (const section of sections) {
    const media = WEBRTC_MEDIA.exec(section.media)
    if (!media) return `not a WebRTC media section: ${section.media.slice(0, 80)}`
    // Port 0 rejects the section; it needs nothing else.
    if (media[2] === '0') continue
    accepted += 1
    for (const prefix of ['a=ice-ufrag:', 'a=ice-pwd:', 'a=fingerprint:']) {
      if (!has(section.attributes, prefix) && !has(session, prefix)) {
        return `no ${prefix.slice(2, -1)} for ${media[1]}`
      }
    }
  }
  if (accepted === 0) return 'every media section rejected'
  return null
}

/** Bytes as upper-case hex pairs joined by colons, a fingerprint's notation. */
function hexPairs(bytes: Buffer): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':')
}

/** ICE characters (RFC 8839 `ice-char`) without `+` and `/`, which some parsers mishandle. */
function iceToken(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join('')
}

/**
 * A fresh offer as a browser makes it for live transcription: one Opus audio track sent and the
 * `oai-events` data channel, bundled, with its own ICE credentials, a DTLS fingerprint and
 * `a=setup:actpass`, so a WebRTC bridge can negotiate it and answer. It carries no candidates
 * (the bridge's ICE simply waits) and no certificate stands behind the fingerprint: the test
 * checks signaling, not media. A browser offer that waited for gathering looks the same plus
 * `a=candidate` lines.
 */
export function probeOffer(): string {
  const ufrag = iceToken(4)
  const pwd = iceToken(24)
  const fingerprint = `sha-256 ${hexPairs(randomBytes(32))}`
  const stream = iceToken(16)
  const track = randomUUID()
  const ssrc = randomInt(1, 2 ** 31)
  const transport = [
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:${fingerprint}`,
    'a=setup:actpass'
  ]
  return [
    'v=0',
    `o=- ${randomInt(1, 2 ** 47)} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'a=extmap-allow-mixed',
    `a=msid-semantic: WMS ${stream}`,
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    ...transport,
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=mid:0',
    'a=sendonly',
    `a=msid:${stream} ${track}`,
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    'a=rtcp-fb:111 transport-cc',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    `a=ssrc:${ssrc} cname:${iceToken(16)}`,
    `a=ssrc:${ssrc} msid:${stream} ${track}`,
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    ...transport,
    'a=mid:1',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    ''
  ].join('\r\n')
}
