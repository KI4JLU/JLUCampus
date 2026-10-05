"""JLU Campus realtime bridge.

Ported from HAWKI's realtime bridge (kiChat, `_docker/realtime-bridge/bridge.py`, GNU GPL v3),
with the same protocol. Changes against the original, marked "Campus:" below: JSON error answers
with the gateway's status, `POST /probe`, a connect timeout for peers that never connect, TURN
credentials minted from a shared secret (coturn `use-auth-secret`), a mandatory BRIDGE_API_KEY,
a session limit with idle and lifetime limits, deadlines for the upstream handshake, the
negotiation and the probe with their cleanup after the answer, closes that release every resource
within their own time also when their caller gives up, coalesced rotations, and nothing the
upstream says in a log or an answer.

Bridges browser WebRTC connections to the vLLM realtime speech-to-text WebSocket (reached through
the LiteLLM gateway). Exists because vLLM's realtime endpoint is WebSocket-only: a browser
WebSocket cannot carry an Authorization header, so any direct connection would require exposing a
gateway API key to the client. With this bridge, the browser speaks WebRTC (authenticated once via
the Campus server's SDP relay, media needs no credential) and the gateway key stays server-side.

Protocol towards the browser (data channel "oai-events"): OpenAI Realtime API event names, as
kiChat's realtime_transcription.js and the Campus web app handle them:
  -> input_audio_buffer.committed              (item registered, drain anchor)
  -> conversation.item.input_audio_transcription.delta
  -> conversation.item.input_audio_transcription.completed
  -> conversation.item.input_audio_transcription.failed
                                               (Campus: error {code: "upstream_error"}, never
                                                the gateway's own words)
  -> error {code: session_idle|session_expired} (Campus: the session is finalized for lack of
                                                audio or at its maximum length)
  <- input_audio_buffer.commit                 (client asks to finalize; the session closes
                                                afterwards)
  <- input_audio_buffer.commit {keep_open: true}
                                               (the current item is finalized, the next one
                                                starts at once on a fresh upstream stream; audio
                                                in between is buffered, and every event of the
                                                new item comes after the old item's completed)
  <- session.update                            (ignored; session is server-managed)

Protocol towards vLLM (see vllm/entrypoints/speech_to_text/realtime/):
  -> session.update {model}                    (mandatory model validation)
  -> input_audio_buffer.append {audio}         (base64 PCM16 @ 16 kHz mono)
  -> input_audio_buffer.commit {final: false}  (starts decoding, sent early)
  -> input_audio_buffer.commit {final: true}   (ends the stream)
  <- transcription.delta / transcription.done / error

HTTP API (signaling is reached by the Campus server only, never by browsers):
  POST /realtime   SDP offer in (application/sdp), SDP answer out (application/sdp)
  POST /probe      opens one upstream stream, validates the model and closes it again
  GET  /health     "ok"

Per-request configuration comes from the Campus server via headers (X-Gateway-Base, X-Gateway-Key,
X-Model), so the module's settings stay the single source of truth for gateway credentials. The
bridge itself holds no gateway secrets; BRIDGE_API_KEY fences the HTTP API. Campus: the bridge
does not start without it, unless BRIDGE_ALLOW_UNAUTHENTICATED=1 with a loopback HOST
(development), and then takes requests from loopback only.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import sys
import time
import uuid

import aiohttp
import aiohttp.helpers
from aiohttp import web
from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
)
from av.audio.resampler import AudioResampler
from yarl import URL

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
)
logger = logging.getLogger("realtime-bridge")

TARGET_RATE = 16000
APPEND_CHUNK_BYTES = TARGET_RATE * 2 // 10  # 100 ms of PCM16 mono
# Decoding upstream only starts on the first (non-final) commit; send it as
# soon as a little audio has accumulated so deltas stream while speaking.
START_COMMIT_AFTER_BYTES = TARGET_RATE * 2 * 3 // 10  # 300 ms
DONE_TIMEOUT_S = 15.0
# Campus: a peer that is not connected after this is closed together with its upstream stream, so
# an offer that never connects (the admin connection test, a browser that went away during ICE)
# does not keep a gateway session open.
CONNECT_TIMEOUT_S = float(os.environ.get("CONNECT_TIMEOUT_S", "30"))
# Campus: how long /probe waits after session.update for the upstream to refuse the model.
PROBE_WAIT_S = float(os.environ.get("PROBE_WAIT_S", "1.5"))
UPSTREAM_CONNECT_TIMEOUT_S = 10.0
# Campus: deadlines before a session is connected, so a gateway (or anything in between) that
# takes the TCP/TLS connection and then never answers the WebSocket upgrade cannot hold a slot of
# MAX_SESSIONS. UPSTREAM_HANDSHAKE_TIMEOUT_S bounds opening one upstream stream (connection,
# upgrade response and session.update), for sessions, rotations and probes alike;
# NEGOTIATE_TIMEOUT_S bounds the whole answer to an offer (upstream plus WebRTC/ICE gathering),
# below the Campus server's 15 s, so the server gets a reason instead of giving up first;
# PROBE_TIMEOUT_S bounds a whole probe besides its own PROBE_WAIT_S.
UPSTREAM_HANDSHAKE_TIMEOUT_S = float(os.environ.get("UPSTREAM_HANDSHAKE_TIMEOUT_S", "10"))
NEGOTIATE_TIMEOUT_S = float(os.environ.get("NEGOTIATE_TIMEOUT_S", "14"))
PROBE_TIMEOUT_S = float(os.environ.get("PROBE_TIMEOUT_S", "14"))
# Campus: resource limits. Every session holds a peer connection and a gateway stream, so the
# bridge takes at most MAX_SESSIONS at once (probes included) and answers 503 "busy" beyond.
# A connected session ends (finalized, its transcript delivered) when no audio arrived for
# IDLE_TIMEOUT_S or after MAX_SESSION_S in all.
MAX_SESSIONS = int(os.environ.get("MAX_SESSIONS", "20"))
IDLE_TIMEOUT_S = float(os.environ.get("IDLE_TIMEOUT_S", "60"))
MAX_SESSION_S = float(os.environ.get("MAX_SESSION_S", str(4 * 3600)))
# How often a session's watchdog checks the limits above.
WATCH_INTERVAL_S = 1.0
# Rotations (keep_open commits) of one session start at most this often; one more asked for
# meanwhile waits, any further ones are folded into it.
ROTATE_MIN_INTERVAL_S = float(os.environ.get("ROTATE_MIN_INTERVAL_S", "1"))

BRIDGE_API_KEY = os.environ.get("BRIDGE_API_KEY", "")
# Campus: development without a key, only with a loopback HOST and only for loopback clients.
ALLOW_UNAUTHENTICATED = os.environ.get("BRIDGE_ALLOW_UNAUTHENTICATED", "") == "1"
LOOPBACK_HOSTS = ("127.0.0.1", "::1", "localhost")

# Sessions holding a slot of MAX_SESSIONS, and probes in flight (they hold one each too).
ACTIVE_SESSIONS: set = set()
active_probes = 0


def capacity_left() -> bool:
    """Campus: whether one more session or probe fits into MAX_SESSIONS."""
    return len(ACTIVE_SESSIONS) + active_probes < MAX_SESSIONS


# ---------------------------------------------------------------------------
# What reaches a log or a client
# ---------------------------------------------------------------------------
# Campus: a gateway may reflect the key it refused in its error, in any spelling (escaped, encoded,
# quoted). So nothing the upstream says reaches a log or a client at all, masked or not: logs get
# a fixed code, the gateway's status, the text's length in bytes and a keyed hash of it (`trace`),
# exceptions only their class name; clients and the Campus server get fixed codes and messages.
# mask() remains as a second line for the bridge's own messages.
_BEARER = re.compile(r"Bearer\s+(?!\*\*\*)[^\s\"',;)\]}]+", re.IGNORECASE)
_SK = re.compile(r"\bsk-(?!\*\*\*)[\w-]{6,}")
_KEY_FIELD = re.compile(
    r"((?:api[_-]?key|access[_-]?token|x-gateway-key|authorization)[\"']?\s*[:=]\s*[\"']?)"
    r"(?!\*\*\*|Bearer)[^\s\"',;)\]}]+",
    re.IGNORECASE,
)


def mask(text, *secrets: str, limit: int = 300) -> str:
    """`text` with the given secrets, however short, and anything that looks like a key masked,
    cut to `limit` afterwards (cut first, the start of a key at the cut would stay). Longer
    secrets go first, so one inside another leaves no rest of the longer one. Only for the
    bridge's own messages: upstream text never reaches a log (`trace`)."""
    safe = str(text)
    spellings = set()
    for secret in (BRIDGE_API_KEY, *secrets):
        if secret:
            spellings.update((secret, json.dumps(secret)[1:-1]))
    for secret in sorted(spellings, key=len, reverse=True):
        safe = safe.replace(secret, "***")
    safe = _BEARER.sub("Bearer ***", safe)
    safe = _SK.sub("sk-***", safe)
    safe = _KEY_FIELD.sub(r"\1***", safe)
    return safe[:limit]


