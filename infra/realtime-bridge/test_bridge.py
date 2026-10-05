"""End-to-end tests of the bridge against a fake gateway realtime WebSocket (vLLM's protocol) and
an aiortc client in the browser's role: audio track plus the `oai-events` data channel.

    python -m unittest -v test_bridge                     # with aiohttp and aiortc installed
    docker run --rm --network host -v "$PWD/test_bridge.py:/app/test_bridge.py:ro" \
      justcampus-realtime-bridge python -m unittest -v test_bridge
"""

import asyncio
import json
import os
import unittest
from contextlib import nullcontext
from urllib.parse import quote

os.environ.setdefault("LOG_LEVEL", "WARNING")

import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402
from aiortc import RTCConfiguration, RTCPeerConnection, RTCSessionDescription  # noqa: E402
from aiortc.mediastreams import AudioStreamTrack  # noqa: E402
from aioice import ice as aioice_ice, stun, turn as aioice_turn  # noqa: E402

import bridge  # noqa: E402

GATEWAY_KEY = "test-gateway-key-0123456789"
# An offer aiortc refuses: its session is admitted, then closed at once (400 bad_offer).
UNUSABLE_OFFER = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 RTP/AVP 0\r\n"
# Campus (D-1): a key with both quote kinds and characters URL encoding changes.
ODD_KEY = "gw\"odd'key/=+0123456789"
MODEL = "voxtral-mini-realtime"


class FakeGateway:
    """The gateway's `/v1/realtime`: 403 for a wrong key or a model the key may not use, an
    `error` event for an unknown model (`reflect…`: one that repeats the key, as a careless
    gateway might, as it is, URL-encoded, as the error code, in a close reason or in a text that
    is no JSON), else deltas while audio arrives and `transcription.done` on the final commit."""

    def __init__(self):
        self.keys = {GATEWAY_KEY, ODD_KEY}
        self.connections = []
        self.closed = 0
        self.runner = None
        self.base = ""
        # Campus: from this many connections on, the upgrade response never comes (until stop).
        self.stall_from = None
        self.release = asyncio.Event()

    async def start(self):
        app = web.Application()
        app.router.add_get("/v1/realtime", self.realtime)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"

    async def stop(self):
        self.release.set()
        await self.runner.cleanup()

    async def realtime(self, request):
        if self.stall_from is not None and len(self.connections) >= self.stall_from:
            await self.release.wait()
            return web.Response(status=503)
        model = request.query.get("model", "")
        key = request.headers.get("Authorization", "").removeprefix("Bearer ")
        if key not in self.keys or model == "denied":
            return web.Response(status=403)
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        # vLLM greets every connection before the model is validated.
        await ws.send_json({"type": "session.created", "id": "sess"})
        connection = {"model": model, "events": [], "bytes": 0, "transport": request.transport}
        self.connections.append(connection)
        if model == "silent-close":
            # Campus (E-2): reads nothing more, so a closing handshake never completes.
            await self.release.wait()
            return ws
        deltas = []
        started = False
        async for msg in ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            event = json.loads(msg.data)
            connection["events"].append(event["type"])
            if event["type"] == "session.update":
                connection["session_model"] = event.get("model")
                if event.get("model") == "unknown":
                    await ws.send_json({"type": "error", "error": {"message": "Unknown model"}})
                if event.get("model") == "reflect":
                    await ws.send_json(
                        {
                            "type": "error",
                            "error": {
                                "code": "invalid_key",
                                "message": f"Key {key} (Bearer {key}) is invalid",
                            },
                        }
                    )
                if event.get("model") == "reflect-encoded":
                    await ws.send_json(
                        {
                            "type": "error",
                            "error": {
                                "code": "invalid_credential",
                                "message": f"Rejected credential {quote(key, safe='')}",
                            },
                        }
                    )
                if event.get("model") == "reflect-code":
                    await ws.send_json({"type": "error", "error": {"code": key}})
                if event.get("model") == "reflect-close":
                    await ws.close(code=4001, message=f"Rejected {key!r}".encode())
                    break
                if event.get("model") == "reflect-garbage":
                    await ws.send_str(f"Rejected credential {key!r}")
            elif event["type"] == "input_audio_buffer.append":
                connection["bytes"] += len(event["audio"]) * 3 // 4
                # A word for every half second of decoded audio.
                if started and connection["bytes"] // 16000 > len(deltas):
                    deltas.append(" wort" if deltas else "wort")
                    await ws.send_json({"type": "transcription.delta", "delta": deltas[-1]})
            elif event["type"] == "input_audio_buffer.commit":
                if not event.get("final"):
                    started = True
                else:
                    await ws.send_json({"type": "transcription.done", "text": "".join(deltas)})
        self.closed += 1
        return ws


class StalledGateway:
    """Campus: takes TCP connections and reads the upgrade request, but never answers it."""

    def __init__(self):
        self.server = None
        self.base = ""
        self.writers = []

    async def start(self):
        async def accept(reader, writer):
            self.writers.append(writer)
            while await reader.read(4096):
                pass

        self.server = await asyncio.start_server(accept, "127.0.0.1", 0)
        port = self.server.sockets[0].getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"

    async def stop(self):
        for writer in self.writers:
            writer.close()
        self.server.close()


