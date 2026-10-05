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

GATEWAY_KEY = "test-gateway-key"
MODEL = "voxtral-mini-realtime"


class FakeGateway:
    """The gateway's `/v1/realtime`: 403 for a wrong key or a model the key may not use, an
    `error` event for an unknown model, else deltas while audio arrives and `transcription.done`
    on the final commit."""

    def __init__(self):
        self.connections = []
        self.closed = 0
        self.runner = None
        self.base = ""

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
        await self.runner.cleanup()

    async def realtime(self, request):
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
        bridge.CONNECT_TIMEOUT_S = 30
        self.gateway = FakeGateway()
        await self.gateway.start()
        self.bridge = BridgeServer()
        await self.bridge.start()
        self.http = aiohttp.ClientSession()

    async def asyncTearDown(self):
        await self.http.close()
        await self.bridge.stop()
        await self.gateway.stop()

    async def offer(self):
        """A client peer like the browser's, with its offer after ICE gathering."""
        peer = RTCPeerConnection()
        channel = peer.createDataChannel("oai-events")
        peer.addTrack(AudioStreamTrack())
        await peer.setLocalDescription(await peer.createOffer())
        return peer, channel, peer.localDescription.sdp

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