# Campus: the key of `trace`'s hash, new for every process, so a hash in the log tells two
# answers apart (or alike) but cannot be checked against a guessed key.
_TRACE_KEY = os.urandom(32)


def trace(text) -> str:
    """Campus: what the log learns of an upstream text: its length in bytes and a short keyed
    hash, never the text itself."""
    data = text if isinstance(text, bytes) else str(text or "").encode("utf-8", "replace")
    digest = hmac.new(_TRACE_KEY, data, hashlib.sha256).hexdigest()[:12]
    return f"{len(data)} bytes, hash {digest}"


def failure_text(exc: BaseException) -> str:
    """Campus: an exception as the log names it: the bridge's own (a refused or stalled
    handshake) with their message, any other by its class only, as its text may quote the
    upstream."""
    if isinstance(exc, (UpstreamRejected, UpstreamTimeout)):
        return str(exc)
    return type(exc).__name__


# What clients learn about an upstream failure (data channel); never the upstream's own words.
CLIENT_UPSTREAM_ERROR = {"code": "upstream_error", "message": "the gateway reported an error"}

# ---------------------------------------------------------------------------
# ICE / TURN
# ---------------------------------------------------------------------------
# Host candidates alone only work when the browser can reach the bridge host
# directly on an arbitrary high port. On the university network that is not the
# case (only a few ports pass the firewall), so ICE stalls at "connecting" and
# no audio ever arrives. A TURN server on a permitted port relays the media.
#
#   TURN_URLS               comma-separated, e.g.
#                           "turns:turn.example.org:443?transport=tcp"
#   TURN_SECRET             Campus: coturn's static-auth-secret; credentials are
#                           minted per session (TURN REST API), as the Campus
#                           server does for browsers
#   TURN_USERNAME/PASSWORD  static credentials (instead of TURN_SECRET)
#   STUN_URLS               optional; pointless on a host with only a private IP
#
# Note: there is deliberately no relay-only switch. aiortc 1.15.0's
# RTCConfiguration exposes only iceServers/bundlePolicy/alwaysNegotiateDataChannels
# - no iceTransportPolicy (aioice supports transport_policy, aiortc never passes
# it through). So the bridge always gathers host candidates too and reaches the
# relay by ICE fallback; that works, it just costs a few seconds of checking the
# unreachable direct pairs first.
TURN_URLS = [u.strip() for u in os.environ.get("TURN_URLS", "").split(",") if u.strip()]
TURN_SECRET = os.environ.get("TURN_SECRET", "")
TURN_USERNAME = os.environ.get("TURN_USERNAME", "")
TURN_PASSWORD = os.environ.get("TURN_PASSWORD", "")
TURN_CREDENTIAL_SECONDS = int(os.environ.get("TURN_CREDENTIAL_SECONDS", "3600"))
STUN_URLS = [u.strip() for u in os.environ.get("STUN_URLS", "").split(",") if u.strip()]