class BridgeServer:
    def __init__(self):
        self.runner = None
        self.url = ""

    async def start(self):
        self.runner = web.AppRunner(bridge.make_app())
        await self.runner.setup()
        site = web.TCPSite(self.runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.url = f"http://127.0.0.1:{port}"

    async def stop(self):
        await self.runner.cleanup()


def host_only():
    """Host candidates only: without ICE servers aiortc asks a public STUN server, which these
    tests neither need nor may reach."""
    return RTCConfiguration(iceServers=[])


def gateway_headers(base, model=MODEL, key=GATEWAY_KEY):
    return {"X-Gateway-Base": base, "X-Gateway-Key": key, "X-Model": model}


async def wait_for(predicate, timeout=10.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.05)


class BridgeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        bridge.BRIDGE_API_KEY = ""
        bridge.ALLOW_UNAUTHENTICATED = True
        bridge.CONNECT_TIMEOUT_S = 30
        bridge.MAX_SESSIONS = 20
        bridge.IDLE_TIMEOUT_S = 60
        bridge.MAX_SESSION_S = 3600
        bridge.WATCH_INTERVAL_S = 0.1
        bridge.UPSTREAM_HANDSHAKE_TIMEOUT_S = 10
        bridge.NEGOTIATE_TIMEOUT_S = 14
        bridge.PROBE_TIMEOUT_S = 14
        bridge.PROBE_WAIT_S = 1.5
        bridge.CLEANUP_TIMEOUT_S = 10
        bridge.WS_CLOSE_TIMEOUT_S = 5.0
        bridge.HTTP_CLOSE_TIMEOUT_S = 5.0
        bridge.PEER_CLOSE_TIMEOUT_S = 5.0
        bridge.PEER_RECLAIM_TIMEOUT_S = 5.0
        bridge.MAX_PEER_CLEANUPS = 20
        bridge.ACTIVE_SESSIONS.clear()
        bridge.PEER_CLEANUPS.clear()
        bridge.ABANDONED_PEERS.clear()
        original = bridge.build_rtc_configuration
        bridge.build_rtc_configuration = host_only
        self.addCleanup(setattr, bridge, "build_rtc_configuration", original)
        bridge.active_probes = 0
        self.gateway = FakeGateway()
        await self.gateway.start()
        self.bridge = BridgeServer()
        await self.bridge.start()
        self.http = aiohttp.ClientSession()

    async def asyncTearDown(self):
        await self.http.close()
        await self.bridge.stop()
        await self.gateway.stop()

    async def offer(self, audio=True):
        """A client peer like the browser's, with its offer after ICE gathering. Without `audio`
        it negotiates an audio stream but never sends any."""
        peer = RTCPeerConnection(host_only())
        channel = peer.createDataChannel("oai-events")
        if audio:
            peer.addTrack(AudioStreamTrack())
        else:
            peer.addTransceiver("audio", direction="sendonly")
        await peer.setLocalDescription(await peer.createOffer())
        return peer, channel, peer.localDescription.sdp

    async def connect(self, model=MODEL, audio=True, key=GATEWAY_KEY):
        """A connected session: the peer, its channel and the events it receives."""
        peer, channel, sdp = await self.offer(audio)
        events = []
        channel.on("message", lambda message: events.append(json.loads(message)))
        async with self.http.post(
            f"{self.bridge.url}/realtime",
            data=sdp,
            headers=gateway_headers(self.gateway.base, model=model, key=key),
        ) as response:
            self.assertEqual(response.status, 200)
            answer = await response.text()
        await peer.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
        await wait_for(lambda: peer.connectionState == "connected")
        await wait_for(lambda: channel.readyState == "open")
        return peer, channel, events

    async def test_streams_deltas_and_completes_on_commit(self):
        peer, channel, sdp = await self.offer()
        events = []
        channel.on("message", lambda message: events.append(json.loads(message)))
        async with self.http.post(
            f"{self.bridge.url}/realtime",
            data=sdp,
            headers={"Content-Type": "application/sdp", **gateway_headers(self.gateway.base)},
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.content_type, "application/sdp")
            answer = await response.text()
        await peer.setRemoteDescription(RTCSessionDescription(sdp=answer, type="answer"))
        await wait_for(lambda: peer.connectionState == "connected")
        await wait_for(lambda: channel.readyState == "open")
        # Deltas arrive while the audio flows.
        await wait_for(
            lambda: any(e["type"].endswith(".delta") for e in events), timeout=15
        )
        channel.send(json.dumps({"type": "input_audio_buffer.commit"}))
        await wait_for(lambda: any(e["type"].endswith(".completed") for e in events), timeout=15)
        await peer.close()

        types = [event["type"] for event in events]
        self.assertEqual(types[0], "input_audio_buffer.committed")
        item = events[0]["item_id"]
        self.assertTrue(all(event["item_id"] == item for event in events))
        completed = next(e for e in events if e["type"].endswith(".completed"))
        streamed = "".join(e["delta"] for e in events if e["type"].endswith(".delta"))
        self.assertEqual(completed["transcript"], streamed)
        connection = self.gateway.connections[0]
        self.assertEqual(connection["model"], MODEL)
        self.assertEqual(connection["session_model"], MODEL)
        self.assertEqual(connection["events"][0], "session.update")
        self.assertIn("input_audio_buffer.commit", connection["events"])
        # The bridge closes its upstream stream after finalising.
        await wait_for(lambda: self.gateway.closed == 1)

    async def test_refused_model_answers_with_the_gateway_status(self):
        peer, _channel, sdp = await self.offer()
        async with self.http.post(
            f"{self.bridge.url}/realtime",
            data=sdp,
            headers=gateway_headers(self.gateway.base, model="denied"),
        ) as response:
            self.assertEqual(response.status, 502)
            body = await response.json()
        await peer.close()
        self.assertEqual(body["error"], "upstream_rejected")
        self.assertEqual(body["upstream_status"], 403)
        self.assertEqual(body["model"], "denied")
        self.assertNotIn(GATEWAY_KEY, json.dumps(body))

    async def test_wrong_gateway_key_is_refused_too(self):
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers(self.gateway.base, key="wrong")
        ) as response:
            self.assertEqual(response.status, 502)
            self.assertEqual((await response.json())["upstream_status"], 403)

    async def test_probe(self):
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers(self.gateway.base)
        ) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(await response.json(), {"ok": True, "model": MODEL})
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers(self.gateway.base, model="unknown")
        ) as response:
            self.assertEqual(response.status, 502)
            body = await response.json()
            self.assertEqual(body["error"], "upstream_error")
            # Campus (D-1): fixed words, never the gateway's.
            self.assertEqual(body["message"], "the gateway refused the realtime session")
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers("http://127.0.0.1:9")
        ) as response:
            self.assertEqual(response.status, 502)
            self.assertEqual((await response.json())["error"], "upstream_failed")
        await wait_for(lambda: self.gateway.closed == 2)
        # The probe sends no audio.
        self.assertTrue(all(c["bytes"] == 0 for c in self.gateway.connections))

    async def test_unusable_offer_is_the_clients_fault(self):
        async with self.http.post(
            f"{self.bridge.url}/realtime",
            data=UNUSABLE_OFFER,
            headers=gateway_headers(self.gateway.base),
        ) as response:
            self.assertEqual(response.status, 400)
            self.assertEqual((await response.json())["error"], "bad_offer")
        # Its upstream stream is closed at once.
        await wait_for(lambda: self.gateway.closed == 1)

    def spellings(self, key):
        """Every way a log or answer could carry `key` or give it away (D-1)."""
        return [
            key,
            quote(key),
            quote(key, safe=""),
            json.dumps(key)[1:-1],
            repr(key)[1:-1],
            repr(f"x {key}")[1:-1],
            key[:8],
            key[-8:],
        ]

    def assert_no_trace_of(self, key, text):
        for spelling in self.spellings(key):
            self.assertNotIn(spelling, text)

    async def test_upstream_errors_never_carry_the_key(self):
        """Campus (D-1): no word of the gateway reaches a log or an answer, in whatever spelling
        it reflects the key; the log gets fixed events, lengths and hashes."""
        for key in (GATEWAY_KEY, ODD_KEY):
            for model in ("reflect", "reflect-encoded", "reflect-code", "reflect-garbage"):
                with self.subTest(key=key, model=model):
                    with self.assertLogs(level="DEBUG") as logs:
                        peer, _channel, events = await self.connect(model=model, key=key)
                        if model == "reflect-garbage":
                            await wait_for(
                                lambda: any("JSONDecodeError" in line for line in logs.output)
                            )
                        else:
                            await wait_for(
                                lambda: any(e["type"].endswith(".failed") for e in events)
                            )
                        async with self.http.post(
                            f"{self.bridge.url}/probe",
                            headers=gateway_headers(self.gateway.base, model, key),
                        ) as response:
                            body = await response.text()
                        await peer.close()
                        await wait_for(lambda: not bridge.ACTIVE_SESSIONS, timeout=15)
                    log = "\n".join(logs.output)
                    for text in (log, body, json.dumps(events)):
                        self.assert_no_trace_of(key, text)
                        for word in ("Rejected", "invalid_key", "invalid_credential", "is invalid"):
                            self.assertNotIn(word, text)
                    if model != "reflect-garbage":
                        self.assertIn("bytes, hash", log)
                        failed = next(e for e in events if e["type"].endswith(".failed"))
                        self.assertEqual(failed["error"], bridge.CLIENT_UPSTREAM_ERROR)
                        self.assertEqual(json.loads(body)["error"], "upstream_error")

    async def test_a_close_reason_never_reaches_log_or_answer(self):
        for key in (GATEWAY_KEY, ODD_KEY):
            with self.assertLogs(level="DEBUG") as logs:
                async with self.http.post(
                    f"{self.bridge.url}/probe",
                    headers=gateway_headers(self.gateway.base, "reflect-close", key),
                ) as response:
                    self.assertEqual(response.status, 502)
                    body = await response.json()
            self.assertEqual(body["error"], "upstream_closed")
            self.assertEqual(body["message"], "the gateway closed the realtime connection")
            self.assertEqual(body["upstream_close_code"], 4001)
            log = "\n".join(logs.output)
            self.assertIn("code 4001", log)
            for text in (log, json.dumps(body)):
                self.assert_no_trace_of(key, text)
                self.assertNotIn("Rejected", text)

    def test_trace_and_failure_text_carry_no_upstream_words(self):
        message = f"Rejected credential {quote(ODD_KEY, safe='')} ({ODD_KEY!r})"
        traced = bridge.trace(message)
        self.assertRegex(traced, r"^\d+ bytes, hash [0-9a-f]{12}$")
        self.assertEqual(traced, bridge.trace(message.encode()))
        self.assertNotEqual(traced, bridge.trace(message + " "))
        self.assert_no_trace_of(ODD_KEY, traced)
        self.assertEqual(bridge.trace(None), bridge.trace(""))
        self.assertEqual(bridge.failure_text(RuntimeError(message)), "RuntimeError")
        self.assertEqual(
            bridge.failure_text(bridge.UpstreamRejected(403)),
            "the gateway refused the realtime connection with status 403",
        )

    def test_mask(self):
        self.assertEqual(
            bridge.mask(
                "key secret-key-1 Bearer abc.def sk-abcdef123 api_key=xyz1", "secret-key-1"
            ),
            "key *** Bearer *** sk-*** api_key=***",
        )
        self.assertEqual(len(bridge.mask("x" * 1000)), 300)
        # Campus (C-1): a secret is masked however short, longer ones first, before the cut.
        self.assertEqual(bridge.mask("refused gk7 here", "gk7"), "refused *** here")
        self.assertEqual(
            bridge.mask("refused prefix-key-new-secret", "prefix-key", "prefix-key-new-secret"),
            "refused ***",
        )
        secret = "opaque-gateway-credential-0123456789"
        self.assertEqual(bridge.mask("x" * 290 + secret, secret), "x" * 290 + "***")
        self.assertNotIn("odd", bridge.mask(json.dumps({"m": 'gw"odd'}), 'gw"odd'))

    async def stalled(self):
        gateway = StalledGateway()
        await gateway.start()
        self.addAsyncCleanup(gateway.stop)
        return gateway

    async def test_stalled_upgrade_frees_the_slot(self):
        """Campus (C-2): a gateway that takes the connection but never answers the upgrade."""
        bridge.MAX_SESSIONS = 1
        bridge.UPSTREAM_HANDSHAKE_TIMEOUT_S = 0.3
        stalled = await self.stalled()
        peer, _channel, sdp = await self.offer()
        loop = asyncio.get_running_loop()
        started = loop.time()
        async with self.http.post(
            f"{self.bridge.url}/realtime", data=sdp, headers=gateway_headers(stalled.base)
        ) as response:
            self.assertEqual(response.status, 504)
            body = await response.json()
        await peer.close()
        self.assertLess(loop.time() - started, 3)
        self.assertEqual(body["error"], "upstream_failed")
        self.assertIn("handshake", body["message"])
        self.assertFalse(bridge.ACTIVE_SESSIONS)
        self.assertTrue(stalled.writers)
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers(stalled.base)
        ) as response:
            self.assertEqual(response.status, 504)
            self.assertEqual((await response.json())["error"], "upstream_failed")
        self.assertEqual(bridge.active_probes, 0)
        # The slot is free for a healthy gateway.
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers(self.gateway.base)
        ) as response:
            self.assertEqual(response.status, 200)

    async def test_negotiation_and_probe_have_deadlines_of_their_own(self):
        bridge.MAX_SESSIONS = 1
        bridge.NEGOTIATE_TIMEOUT_S = 0.3
        bridge.PROBE_TIMEOUT_S = 0.3
        stalled = await self.stalled()
        peer, _channel, sdp = await self.offer()
        async with self.http.post(
            f"{self.bridge.url}/realtime", data=sdp, headers=gateway_headers(stalled.base)
        ) as response:
            self.assertEqual(response.status, 504)
            self.assertIn("negotiation", (await response.json())["message"])
        await peer.close()
        self.assertFalse(bridge.ACTIVE_SESSIONS)
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers(stalled.base)
        ) as response:
            self.assertEqual(response.status, 504)
            self.assertIn("probe", (await response.json())["message"])
        self.assertEqual(bridge.active_probes, 0)

    def slow_streams(self, block_send=True, close_s=2.0):
        """Campus (D-3): gateway streams whose session.update never goes out (`block_send`) and
        whose close takes `close_s`, in place of connect_upstream_ws."""
        streams = []

        class SlowStream:
            def __init__(self):
                self.closed = False
                self.close_started = False

            async def send_json(self, _event):
                if block_send:
                    await asyncio.Event().wait()

            async def receive(self, timeout=None):
                await asyncio.sleep(timeout or 0)
                raise asyncio.TimeoutError

            async def close(self):
                self.close_started = True
                await asyncio.sleep(close_s)
                self.closed = True

        async def connect(_http, _url, _key):
            stream = SlowStream()
            streams.append(stream)
            return stream

        original = bridge.connect_upstream_ws
        bridge.connect_upstream_ws = connect
        self.addCleanup(setattr, bridge, "connect_upstream_ws", original)
        return streams

    async def timed_post(self, path, **kwargs):
        loop = asyncio.get_running_loop()
        started = loop.time()
        async with self.http.post(f"{self.bridge.url}{path}", **kwargs) as response:
            body = await response.json() if response.content_type.endswith("json") else None
            return response.status, body, loop.time() - started

    async def test_a_slow_cleanup_does_not_delay_the_answer(self):
        """Campus (D-3): the deadline passes during session.update and closing the stream takes
        two seconds; the 504 comes at the deadline, the slot is free at once, and the stream is
        closed afterwards."""
        bridge.MAX_SESSIONS = 1
        bridge.NEGOTIATE_TIMEOUT_S = 0.3
        bridge.PROBE_TIMEOUT_S = 0.3
        streams = self.slow_streams()
        peer, _channel, sdp = await self.offer()
        status, body, elapsed = await self.timed_post(
            "/realtime", data=sdp, headers=gateway_headers(self.gateway.base)
        )
        await peer.close()
        self.assertEqual(status, 504)
        self.assertIn("negotiation", body["message"])
        self.assertLess(elapsed, 1.2)
        self.assertFalse(bridge.ACTIVE_SESSIONS)
        status, body, elapsed = await self.timed_post(
            "/probe", headers=gateway_headers(self.gateway.base)
        )
        self.assertEqual(status, 504)
        self.assertIn("probe", body["message"])
        self.assertLess(elapsed, 1.2)
        self.assertEqual(bridge.active_probes, 0)
        # Both streams close after their answers.
        self.assertEqual(len(streams), 2)
        await wait_for(lambda: all(stream.closed for stream in streams), timeout=5)
        await wait_for(lambda: not bridge.BACKGROUND_TASKS, timeout=5)

    async def test_a_slow_cleanup_after_a_stalled_handshake_does_not_delay_the_answer(self):
        bridge.UPSTREAM_HANDSHAKE_TIMEOUT_S = 0.3
        streams = self.slow_streams()
        peer, _channel, sdp = await self.offer()
        status, body, elapsed = await self.timed_post(
            "/realtime", data=sdp, headers=gateway_headers(self.gateway.base)
        )
        await peer.close()
        self.assertEqual(status, 504)
        self.assertIn("handshake", body["message"])
        self.assertLess(elapsed, 1.2)
        self.assertFalse(bridge.ACTIVE_SESSIONS)
        await wait_for(lambda: streams[0].closed, timeout=5)

    async def test_a_slow_close_does_not_delay_a_probe_that_passed(self):
        bridge.PROBE_WAIT_S = 0.1
        streams = self.slow_streams(block_send=False)
        status, body, elapsed = await self.timed_post(
            "/probe", headers=gateway_headers(self.gateway.base)
        )
        self.assertEqual((status, body), (200, {"ok": True, "model": MODEL}))
        self.assertLess(elapsed, 1.2)
        self.assertTrue(streams[0].close_started)
        await wait_for(lambda: streams[0].closed, timeout=5)

    async def test_cleanup_has_a_deadline_of_its_own(self):
        bridge.CLEANUP_TIMEOUT_S = 0.2
        with self.assertLogs(level="WARNING") as logs:
            task = bridge.in_background(asyncio.Event().wait(), "closing a test stream")
            await task
        self.assertIn("closing a test stream did not finish within 0.2s", "\n".join(logs.output))

    def record_sessions(self):
        """Campus (E-2): every BridgeSession the routes create, also once they left
        ACTIVE_SESSIONS."""
        sessions = []
        original = bridge.BridgeSession

        class Recorded(original):
            def __init__(self, *args):
                super().__init__(*args)
                sessions.append(self)

        bridge.BridgeSession = Recorded
        self.addCleanup(setattr, bridge, "BridgeSession", original)
        return sessions

    def assert_released(self, session, stream=None):
        """The session's HTTP session, peer connection and upstream connection are closed: the
        gateway's side of the stream has lost its connection."""
        self.assertTrue(session.http.closed)
        self.assertEqual(session.pc.connectionState, "closed")
        self.assertEqual(session.pc.signalingState, "closed")
        if stream is not None:
            self.assertTrue(stream["transport"].is_closing())

    def slow_closing_streams(self):
        """Campus (E-2): real gateway streams whose graceful close never ends."""
        original = bridge.start_stream

        async def start(*args):
            ws = await original(*args)

            async def close(**_kwargs):
                await asyncio.sleep(30)

            ws.close = close
            return ws

        bridge.start_stream = start
        self.addCleanup(setattr, bridge, "start_stream", original)

    async def test_a_cleanup_deadline_still_releases_the_session(self):
        """Campus (E-2): the review's case, scaled: the cleanup deadline (50 ms) passes while the
        stream's graceful close (500 ms budget) does not end. The answer comes at once, the slot
        is free, and after the deadline the stream's connection is dropped and the HTTP session
        and the peer connection are closed all the same; another close waits for that release."""
        bridge.MAX_SESSIONS = 1
        bridge.CLEANUP_TIMEOUT_S = 0.05
        bridge.WS_CLOSE_TIMEOUT_S = 0.5
        sessions = self.record_sessions()
        self.slow_closing_streams()
        with self.assertLogs(level="WARNING") as logs:
            status, body, elapsed = await self.timed_post(
                "/realtime", data=UNUSABLE_OFFER, headers=gateway_headers(self.gateway.base)
            )
            self.assertEqual((status, body["error"]), (400, "bad_offer"))
            self.assertLess(elapsed, 1.2)
            self.assertFalse(bridge.ACTIVE_SESSIONS)
            [session] = sessions
            await wait_for(lambda: "did not finish within 0.05s" in "\n".join(logs.output))
        # The deadline has passed; the release has not given up.
        self.assertFalse(session.http.closed)
        self.assertTrue(bridge.BACKGROUND_TASKS)
        await wait_for(lambda: not bridge.BACKGROUND_TASKS, timeout=5)
        [stream] = self.gateway.connections
        self.assert_released(session, stream)
        await asyncio.wait_for(session.close(), 1)

    async def test_a_cancelled_stream_close_drops_the_connection(self):
        """Campus (E-2): a stream closed by a cleanup that runs out of time loses its connection
        at the deadline, as a probe's does, and its HTTP session is closed too."""
        bridge.CLEANUP_TIMEOUT_S = 0.05
        bridge.WS_CLOSE_TIMEOUT_S = 5.0
        http = aiohttp.ClientSession()
        ws = await bridge.start_stream(
            http, bridge.realtime_url(self.gateway.base, "silent-close"), GATEWAY_KEY, "x"
        )
        await wait_for(lambda: self.gateway.connections)
        loop = asyncio.get_running_loop()
        started = loop.time()
        with self.assertLogs(level="WARNING"):
            await bridge.in_background(bridge.close_probe(ws, http), "closing a test probe")
        self.assertLess(loop.time() - started, 1)
        self.assertTrue(http.closed)
        await wait_for(lambda: self.gateway.connections[0]["transport"].is_closing(), timeout=2)

    async def test_a_failing_close_still_releases_the_rest(self):
        """Campus (E-2): whichever resource fails to close, the others are closed."""
        for failing in ("upstream", "http", "pc"):
            with self.subTest(failing=failing):
                self.gateway.connections.clear()
                session = bridge.BridgeSession(self.gateway.base, GATEWAY_KEY, MODEL)
                await session._connect_upstream()
                await wait_for(lambda: self.gateway.connections)
                [stream] = self.gateway.connections
                resource = getattr(session, failing)
                original = resource.close

                async def fail(*_args, **_kwargs):
                    raise RuntimeError("close failed")

                resource.close = fail
                with self.assertLogs(level="WARNING") if failing == "pc" else nullcontext():
                    await asyncio.wait_for(session.close(), 3)
                resource.close = original
                if failing == "pc":
                    self.assertTrue(session.http.closed)
                    self.assertTrue(stream["transport"].is_closing())
                    await session.pc.close()
                else:
                    if failing == "http":
                        await session.http.close()
                    await wait_for(lambda: stream["transport"].is_closing(), timeout=2)
                    self.assert_released(session, stream)

    async def stall_turn_send(self, pc):
        """Campus (F-1): the review's reproduction. The peer connection's sends go through an
        aioice TURN client (no socket, no server: `relay` stands in for its connection to the TURN
        server) whose channel bind for the remote address failed, so every further send waits
        for good on the waiter the failed bind left behind. Injected at the DTLS send boundary,
        and registered as a relayed candidate of the ICE connection, as aioice does for a TURN
        allocation."""

        class Relay:
            def __init__(self):
                self.aborted = False

            def sendto(self, _data, _addr=None):
                pass

            def abort(self):
                self.aborted = True

            close = abort

            def is_closing(self):
                return self.aborted

            def get_extra_info(self, _name, default=None):
                return default

        ice = pc.sctp.transport.transport
        connection = ice._connection
        relay = Relay()
        client = aioice_turn.TurnClientUdpProtocol(
            ("192.0.2.1", 3478), username="u", password="p", lifetime=600, channel_refresh_time=300
        )
        client.connection_made(relay)
        candidate = aioice_ice.StunProtocol(connection)
        candidate.connection_made(aioice_turn.TurnTransport(client))
        client.receiver = candidate
        connection._protocols.append(candidate)

        async def failed_bind(_channel, _addr):
            raise stun.TransactionTimeout()

        remote = ("192.0.2.2", 50000)
        client.channel_bind = failed_bind
        with self.assertRaises(stun.TransactionTimeout):
            await client.send_data(b"first", remote)
        self.assertEqual(client.peer_connect_waiters, {remote: []})
        ice._send = lambda data: client.send_data(data, remote)
        return client, relay, connection, remote

    async def test_a_peer_close_stalled_in_transport_io_is_reclaimed(self):
        """Campus (F-1): an established peer connection whose close stalls in a TURN send (the
        SCTP ABORT behind an orphaned channel-bind waiter). Until it is closed it counts against
        MAX_PEER_CLEANUPS, so no new session starts; after PEER_CLOSE_TIMEOUT_S its transports
        are stopped, aiortc's own close ends, every socket is released and no task remains."""
        bridge.MAX_PEER_CLEANUPS = 1
        bridge.PEER_CLOSE_TIMEOUT_S = 1.0
        bridge.PEER_RECLAIM_TIMEOUT_S = 3.0
        peer, _channel, _events = await self.connect()
        [session] = bridge.ACTIVE_SESSIONS
        pc = session.pc
        client, relay, connection, remote = await self.stall_turn_send(pc)
        sockets = [p.transport for p in connection._protocols if p.transport is not None]
        sockets = [s for s in sockets if not isinstance(s, aioice_turn.TurnTransport)]
        self.assertTrue(sockets)
        headers = gateway_headers(self.gateway.base)
        with self.assertLogs(level="INFO") as logs:
            closing = asyncio.ensure_future(session.close())
            await asyncio.sleep(0.5)
            # aiortc's close waits behind the orphaned waiter; the session's slot is free, the
            # peer connection holds the only cleanup place.
            self.assertTrue(client.peer_connect_waiters[remote])
            waiters = list(client.peer_connect_waiters[remote])
            self.assertEqual(pc.signalingState, "closed")
            self.assertNotEqual(pc.connectionState, "closed")
            self.assertFalse(bridge.ACTIVE_SESSIONS)
            [supervisor] = bridge.PEER_CLEANUPS
            health = await self.health()
            self.assertEqual((health["sessions"], health["peer_cleanups"]), (0, 1))
            status, body, _elapsed = await self.timed_post(
                "/realtime", data=UNUSABLE_OFFER, headers=headers
            )
            self.assertEqual((status, body["error"]), (503, "busy"))
            await asyncio.wait_for(closing, 2)
            await asyncio.wait_for(asyncio.shield(supervisor), 3)
        log = "\n".join(logs.output)
        self.assertIn("not closed within 1s, stopping its transports", log)
        self.assertIn("closed after its transports were stopped", log)
        self.assertIn("peer connections still closing", log)
        self.assertNotIn("giving it up", log)
        # The close ran to its end, with its `closed` future resolved, and released everything.
        self.assertEqual(pc.connectionState, "closed")
        await asyncio.wait_for(pc.close(), 1)
        self.assertTrue(all(waiter.done() for waiter in waiters))
        self.assertFalse(client.peer_connect_waiters)
        self.assertTrue(relay.aborted)
        self.assertTrue(all(socket.is_closing() for socket in sockets))
        self.assertFalse(connection._protocols)
        self.assertFalse(bridge.PEER_CLEANUPS)
        self.assertFalse(bridge.ABANDONED_PEERS)
        await wait_for(lambda: not bridge.BACKGROUND_TASKS, timeout=5)
        # The place is free: the next session is admitted.
        status, body, _elapsed = await self.timed_post(
            "/realtime", data=UNUSABLE_OFFER, headers=headers
        )
        self.assertEqual((status, body["error"]), (400, "bad_offer"))
        await wait_for(lambda: bridge.peer_cleanups() == 0)
        await peer.close()

    async def test_stalled_peer_closes_cannot_pile_up(self):
        """Campus (F-1): the review's accumulation, MAX_SESSIONS=1 with successive sessions whose
        peer close never ends, not even with its transports stopped. Only MAX_PEER_CLEANUPS of
        them are admitted; past every deadline the bridge keeps no task for them, but they count
        until their close ends."""
        bridge.MAX_SESSIONS = 1
        bridge.MAX_PEER_CLEANUPS = 2
        bridge.PEER_CLOSE_TIMEOUT_S = 0.1
        bridge.PEER_RECLAIM_TIMEOUT_S = 0.2
        blocker = asyncio.Event()

        class StuckPeer(RTCPeerConnection):
            async def close(self):
                await blocker.wait()
                await super().close()

        original = bridge.RTCPeerConnection
        bridge.RTCPeerConnection = StuckPeer
        self.addCleanup(setattr, bridge, "RTCPeerConnection", original)
        headers = gateway_headers(self.gateway.base)
        with self.assertLogs(level="WARNING") as logs:
            statuses = []
            for _ in range(5):
                status, _body, _elapsed = await self.timed_post(
                    "/realtime", data=UNUSABLE_OFFER, headers=headers
                )
                statuses.append(status)
            self.assertEqual(statuses, [400, 400, 503, 503, 503])
            await wait_for(lambda: "\n".join(logs.output).count("giving it up") == 2, timeout=5)
        await wait_for(lambda: not bridge.BACKGROUND_TASKS, timeout=5)
        self.assertFalse(bridge.ACTIVE_SESSIONS)
        self.assertFalse(bridge.PEER_CLEANUPS)
        self.assertEqual(len(bridge.ABANDONED_PEERS), 2)
        health = await self.health()
        self.assertEqual((health["peer_cleanups"], health["abandoned_peers"]), (2, 2))
        status, _body, _elapsed = await self.timed_post(
            "/realtime", data=UNUSABLE_OFFER, headers=headers
        )
        self.assertEqual(status, 503)
        # Once their closes end, the places are free again.
        blocker.set()
        await wait_for(lambda: not bridge.ABANDONED_PEERS, timeout=5)
        status, _body, _elapsed = await self.timed_post(
            "/realtime", data=UNUSABLE_OFFER, headers=headers
        )
        self.assertEqual(status, 400)
        await wait_for(lambda: bridge.peer_cleanups() == 0 and not bridge.BACKGROUND_TASKS)

    async def test_rotation_behind_a_stalled_open_ends_the_session(self):
        bridge.UPSTREAM_HANDSHAKE_TIMEOUT_S = 0.5
        peer, channel, events = await self.connect()
        await wait_for(lambda: any(e["type"] == "input_audio_buffer.committed" for e in events))
        self.gateway.stall_from = 1
        channel.send(json.dumps({"type": "input_audio_buffer.commit", "keep_open": True}))
        # The first item completes, the next one fails, and the session frees its slot.
        await wait_for(lambda: not bridge.ACTIVE_SESSIONS, timeout=10)
        await peer.close()
        self.assertTrue(any(e["type"].endswith(".completed") for e in events))
        self.assertTrue(any(e["type"].endswith(".failed") for e in events))

    async def test_sessions_are_limited_and_their_slots_freed(self):
        bridge.MAX_SESSIONS = 1
        bridge.CONNECT_TIMEOUT_S = 4
        # Both offers first: gathering takes a while, and the first must still be open.
        first, _channel, first_sdp = await self.offer()
        second, _channel, sdp = await self.offer()
        async with self.http.post(
            f"{self.bridge.url}/realtime",
            data=first_sdp,
            headers=gateway_headers(self.gateway.base),
        ) as response:
            self.assertEqual(response.status, 200)
        async with self.http.post(
            f"{self.bridge.url}/realtime", data=sdp, headers=gateway_headers(self.gateway.base)
        ) as response:
            self.assertEqual(response.status, 503)
            self.assertEqual((await response.json())["error"], "busy")
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers(self.gateway.base)
        ) as response:
            self.assertEqual(response.status, 503)
        # No second gateway stream was opened for the refused offer.
        self.assertEqual(len(self.gateway.connections), 1)
        # The unconnected first session expires and frees its slot.
        await wait_for(lambda: not bridge.ACTIVE_SESSIONS, timeout=10)
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers(self.gateway.base)
        ) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(bridge.active_probes, 0)
        # A failed negotiation frees its slot at once.
        async with self.http.post(
            f"{self.bridge.url}/realtime",
            data=sdp,
            headers=gateway_headers(self.gateway.base, model="denied"),
        ) as response:
            self.assertEqual(response.status, 502)
        self.assertFalse(bridge.ACTIVE_SESSIONS)
        await first.close()
        await second.close()

    async def test_connected_peer_without_audio_is_finalized(self):
        bridge.IDLE_TIMEOUT_S = 0.5
        peer, _channel, events = await self.connect(audio=False)
        await wait_for(lambda: self.gateway.closed == 1, timeout=10)
        await peer.close()
        errors = [e for e in events if e["type"] == "error"]
        self.assertEqual(errors[0]["error"]["code"], "session_idle")
        # The item is resolved for the client, and the slot is free.
        self.assertTrue(any(e["type"].endswith((".completed", ".failed")) for e in events))
        await wait_for(lambda: not bridge.ACTIVE_SESSIONS)

    async def test_connected_session_has_a_maximum_length(self):
        bridge.MAX_SESSION_S = 1.5
        peer, _channel, events = await self.connect()
        await wait_for(lambda: self.gateway.closed == 1, timeout=10)
        await peer.close()
        errors = [e for e in events if e["type"] == "error"]
        self.assertEqual(errors[0]["error"]["code"], "session_expired")
        self.assertTrue(any(e["type"].endswith(".completed") for e in events))

    async def test_commit_flood_is_coalesced(self):
        peer, channel, events = await self.connect()
        await wait_for(lambda: any(e["type"] == "input_audio_buffer.committed" for e in events))
        session = next(iter(bridge.ACTIVE_SESSIONS))
        for _ in range(200):
            channel.send(json.dumps({"type": "input_audio_buffer.commit", "keep_open": True}))
        await asyncio.sleep(0.5)
        # One rotation ran at once, one more waits; no task queue built up.
        self.assertEqual(len(self.gateway.connections), 2)
        self.assertLess(len(session.tasks), 10)
        await asyncio.sleep(1.5)
        # The waiting one ran a second later; the other 198 were folded into it.
        self.assertEqual(len(self.gateway.connections), 3)
        channel.send(json.dumps({"type": "input_audio_buffer.commit"}))
        await wait_for(lambda: not bridge.ACTIVE_SESSIONS, timeout=15)
        await peer.close()
        self.assertTrue(any(e["type"].endswith(".completed") for e in events))

    async def test_no_key_without_the_development_mode_refuses_everything(self):
        bridge.ALLOW_UNAUTHENTICATED = False
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers(self.gateway.base)
        ) as response:
            self.assertEqual(response.status, 401)

    def test_startup_needs_a_key_outside_loopback_development(self):
        self.assertIsNone(bridge.startup_problem("k" * 32, False, "0.0.0.0"))
        self.assertIn("BRIDGE_API_KEY", bridge.startup_problem("", False, "0.0.0.0"))
        self.assertIn("BRIDGE_API_KEY", bridge.startup_problem("", False, "127.0.0.1"))
        self.assertIn("loopback", bridge.startup_problem("", True, "0.0.0.0"))
        self.assertIsNone(bridge.startup_problem("", True, "127.0.0.1"))

    async def test_bridge_key_and_headers(self):
        bridge.BRIDGE_API_KEY = "bridge-secret"
        headers = gateway_headers(self.gateway.base)
        async with self.http.post(f"{self.bridge.url}/probe", headers=headers) as response:
            self.assertEqual(response.status, 401)
        async with self.http.post(
            f"{self.bridge.url}/probe",
            headers={**headers, "Authorization": "Bearer bridge-secret"},
        ) as response:
            self.assertEqual(response.status, 200)
        async with self.http.post(
            f"{self.bridge.url}/realtime",
            data="v=0\r\n",
            headers={"Authorization": "Bearer bridge-secret", "X-Model": MODEL},
        ) as response:
            self.assertEqual(response.status, 400)
        async with self.http.post(
            f"{self.bridge.url}/realtime",
            data="not sdp",
            headers={**headers, "Authorization": "Bearer bridge-secret"},
        ) as response:
            self.assertEqual(response.status, 400)
        health = await self.health()
        self.assertTrue(health["ok"])
        self.assertEqual((health["sessions"], health["peer_cleanups"]), (0, 0))

    async def health(self):
        async with self.http.get(f"{self.bridge.url}/health") as response:
            self.assertEqual(response.status, 200)
            return await response.json()

    async def test_unconnected_peer_is_closed_with_its_upstream(self):
        bridge.CONNECT_TIMEOUT_S = 0.5
        peer, _channel, sdp = await self.offer()
        async with self.http.post(
            f"{self.bridge.url}/realtime", data=sdp, headers=gateway_headers(self.gateway.base)
        ) as response:
            self.assertEqual(response.status, 200)
        # The answer is never applied: the client never connects.
        await wait_for(lambda: self.gateway.closed == 1, timeout=5)
        await peer.close()

    def test_turn_credential(self):
        username, password = bridge.turn_credential("secret", now=1_000)
        self.assertEqual(username, f"{1_000 + bridge.TURN_CREDENTIAL_SECONDS}:realtime-bridge")
        # HMAC-SHA1 of the user name with the secret, Base64 (coturn use-auth-secret).
        import base64
        import hashlib
        import hmac

        expected = base64.b64encode(
            hmac.new(b"secret", username.encode(), hashlib.sha1).digest()
        ).decode()
        self.assertEqual(password, expected)

    def test_realtime_url(self):
        self.assertEqual(
            bridge.realtime_url("https://api.example.org/", "m"),
            "wss://api.example.org/v1/realtime?model=m",
        )
        self.assertEqual(
            bridge.realtime_url("http://127.0.0.1:1", "m"), "ws://127.0.0.1:1/v1/realtime?model=m"
        )


if __name__ == "__main__":
    unittest.main()
