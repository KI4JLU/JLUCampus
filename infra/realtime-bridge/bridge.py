"""JLU Campus realtime bridge.

Ported from HAWKI's realtime bridge (kiChat, `_docker/realtime-bridge/bridge.py`, GNU GPL v3),
with the same protocol. Changes against the original, marked "Campus:" below: JSON error answers
with the gateway's status, `POST /probe`, a connect timeout for peers that never connect, and
TURN credentials minted from a shared secret (coturn `use-auth-secret`).

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
bridge itself holds no gateway secrets; BRIDGE_API_KEY (optional) fences the HTTP API.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import os
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

BRIDGE_API_KEY = os.environ.get("BRIDGE_API_KEY", "")

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
    """Opens the gateway's realtime WebSocket; a refused handshake raises UpstreamRejected."""
    headers = {"Authorization": f"Bearer {gateway_key}"} if gateway_key else {}
    proxy, proxy_auth = env_proxy(url)
    try:
        return await http.ws_connect(
            url,
            headers=headers,
            heartbeat=20,
            max_msg_size=16 * 1024 * 1024,
            timeout=aiohttp.ClientWSTimeout(ws_close=5.0),
            proxy=proxy,
            proxy_auth=proxy_auth,
        )
    except aiohttp.WSServerHandshakeError as exc:
        raise UpstreamRejected(exc.status) from None


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
        self._spawn(self._expire_unconnected())
        return self.pc.localDescription.sdp

    async def _expire_unconnected(self):
        """Campus: closes a peer that does not connect within CONNECT_TIMEOUT_S."""
        await asyncio.sleep(CONNECT_TIMEOUT_S)
        if not self.closed and self.pc.connectionState != "connected":
            self.log.info("not connected after %.0fs, closing", CONNECT_TIMEOUT_S)
            await self.close()

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
            if data.get("type") == "input_audio_buffer.commit":
                if data.get("keep_open"):
                    self._spawn(self._rotate())
                else:
                    self._spawn(self._finalize())

    def _on_track(self, track):
        if track.kind != "audio":
            return
        self.log.info("audio track received")
        self._spawn(self._pump_audio(track))

    def _on_connection_state(self):
        state = self.pc.connectionState
        self.log.info("connection state: %s", state)
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
            await self.http.close()
            self.http = None
            raise

    async def _open_upstream(self, item_id: str):
        """Open one vLLM realtime stream for one item; returns (ws, done)."""
        url = realtime_url(self.gateway_base, self.model)
        ws = await connect_upstream_ws(self.http, url, self.gateway_key)
        # vLLM refuses audio until the model is validated via session.update
        # (note: `model` sits at the event's top level, unlike OpenAI).
        await ws.send_json({"type": "session.update", "model": self.model})
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
                    self.log.error("upstream error: %s", event)
                    self._channel_send(
                        {
                            "type": "conversation.item.input_audio_transcription.failed",
                            "item_id": item_id,
                            "error": event.get("error"),
                        }
                    )
                    # The item is resolved for the client - don't make a
                    # finalize wait for a done that will not come.
                    done.set()
        except Exception as exc:
            if not self.closed:
                self.log.warning("upstream reader ended: %r", exc)
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
                self._spawn(self._finalize())

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
            # Open the next stream while the current one finishes.
            opening = asyncio.ensure_future(self._open_upstream(next_item))
            try:
                await self._seal(old_ws, tail)
            finally:
                if old_ws is not None and not old_ws.closed:
                    try:
                        await old_ws.close()
                    except Exception:
                        pass

            try:
                new_ws, new_done = await opening
            except Exception as exc:
                self.log.error("next upstream failed: %r", exc)
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
        if self.closed:
            return
        self.closed = True
        self.log.info("closing session")
        for task in list(self.tasks):
            if task is not asyncio.current_task():
                task.cancel()
        if self.upstream is not None and not self.upstream.closed:
            try:
                await self.upstream.close()
            except Exception:
                pass
        if self.http is not None:
            await self.http.close()
        try:
            await self.pc.close()
        except Exception:
            pass

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

    def _spawn(self, coro):
        task = asyncio.ensure_future(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)