def turn_credential(secret: str, now: float | None = None) -> tuple[str, str]:
    """Campus: a TURN REST API credential pair (coturn use-auth-secret): the user name is the
    expiry in Unix seconds, the password its HMAC-SHA1 with the shared secret, in Base64."""
    expires = int((now if now is not None else time.time()) + TURN_CREDENTIAL_SECONDS)
    username = f"{expires}:realtime-bridge"
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    return username, base64.b64encode(digest).decode()


def build_rtc_configuration() -> RTCConfiguration | None:
    """RTCConfiguration from env, or None to keep aiortc's host-only default. Built per session,
    so credentials minted from TURN_SECRET are fresh."""
    servers: list[RTCIceServer] = []
    if STUN_URLS:
        servers.append(RTCIceServer(urls=STUN_URLS))
    if TURN_URLS:
        if TURN_SECRET:
            username, password = turn_credential(TURN_SECRET)
        else:
            username, password = TURN_USERNAME, TURN_PASSWORD
        if not (username and password):
            logger.warning(
                "TURN_URLS set but neither TURN_SECRET nor TURN_USERNAME/TURN_PASSWORD - "
                "the relay will be advertised and then rejected by the server"
            )
        servers.append(
            RTCIceServer(
                urls=TURN_URLS,
                username=username or None,
                credential=password or None,
            )
        )
    if not servers:
        return None
    return RTCConfiguration(iceServers=servers)


if not (STUN_URLS or TURN_URLS):
    logger.warning(
        "no STUN/TURN configured - relying on host ICE candidates only; this "
        "works on a developer machine but not through a firewalled network"
    )
else:
    logger.info("ICE servers configured: stun=%d turn=%d", len(STUN_URLS), len(TURN_URLS))


def realtime_url(gateway_base: str, model: str) -> str:
    """The gateway's realtime WebSocket for `model`; the base has no /v1."""
    ws_base = gateway_base.rstrip("/").replace("https://", "wss://", 1).replace(
        "http://", "ws://", 1
    )
    return f"{ws_base}/v1/realtime?model={model}"


class UpstreamTimeout(Exception):
    """Campus: the gateway did not complete the realtime handshake within its deadline."""

    def __init__(self, seconds: float):
        super().__init__(f"the gateway did not complete the realtime handshake within {seconds:g}s")


class UpstreamRejected(Exception):
    """Campus: the gateway refused the WebSocket handshake (wrong key, model not allowed)."""

    def __init__(self, status: int):
        super().__init__(f"the gateway refused the realtime connection with status {status}")
        self.status = status


def env_proxy(url: str):
    """Campus: the HTTPS_PROXY/HTTP_PROXY for a ws(s) URL, honouring NO_PROXY, as (proxy, auth).
    aiohttp's trust_env looks up proxies by the URL's scheme, which finds none for wss://."""
    http_url = url.replace("wss://", "https://", 1).replace("ws://", "http://", 1)
    try:
        return aiohttp.helpers.get_env_proxy_for_url(URL(http_url))
    except LookupError:
        return None, None


async def connect_upstream_ws(http: aiohttp.ClientSession, url: str, gateway_key: str):
    """Opens the gateway's realtime WebSocket; a refused handshake raises UpstreamRejected, one
    that does not complete within UPSTREAM_HANDSHAKE_TIMEOUT_S (Campus: the upgrade response
    included, which aiohttp's connect timeout does not cover) UpstreamTimeout."""
    headers = {"Authorization": f"Bearer {gateway_key}"} if gateway_key else {}
    proxy, proxy_auth = env_proxy(url)
    try:
        async with asyncio.timeout(UPSTREAM_HANDSHAKE_TIMEOUT_S):
            return await http.ws_connect(
                url,
                headers=headers,
                heartbeat=20,
                max_msg_size=16 * 1024 * 1024,
                timeout=aiohttp.ClientWSTimeout(ws_close=WS_CLOSE_TIMEOUT_S),
                proxy=proxy,
                proxy_auth=proxy_auth,
            )
    except aiohttp.WSServerHandshakeError as exc:
        raise UpstreamRejected(exc.status) from None
    except TimeoutError:
        raise UpstreamTimeout(UPSTREAM_HANDSHAKE_TIMEOUT_S) from None


def abort_ws(ws) -> None:
    """Campus: drops a WebSocket's connection without the closing handshake. Nothing after a
    graceful close, which has released the connection already."""
    try:
        connection = getattr(ws, "_conn", None)
        transport = getattr(connection, "transport", None)
        if transport is not None:
            transport.abort()
        response = getattr(ws, "_response", None)
        if response is not None:
            response.close()
    except Exception:
        pass


async def close_quietly(ws) -> None:
    """Closes a WebSocket, whatever state it is in. Campus: the graceful close gets
    WS_CLOSE_TIMEOUT_S; when it runs out, fails or is cancelled, the connection is dropped
    (`abort_ws`), so no deadline of a caller leaves it open."""
    if ws is None:
        return
    try:
        if not ws.closed:
            async with asyncio.timeout(WS_CLOSE_TIMEOUT_S):
                await ws.close()
    except Exception:
        pass
    finally:
        abort_ws(ws)


async def close_http(http: aiohttp.ClientSession | None) -> None:
    """Campus: closes an HTTP session within HTTP_CLOSE_TIMEOUT_S. Its connections are closed as
    soon as the close starts; what it waits for afterwards is the TLS shutdown."""
    if http is None:
        return
    try:
        async with asyncio.timeout(HTTP_CLOSE_TIMEOUT_S):
            await http.close()
    except Exception:
        pass


async def close_stream(ws, http: aiohttp.ClientSession | None) -> None:
    """Campus: an upstream stream, then its HTTP session; the session is closed also when
    closing the stream fails, runs out of time or is cancelled."""
    try:
        await close_quietly(ws)
    finally:
        await close_http(http)


