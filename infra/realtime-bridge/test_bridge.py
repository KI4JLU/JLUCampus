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

os.environ.setdefault("LOG_LEVEL", "WARNING")

import aiohttp  # noqa: E402
from aiohttp import web  # noqa: E402
from aiortc import RTCPeerConnection, RTCSessionDescription  # noqa: E402
from aiortc.mediastreams import AudioStreamTrack  # noqa: E402

import bridge  # noqa: E402

GATEWAY_KEY = "test-gateway-key-0123456789"
MODEL = "voxtral-mini-realtime"


class FakeGateway:
    """The gateway's `/v1/realtime`: 403 for a wrong key or a model the key may not use, an
    `error` event for an unknown model (`reflect`: one that repeats the key, as a careless gateway
    might), else deltas while audio arrives and `transcription.done` on the final commit."""

    def __init__(self):
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
        if request.headers.get("Authorization") != f"Bearer {GATEWAY_KEY}" or model == "denied":
            return web.Response(status=403)
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        # vLLM greets every connection before the model is validated.
        await ws.send_json({"type": "session.created", "id": "sess"})
        connection = {"model": model, "events": [], "bytes": 0}
        self.connections.append(connection)
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
                                "message": f"Key {GATEWAY_KEY} (Bearer {GATEWAY_KEY}) is invalid",
                            },
                        }
                    )
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
        bridge.ACTIVE_SESSIONS.clear()
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
        peer = RTCPeerConnection()
        channel = peer.createDataChannel("oai-events")
        if audio:
            peer.addTrack(AudioStreamTrack())
        else:
            peer.addTransceiver("audio", direction="sendonly")
        await peer.setLocalDescription(await peer.createOffer())
        return peer, channel, peer.localDescription.sdp

    async def connect(self, model=MODEL, audio=True):
        """A connected session: the peer, its channel and the events it receives."""
        peer, channel, sdp = await self.offer(audio)
        events = []
        channel.on("message", lambda message: events.append(json.loads(message)))
        async with self.http.post(
            f"{self.bridge.url}/realtime",
            data=sdp,
            headers=gateway_headers(self.gateway.base, model=model),
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
            self.assertEqual(body["message"], "Unknown model")
        async with self.http.post(
            f"{self.bridge.url}/probe", headers=gateway_headers("http://127.0.0.1:9")
        ) as response:
            self.assertEqual(response.status, 502)
            self.assertEqual((await response.json())["error"], "upstream_failed")
        await wait_for(lambda: self.gateway.closed == 2)
        # The probe sends no audio.
        self.assertTrue(all(c["bytes"] == 0 for c in self.gateway.connections))

    async def test_unusable_offer_is_the_clients_fault(self):
        offer = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 RTP/AVP 0\r\n"
        async with self.http.post(
            f"{self.bridge.url}/realtime", data=offer, headers=gateway_headers(self.gateway.base)
        ) as response:
            self.assertEqual(response.status, 400)
            self.assertEqual((await response.json())["error"], "bad_offer")
        # Its upstream stream is closed at once.
        await wait_for(lambda: self.gateway.closed == 1)

    async def test_upstream_errors_never_carry_the_key(self):
        with self.assertLogs(level="DEBUG") as logs:
            peer, _channel, events = await self.connect(model="reflect")
            await wait_for(lambda: any(e["type"].endswith(".failed") for e in events))
            async with self.http.post(
                f"{self.bridge.url}/probe", headers=gateway_headers(self.gateway.base, "reflect")
            ) as response:
                self.assertEqual(response.status, 502)
                body = await response.json()
            await peer.close()
        failed = next(e for e in events if e["type"].endswith(".failed"))
        # The client gets a fixed message, the log and the probe a masked one.
        self.assertEqual(failed["error"], bridge.CLIENT_UPSTREAM_ERROR)
        self.assertNotIn(GATEWAY_KEY, json.dumps(events))
        self.assertEqual(body["error"], "upstream_error")
        self.assertNotIn(GATEWAY_KEY, json.dumps(body))
        self.assertIn("***", body["message"])
        log = "\n".join(logs.output)
        self.assertIn("invalid_key", log)
        self.assertNotIn(GATEWAY_KEY, log)

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
        async with self.http.get(f"{self.bridge.url}/health") as response:
            self.assertEqual(await response.text(), "ok")

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