# ------------------------------------------------------------------ HTTP API


def error_response(status: int, error: str, message: str, **extra) -> web.Response:
    """Campus: errors as JSON, so the Campus server can tell a refused key or model apart from an
    unreachable gateway. `upstream_status` is the gateway's own status, if it answered."""
    return web.json_response({"error": error, "message": message, **extra}, status=status)


def authorized(request: web.Request) -> bool:
    if not BRIDGE_API_KEY:
        return True
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

    session = BridgeSession(*gateway)
    try:
        answer_sdp = await session.negotiate(offer_sdp)
    except UpstreamRejected as exc:
        logger.error("negotiation failed: %s", exc)
        await session.close()
        return error_response(
            502, "upstream_rejected", str(exc), upstream_status=exc.status, model=gateway[2]
        )
    except OfferRefused as exc:
        logger.warning("offer refused: %s", exc)
        await session.close()
        return error_response(400, "bad_offer", f"the offer cannot be negotiated: {exc}"[:300])
    except Exception as exc:
        logger.error("negotiation failed: %r", exc)
        await session.close()
        return error_response(502, "upstream_failed", f"upstream connection failed: {exc}")

    return web.Response(content_type="application/sdp", text=answer_sdp)


async def probe_refusal(ws, model: str) -> web.Response | None:
    """Campus: the upstream's refusal of the model within PROBE_WAIT_S, as an error answer, or
    None when it refuses nothing (vLLM answers a valid session.update with nothing or with a
    session event; `session.created` may come first)."""
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
            if event.get("type") == "session.updated":
                return None
            if event.get("type") == "error":
                error = event.get("error")
                detail = error.get("message") if isinstance(error, dict) else error
                return error_response(
                    502, "upstream_error", str(detail or "upstream error")[:300], model=model
                )
        elif msg.type in (
            aiohttp.WSMsgType.CLOSE,
            aiohttp.WSMsgType.CLOSING,
            aiohttp.WSMsgType.CLOSED,
            aiohttp.WSMsgType.ERROR,
        ):
            reason = msg.extra if isinstance(msg.extra, str) else ""
            return error_response(
                502,
                "upstream_closed",
                (reason or "the gateway closed the realtime connection")[:300],
                model=model,
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

    timeout = aiohttp.ClientTimeout(total=None, connect=UPSTREAM_CONNECT_TIMEOUT_S)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        try:
            ws = await connect_upstream_ws(http, realtime_url(gateway_base, model), gateway_key)
        except UpstreamRejected as exc:
            return error_response(
                502, "upstream_rejected", str(exc), upstream_status=exc.status, model=model
            )
        except Exception as exc:
            return error_response(502, "upstream_failed", f"upstream connection failed: {exc}")
        try:
            await ws.send_json({"type": "session.update", "model": model})
            refusal = await probe_refusal(ws, model)
            if refusal is not None:
                return refusal
        finally:
            await ws.close()
    return web.json_response({"ok": True, "model": model})


async def handle_health(_request: web.Request) -> web.Response:
    return web.Response(text="ok")


def make_app() -> web.Application:
    app = web.Application()
    app.router.add_post("/realtime", handle_realtime)
    app.router.add_post("/probe", handle_probe)
    app.router.add_get("/health", handle_health)
    return app


def main():
    port = int(os.environ.get("PORT", "8089"))
    host = os.environ.get("HOST", "0.0.0.0")
    if not BRIDGE_API_KEY and host not in ("127.0.0.1", "::1", "localhost"):
        logger.warning(
            "BRIDGE_API_KEY is not set while the API listens on %s - anyone reaching port %d "
            "can open gateway sessions with keys of their own; set it (and the server's "
            "TRANSCRIPTION_REALTIME_BRIDGE_KEY) or firewall the port",
            host,
            port,
        )
    logger.info("JLU Campus realtime bridge listening on %s:%d", host, port)
    web.run_app(make_app(), host=host, port=port, print=None)


if __name__ == "__main__":
    main()