# Campus: cleanup after a failed or overdue negotiation or probe runs after the answer, so closing
# a stream (up to WS_CLOSE_TIMEOUT_S) cannot push the answer past NEGOTIATE_TIMEOUT_S or
# PROBE_TIMEOUT_S, and with the Campus server's 15 s. It gets CLEANUP_TIMEOUT_S, then it is
# cancelled: a stream it was still closing loses its connection (`close_quietly`), its HTTP session
# is closed all the same (`close_stream`), and a session's release runs on (BridgeSession.close).
# The tasks are kept here until they end.
CLEANUP_TIMEOUT_S = float(os.environ.get("CLEANUP_TIMEOUT_S", "10"))
BACKGROUND_TASKS: set = set()
# Campus: what each resource gets to close, whatever deadline its caller has (`close_quietly`,
# `close_http`, BridgeSession.close): a stream's closing handshake, an HTTP session's TLS
# shutdown, and how long a session's close waits for its peer connection.
WS_CLOSE_TIMEOUT_S = 5.0
HTTP_CLOSE_TIMEOUT_S = 5.0
PEER_CLOSE_TIMEOUT_S = 5.0


def keep(task: asyncio.Future) -> asyncio.Future:
    """Campus: holds a task that runs on after its answer until it ends."""
    BACKGROUND_TASKS.add(task)
    task.add_done_callback(BACKGROUND_TASKS.discard)
    return task


def in_background(coro, what: str) -> asyncio.Future:
    """Campus: runs a cleanup after the answer, within CLEANUP_TIMEOUT_S. Cancelling it at the
    deadline releases what it holds anyway: every close it runs is safe against that."""

    async def run():
        try:
            await asyncio.wait_for(coro, CLEANUP_TIMEOUT_S)
        except TimeoutError:
            logger.warning("%s did not finish within %gs", what, CLEANUP_TIMEOUT_S)
        except Exception as exc:
            logger.warning("%s failed: %s", what, failure_text(exc))

    return keep(asyncio.ensure_future(run()))


async def start_stream(http: aiohttp.ClientSession, url: str, gateway_key: str, model: str):
    """Campus: one upstream stream with its model validated (session.update), within
    UPSTREAM_HANDSHAKE_TIMEOUT_S for each step; a stream that does not get there is closed."""
    ws = await connect_upstream_ws(http, url, gateway_key)
    try:
        async with asyncio.timeout(UPSTREAM_HANDSHAKE_TIMEOUT_S):
            # vLLM refuses audio until the model is validated via session.update
            # (note: `model` sits at the event's top level, unlike OpenAI).
            await ws.send_json({"type": "session.update", "model": model})
    except TimeoutError:
        # Campus: closed after the answer (`in_background`), not before it.
        in_background(close_quietly(ws), "closing a stalled upstream stream")
        raise UpstreamTimeout(UPSTREAM_HANDSHAKE_TIMEOUT_S) from None
    except BaseException:
        in_background(close_quietly(ws), "closing an upstream stream")
        raise
    return ws


class OfferRefused(Exception):
    """Campus: an SDP offer the peer connection cannot negotiate."""


class BridgeSession:
    """One browser connection: RTCPeerConnection + upstream WebSocket."""

    def __init__(self, gateway_base: str, gateway_key: str, model: str):
        self.id = uuid.uuid4().hex[:12]
        self.gateway_base = gateway_base.rstrip("/")
        self.gateway_key = gateway_key
        self.model = model
        self.item_id = "item_" + self.id
        self.item_seq = 0
        self.log = logging.getLogger(f"session.{self.id}")

        configuration = build_rtc_configuration()
        self.pc = (
            RTCPeerConnection(configuration=configuration)
            if configuration is not None
            else RTCPeerConnection()
        )
        self.channel = None
        self.pending_client_events: list[dict] = []
        self.http: aiohttp.ClientSession | None = None
        self.upstream: aiohttp.ClientWebSocketResponse | None = None
        self.tasks: set[asyncio.Task] = set()
        self.audio_buffer = bytearray()
        self.bytes_sent = 0
        # Per item (segment): bytes appended and whether decoding started.
        self.segment_bytes = 0
        self.generation_started = False
        self.finalizing = False
        self.done_received = asyncio.Event()
        # Item rotation (keep_open commit): while the next upstream stream is
        # being opened, audio collects in `hold` instead of being dropped.
        self.rotating = False
        self.hold = bytearray()
        self.segment_lock = asyncio.Lock()
        self.closed = False
        # Campus: the release of the session's resources (`close`), once.
        self.closing: asyncio.Future | None = None
        # Campus: one rotation at a time and at most one more waiting (`rotation_again`), one
        # finalization, and the watchdog's clock.
        self.rotation_pending = False
        self.rotation_again = False
        self.last_rotation_at = float("-inf")
        self.finalize_requested = False
        self.connected_once = False
        self.opened_at = time.monotonic()
        self.last_audio_at = self.opened_at

        self.pc.on("datachannel", self._on_datachannel)
        self.pc.on("track", self._on_track)
        self.pc.on("connectionstatechange", self._on_connection_state)

    # ---------------------------------------------------------------- WebRTC

    async def negotiate(self, offer_sdp: str) -> str:
        """Connect upstream first (fail fast), then answer the SDP offer."""
        await self._connect_upstream()

        try:
            await self.pc.setRemoteDescription(
                RTCSessionDescription(sdp=offer_sdp, type="offer")
            )
            answer = await self.pc.createAnswer()
            # setLocalDescription performs ICE gathering; the returned SDP
            # contains all host candidates.
            await self.pc.setLocalDescription(answer)
        except Exception as exc:
            # Campus: an offer aiortc cannot take is the client's fault, not the gateway's.
            raise OfferRefused(str(exc) or exc.__class__.__name__) from exc
        self.log.info("negotiated (model=%s)", self.model)
        self._spawn(self._watch())
        return self.pc.localDescription.sdp

    def watch_verdict(self, now: float) -> str | None:
        """Campus: why the session must end now, if it must: `unconnected` (never connected
        within CONNECT_TIMEOUT_S), `idle` (no audio for IDLE_TIMEOUT_S once connected) or
        `expired` (MAX_SESSION_S in all)."""
        if not self.connected_once:
            return "unconnected" if now - self.opened_at >= CONNECT_TIMEOUT_S else None
        if now - self.opened_at >= MAX_SESSION_S:
            return "expired"
        if now - self.last_audio_at >= IDLE_TIMEOUT_S:
            return "idle"
        return None

    async def _watch(self):
        """Campus: closes a peer that never connects, and finalizes a connected one that sends
        no audio or outlives its lifetime, telling its client why."""
        while not self.closed and not self.finalize_requested:
            await asyncio.sleep(WATCH_INTERVAL_S)
            if self.closed or self.finalize_requested:
                return
            verdict = self.watch_verdict(time.monotonic())
            if verdict is None:
                continue
            if verdict == "unconnected":
                self.log.info("not connected after %.0fs, closing", CONNECT_TIMEOUT_S)
                await self.close()
                return
            self.log.info("session %s, finalizing", verdict)
            message = (
                "no audio arrived for too long"
                if verdict == "idle"
                else "the session reached its maximum length"
            )
            self._channel_send(
                {"type": "error", "error": {"code": f"session_{verdict}", "message": message}}
            )
            self._request_finalize()
            return

    def _on_datachannel(self, channel):
        self.log.info("data channel opened: %s", channel.label)
        self.channel = channel
        for event in self.pending_client_events:
            self._channel_send(event)
        self.pending_client_events.clear()

        @channel.on("message")
        def on_message(message):
            try:
                data = json.loads(message)
            except (TypeError, ValueError):
                return
            # The client asks to finalize (user stopped recording) or, with
            # keep_open, to close the current item and continue with the next
            # one. Any session.update or other client events are intentionally
            # ignored: the upstream session is bridge-managed.
            # Campus: rotations asked for while one runs fold into a single next one, which
            # starts ROTATE_MIN_INTERVAL_S after the last, so a flood of commits can neither
            # queue up work nor open gateway streams faster than that.
            if data.get("type") == "input_audio_buffer.commit":
                if data.get("keep_open"):
                    if self.finalize_requested:
                        return
                    if self.rotation_pending:
                        self.rotation_again = True
                        return
                    self.rotation_pending = True
                    self._spawn(self._rotate())
                else:
                    self._request_finalize()

    def _on_track(self, track):
        if track.kind != "audio":
            return
        self.log.info("audio track received")
        self._spawn(self._pump_audio(track))

    def _on_connection_state(self):
        state = self.pc.connectionState
        self.log.info("connection state: %s", state)
        if state == "connected" and not self.connected_once:
            self.connected_once = True
            self.last_audio_at = time.monotonic()
        if state in ("failed", "closed"):
            self._spawn(self.close())

    # -------------------------------------------------------------- upstream

    async def _connect_upstream(self):
        """First upstream stream, opened during negotiation (fail fast)."""
        self.http = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=None, connect=UPSTREAM_CONNECT_TIMEOUT_S)
        )
        try:
            self.upstream, self.done_received = await self._open_upstream(self.item_id)
        except Exception:
            await close_http(self.http)
            self.http = None
            raise

    async def _open_upstream(self, item_id: str):
        """Open one vLLM realtime stream for one item; returns (ws, done)."""
        url = realtime_url(self.gateway_base, self.model)
        ws = await start_stream(self.http, url, self.gateway_key, self.model)
        done = asyncio.Event()
        self._spawn(self._read_upstream(ws, item_id, done))
        self.log.info("upstream connected: %s (%s)", url, item_id)
        return ws, done

    async def _read_upstream(self, ws, item_id: str, done: asyncio.Event):
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                event = json.loads(msg.data)
                etype = event.get("type")

                if etype == "transcription.delta":
                    delta = event.get("delta", "")
                    if delta:
                        self.log.debug("delta: %r", delta)
                        self._channel_send(
                            {
                                "type": "conversation.item.input_audio_transcription.delta",
                                "item_id": item_id,
                                "delta": delta,
                            }
                        )
                elif etype == "transcription.done":
                    self.log.info(
                        "transcription done (%d chars, %s)", len(event.get("text", "")), item_id
                    )
                    self._channel_send(
                        {
                            "type": "conversation.item.input_audio_transcription.completed",
                            "item_id": item_id,
                            "transcript": event.get("text", ""),
                        }
                    )
                    done.set()
                elif etype == "error":
                    # Campus: neither the log nor the client get the gateway's words (`trace`).
                    self.log.error("upstream error event (%s, %s)", item_id, trace(msg.data))
                    self._channel_send(
                        {
                            "type": "conversation.item.input_audio_transcription.failed",
                            "item_id": item_id,
                            "error": CLIENT_UPSTREAM_ERROR,
                        }
                    )
                    # The item is resolved for the client - don't make a
                    # finalize wait for a done that will not come.
                    done.set()
        except Exception as exc:
            if not self.closed:
                self.log.warning("upstream reader ended: %s", failure_text(exc))
        finally:
            done.set()

    # ----------------------------------------------------------------- audio

    async def _pump_audio(self, track):
        resampler = AudioResampler(format="s16", layout="mono", rate=TARGET_RATE)
        pump_start = None
        last_stat = 0.0
        try:
            while not self.finalizing:
                frame = await track.recv()
                self.last_audio_at = time.monotonic()
                if pump_start is None:
                    pump_start = time.monotonic()
                    self.log.info("first audio frame received")
                for out in resampler.resample(frame):
                    self.audio_buffer.extend(bytes(out.planes[0])[: out.samples * 2])
                while len(self.audio_buffer) >= APPEND_CHUNK_BYTES:
                    chunk = bytes(self.audio_buffer[:APPEND_CHUNK_BYTES])
                    del self.audio_buffer[:APPEND_CHUNK_BYTES]
                    await self._send_audio(chunk)
                # If the audio clock falls behind the wall clock, either the
                # client isn't sending in realtime or this pump is starved.
                elapsed = time.monotonic() - pump_start
                if elapsed - last_stat >= 5.0:
                    last_stat = elapsed
                    audio_s = self.bytes_sent / (TARGET_RATE * 2)
                    self.log.info(
                        "audio clock: %.1fs sent / %.1fs wall (lag %.1fs)",
                        audio_s,
                        elapsed,
                        elapsed - audio_s,
                    )
        except Exception as exc:
            # MediaStreamError: the client closed the connection or stopped
            # the track without asking to finalize (e.g. tab closed).
            if not self.finalizing and not self.closed:
                self.log.info("audio track ended (%r), finalizing", exc)
                self._request_finalize()

    async def _send_audio(self, chunk: bytes):
        if self.rotating:
            self.hold.extend(chunk)
            return
        if self.upstream is None or self.upstream.closed:
            return
        await self._append(self.upstream, chunk)

    async def _append(self, ws, chunk: bytes):
        """Append audio to the current item's stream; starts decoding early."""
        await ws.send_json(
            {
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(chunk).decode(),
            }
        )
        self.bytes_sent += len(chunk)
        self.segment_bytes += len(chunk)
        if not self.generation_started and self.segment_bytes >= START_COMMIT_AFTER_BYTES:
            await self._start_generation(ws)

    async def _start_generation(self, ws):
        self.generation_started = True
        await ws.send_json({"type": "input_audio_buffer.commit", "final": False})
        # Anchor for the client's stop()-drain logic: it waits for this
        # item to complete before tearing the connection down.
        self._channel_send({"type": "input_audio_buffer.committed", "item_id": self.item_id})
        self.log.info("generation started (%s)", self.item_id)

    # -------------------------------------------------------------- lifecycle

    async def _seal(self, ws, tail: bytes):
        """Finish the current item: flush its audio, end its stream and wait
        for the final transcript (or report the item failed)."""
        item_id, done = self.item_id, self.done_received
        if ws is not None and not ws.closed:
            if tail:
                await ws.send_json(
                    {
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(tail).decode(),
                    }
                )
                self.bytes_sent += len(tail)
                self.segment_bytes += len(tail)
            if not self.generation_started:
                # Too little audio to have started generation: start it now,
                # otherwise the final commit has nothing to close.
                await self._start_generation(ws)
            await ws.send_json({"type": "input_audio_buffer.commit", "final": True})

        try:
            await asyncio.wait_for(done.wait(), DONE_TIMEOUT_S)
        except asyncio.TimeoutError:
            self.log.error("no transcription.done within %.0fs (%s)", DONE_TIMEOUT_S, item_id)
            self._channel_send(
                {
                    "type": "conversation.item.input_audio_transcription.failed",
                    "item_id": item_id,
                    "error": "timeout waiting for final transcription",
                }
            )

    async def _rotate(self):
        """keep_open commit: finalize the current item, continue with the next
        one. The WebRTC connection stays up; audio arriving meanwhile is held
        and handed to the next item, so nothing said after the send is lost."""
        try:
            while True:
                wait = self.last_rotation_at + ROTATE_MIN_INTERVAL_S - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                if self.finalize_requested or self.closed:
                    return
                self.last_rotation_at = time.monotonic()
                await self._rotate_item()
                if not self.rotation_again:
                    return
                self.rotation_again = False
        finally:
            self.rotation_pending = False
            self.rotation_again = False

    async def _rotate_item(self):
        async with self.segment_lock:
            if self.finalizing or self.closed:
                return
            self.rotating = True
            old_ws = self.upstream
            self.upstream = None
            tail = bytes(self.audio_buffer)
            self.audio_buffer.clear()

            self.item_seq += 1
            next_item = f"item_{self.id}_{self.item_seq}"
            self.log.info(
                "rotating %s -> %s (%.1fs in item)",
                self.item_id,
                next_item,
                (self.segment_bytes + len(tail)) / (TARGET_RATE * 2),
            )
            # Open the next stream while the current one finishes. Campus: tracked, so close()
            # cancels it too; it ends within UPSTREAM_HANDSHAKE_TIMEOUT_S anyway, so a
            # finalization waiting for this rotation never waits behind a stalled open.
            opening = self._spawn(self._open_upstream(next_item))
            try:
                await self._seal(old_ws, tail)
            finally:
                await close_quietly(old_ws)

            try:
                new_ws, new_done = await opening
            except Exception as exc:
                self.log.error("next upstream failed: %s", failure_text(exc))
                self._channel_send(
                    {
                        "type": "conversation.item.input_audio_transcription.failed",
                        "item_id": next_item,
                        "error": "upstream connection failed",
                    }
                )
                self.rotating = False
                self._spawn(self.close())
                return

            self.item_id, self.done_received = next_item, new_done
            self.segment_bytes = 0
            self.generation_started = False
            # Hand over the held audio before the pump may write again; the
            # pump keeps appending to `hold` until `rotating` is cleared, and
            # there is no await between the empty check and the switch.
            while self.hold:
                chunk = bytes(self.hold[:APPEND_CHUNK_BYTES])
                del self.hold[:APPEND_CHUNK_BYTES]
                await self._append(new_ws, chunk)
            self.upstream = new_ws
            self.rotating = False

    def _request_finalize(self):
        """Campus: finalizes once, however often the client or the watchdog asks."""
        if self.finalize_requested or self.closed:
            return
        self.finalize_requested = True
        self._spawn(self._finalize())

    async def _finalize(self):
        if self.finalizing:
            return
        self.finalizing = True
        self.log.info("finalizing (%.1fs audio sent)", self.bytes_sent / (TARGET_RATE * 2))

        try:
            # A rotation in progress completes first (it owns the upstream).
            async with self.segment_lock:
                tail = bytes(self.audio_buffer) + bytes(self.hold)
                self.audio_buffer.clear()
                self.hold.clear()
                await self._seal(self.upstream, tail)
        finally:
            # Give the data channel a moment to flush the completed event
            # before the peer connection goes away.
            await asyncio.sleep(0.5)
            await self.close()

    async def close(self):
        """Ends the session and releases its resources. Campus: the release runs as a task of its
        own (held in BACKGROUND_TASKS until it ends), so a caller that is cancelled, a cleanup
        deadline say, stops waiting for it and does not stop it. Every call waits for the same
        release."""
        if self.closing is None:
            self.closed = True
            ACTIVE_SESSIONS.discard(self)
            self.log.info("closing session")
            for task in list(self.tasks):
                if task is not asyncio.current_task():
                    task.cancel()
            self.closing = keep(asyncio.ensure_future(self._release()))
        await asyncio.shield(self.closing)

    async def _release(self):
        """Campus: the peer connection, and the upstream stream followed by its HTTP session, each
        within its own time (`close_stream`, PEER_CLOSE_TIMEOUT_S) and each also when another
        fails. aiortc's close is never cancelled halfway, which would leave it unable to close
        again; it runs on in BACKGROUND_TASKS if it takes longer."""
        peer = keep(asyncio.ensure_future(self._close_peer()))
        try:
            await close_stream(self.upstream, self.http)
        finally:
            try:
                await asyncio.wait_for(asyncio.shield(peer), PEER_CLOSE_TIMEOUT_S)
            except TimeoutError:
                self.log.warning("peer connection not closed within %gs", PEER_CLOSE_TIMEOUT_S)

    async def _close_peer(self):
        try:
            await self.pc.close()
        except Exception as exc:
            self.log.warning("closing the peer connection failed: %s", failure_text(exc))

    # ----------------------------------------------------------------- utils

    def _channel_send(self, event: dict):
        if self.channel is None:
            self.pending_client_events.append(event)
            return
        if self.channel.readyState != "open":
            return
        try:
            self.channel.send(json.dumps(event))
        except Exception as exc:
            self.log.warning("data channel send failed: %r", exc)

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.ensure_future(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task


# ------------------------------------------------------------------ HTTP API


def error_response(status: int, error: str, message: str, **extra) -> web.Response:
    """Campus: errors as JSON, so the Campus server can tell a refused key or model apart from an
    unreachable gateway. `upstream_status` is the gateway's own status, if it answered."""
    return web.json_response({"error": error, "message": message, **extra}, status=status)


def authorized(request: web.Request) -> bool:
    """The Campus server's bearer. Campus: without BRIDGE_API_KEY nothing passes, unless the
    development mode allows it, and then only from loopback (main() refuses any other HOST)."""
    if not BRIDGE_API_KEY:
        return ALLOW_UNAUTHENTICATED and request.remote in ("127.0.0.1", "::1")
    auth = request.headers.get("Authorization", "")
    return hmac.compare_digest(auth.encode(), f"Bearer {BRIDGE_API_KEY}".encode())


def gateway_headers(request: web.Request) -> tuple[str, str, str] | None:
    gateway_base = request.headers.get("X-Gateway-Base", "").strip()
    gateway_key = request.headers.get("X-Gateway-Key", "").strip()
    model = request.headers.get("X-Model", "").strip()
    if not gateway_base or not model:
        return None
    return gateway_base, gateway_key, model


async def handle_realtime(request: web.Request) -> web.Response:
    if not authorized(request):
        return error_response(401, "unauthorized", "missing or wrong bridge API key")

    gateway = gateway_headers(request)
    if gateway is None:
        return error_response(400, "bad_request", "X-Gateway-Base and X-Model are required")

    offer_sdp = await request.text()
    if not offer_sdp.startswith("v="):
        return error_response(400, "bad_request", "body must be an SDP offer")

    # Campus: the slot is taken before anything opens and freed on every path.
    if not capacity_left():
        logger.warning("session refused: %d sessions open (MAX_SESSIONS)", len(ACTIVE_SESSIONS))
        return error_response(503, "busy", "the bridge holds as many sessions as it takes")
    session = BridgeSession(*gateway)
    ACTIVE_SESSIONS.add(session)

    def drop(reason: str) -> None:
        """Frees the slot now and closes the session after the answer."""
        ACTIVE_SESSIONS.discard(session)
        in_background(session.close(), f"closing a session after {reason}")

    # Campus: the whole negotiation has a deadline, so a stalled step frees the slot, and the
    # answer does not wait for the cleanup of a negotiation that ran out of time (`in_background`).
    negotiation = asyncio.ensure_future(session.negotiate(offer_sdp))
    try:
        await asyncio.wait({negotiation}, timeout=NEGOTIATE_TIMEOUT_S)
    except BaseException:
        negotiation.cancel()
        keep(negotiation)
        drop("a cancelled request")
        raise
    if not negotiation.done():
        negotiation.cancel()
        keep(negotiation)
        logger.error("negotiation did not complete within %gs", NEGOTIATE_TIMEOUT_S)
        drop("its negotiation deadline")
        return error_response(
            504,
            "upstream_failed",
            f"upstream connection failed: the negotiation did not complete within "
            f"{NEGOTIATE_TIMEOUT_S:g}s",
        )
    try:
        answer_sdp = negotiation.result()
    except UpstreamTimeout as exc:
        logger.error("negotiation failed: %s", exc)
        drop("a stalled handshake")
        return error_response(504, "upstream_failed", f"upstream connection failed: {exc}")
    except UpstreamRejected as exc:
        logger.error("negotiation failed: %s", exc)
        drop("a refused handshake")
        return error_response(
            502, "upstream_rejected", str(exc), upstream_status=exc.status, model=gateway[2]
        )
    except OfferRefused as exc:
        # The offer is the Campus server's, aiortc's words about it are no gateway's.
        logger.warning("offer refused: %s", mask(exc, gateway[1]))
        drop("a refused offer")
        return error_response(400, "bad_offer", "the offer cannot be negotiated")
    except Exception as exc:
        # Campus: the exception's text may quote the gateway; neither log nor answer get it.
        logger.error("negotiation failed: %s", failure_text(exc))
        drop("a failed negotiation")
        return error_response(502, "upstream_failed", "upstream connection failed")

    return web.Response(content_type="application/sdp", text=answer_sdp)


async def probe_refusal(ws, model: str) -> web.Response | None:
    """Campus: the upstream's refusal of the model within PROBE_WAIT_S, as an error answer, or
    None when it refuses nothing (vLLM answers a valid session.update with nothing or with a
    session event; `session.created` may come first). The answer has fixed words; the log the
    refusal's length and hash (`trace`)."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + PROBE_WAIT_S
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            return None
        try:
            msg = await ws.receive(timeout=remaining)
        except asyncio.TimeoutError:
            return None
        if msg.type == aiohttp.WSMsgType.TEXT:
            try:
                event = json.loads(msg.data)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            if event.get("type") == "session.updated":
                return None
            if event.get("type") == "error":
                logger.warning("probe: upstream error event (%s)", trace(msg.data))
                return error_response(
                    502, "upstream_error", "the gateway refused the realtime session", model=model
                )
        elif msg.type in (
            aiohttp.WSMsgType.CLOSE,
            aiohttp.WSMsgType.CLOSING,
            aiohttp.WSMsgType.CLOSED,
            aiohttp.WSMsgType.ERROR,
        ):
            code = msg.data if isinstance(msg.data, int) else None
            reason = msg.extra if isinstance(msg.extra, str) else ""
            logger.warning("probe: upstream closed (code %s, reason %s)", code, trace(reason))
            return error_response(
                502,
                "upstream_closed",
                "the gateway closed the realtime connection",
                model=model,
                **({"upstream_close_code": code} if code is not None else {}),
            )


async def handle_probe(request: web.Request) -> web.Response:
    """Campus: whether the gateway takes the key and model, without any WebRTC: opens one
    realtime stream, sends session.update and waits PROBE_WAIT_S for the upstream to refuse the
    model (an `error` event or a close), then closes the stream. Sends no audio."""
    if not authorized(request):
        return error_response(401, "unauthorized", "missing or wrong bridge API key")
    gateway = gateway_headers(request)
    if gateway is None:
        return error_response(400, "bad_request", "X-Gateway-Base and X-Model are required")
    gateway_base, gateway_key, model = gateway
    if not capacity_left():
        return error_response(503, "busy", "the bridge holds as many sessions as it takes")

    global active_probes
    active_probes += 1
    # Campus: the whole probe has a deadline besides PROBE_WAIT_S, so it always frees its slot;
    # one that runs out of time is cancelled and closes its stream after the answer.
    probing = asyncio.ensure_future(probe(gateway_base, gateway_key, model))
    try:
        await asyncio.wait({probing}, timeout=PROBE_TIMEOUT_S)
        if probing.done():
            return probing.result()
        probing.cancel()
        keep(probing)
        logger.error("probe did not complete within %gs", PROBE_TIMEOUT_S)
        return error_response(
            504,
            "upstream_failed",
            f"upstream connection failed: the probe did not complete within {PROBE_TIMEOUT_S:g}s",
        )
    except BaseException:
        probing.cancel()
        keep(probing)
        raise
    finally:
        active_probes -= 1


async def probe(gateway_base: str, gateway_key: str, model: str) -> web.Response:
    """Campus: the probe itself (handle_probe), within the handshake deadlines of start_stream."""
    timeout = aiohttp.ClientTimeout(total=None, connect=UPSTREAM_CONNECT_TIMEOUT_S)
    http = aiohttp.ClientSession(timeout=timeout)
    ws = None
    try:
        try:
            ws = await start_stream(http, realtime_url(gateway_base, model), gateway_key, model)
        except UpstreamRejected as exc:
            return error_response(
                502, "upstream_rejected", str(exc), upstream_status=exc.status, model=model
            )
        except UpstreamTimeout as exc:
            return error_response(504, "upstream_failed", f"upstream connection failed: {exc}")
        except Exception as exc:
            logger.warning("probe failed: %s", failure_text(exc))
            return error_response(502, "upstream_failed", "upstream connection failed")
        refusal = await probe_refusal(ws, model)
        return refusal if refusal is not None else web.json_response({"ok": True, "model": model})
    finally:
        # Campus: the stream closes after the answer, so a slow close cannot delay it.
        in_background(close_probe(ws, http), "closing a probe")


async def close_probe(ws, http: aiohttp.ClientSession) -> None:
    """Campus: a probe's stream, then its HTTP session (`close_stream`)."""
    await close_stream(ws, http)


async def handle_health(_request: web.Request) -> web.Response:
    return web.Response(text="ok")


def make_app() -> web.Application:
    app = web.Application()
    app.router.add_post("/realtime", handle_realtime)
    app.router.add_post("/probe", handle_probe)
    app.router.add_get("/health", handle_health)
    return app


def startup_problem(key: str, allow_unauthenticated: bool, host: str) -> str | None:
    """Campus: why the bridge must not start, if it must not. Without BRIDGE_API_KEY anyone who
    reaches the port could make it connect wherever X-Gateway-Base points."""
    if key:
        return None
    if not allow_unauthenticated:
        return (
            "BRIDGE_API_KEY is not set: set it to the server's TRANSCRIPTION_REALTIME_BRIDGE_KEY "
            "(for development on this machine only: BRIDGE_ALLOW_UNAUTHENTICATED=1 with "
            "HOST=127.0.0.1)"
        )
    if host not in LOOPBACK_HOSTS:
        return (
            f"BRIDGE_ALLOW_UNAUTHENTICATED=1 needs a loopback HOST, not {host}: "
            "set BRIDGE_API_KEY instead"
        )
    return None


def main():
    port = int(os.environ.get("PORT", "8089"))
    host = os.environ.get("HOST", "0.0.0.0")
    problem = startup_problem(BRIDGE_API_KEY, ALLOW_UNAUTHENTICATED, host)
    if problem:
        logger.error("refusing to start: %s", problem)
        sys.exit(1)
    if not BRIDGE_API_KEY:
        logger.warning(
            "BRIDGE_API_KEY is not set: requests from loopback pass unauthenticated "
            "(BRIDGE_ALLOW_UNAUTHENTICATED=1, development only)"
        )
    logger.info("JLU Campus realtime bridge listening on %s:%d", host, port)
    web.run_app(make_app(), host=host, port=port, print=None)


if __name__ == "__main__":
    main()
