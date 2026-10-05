# Realtime bridge

The on-prem path of live transcription: the browser sends its microphone over WebRTC to this
bridge, which streams it to the gateway's realtime WebSocket (vLLM's Voxtral behind the HRZ
LiteLLM gateway, `wss://api.hrz.uni-giessen.de/v1/realtime?model=voxtral-mini-realtime`) and
sends the transcript back over the `oai-events` data channel. A browser WebSocket cannot carry an
`Authorization` header, so without the bridge the gateway key would have to reach the browser.

Ported from HAWKI's realtime bridge (kiChat, `_docker/realtime-bridge`), with the same protocol.
The changes are marked `Campus:` in `bridge.py`: JSON errors that carry the gateway's status,
`POST /probe`, a timeout for peers that never connect, TURN credentials minted from coturn's
shared secret, and the outbound proxy for the WebSocket.

## How a session runs

1. The web app asks the Campus server for the session's ICE servers
   (`POST /api/modules/transcription/realtime/onprem/ice-servers`, short-lived TURN credentials)
   and sends its SDP offer to `POST …/realtime/onprem/signaling`.
2. The Campus server passes the offer to the bridge's `POST /realtime` as `application/sdp`, with
   `X-Gateway-Base` (the gateway without `/v1`), `X-Gateway-Key` (the speech recognition key),
   `X-Model` (the module's live model) and `Authorization: Bearer <BRIDGE_API_KEY>`, as kiChat's
   `RealtimeSignalingController` does. Neither the key nor the bridge's address reach the browser.
3. The bridge opens the gateway's WebSocket first (a refused key or model fails here, with the
   gateway's status), sends `session.update {model}`, then answers the offer with its SDP.
4. Audio is resampled to 16 kHz PCM16 and appended; after 300 ms the bridge starts decoding and
   sends `input_audio_buffer.committed`, then `conversation.item.input_audio_transcription.delta`
   while the gateway streams words.
5. On stop the web app sends `input_audio_buffer.commit`; the bridge ends the stream, sends
   `…completed` with the whole text (or `…failed`) and closes the connection half a second later.
   The web app waits for that, at most 20 s.

## API

| Request          | Body      | Answer                                                                   |
| ---------------- | --------- | ------------------------------------------------------------------------ |
| `POST /realtime` | SDP offer | `200 application/sdp` answer                                             |
| `POST /probe`    | –         | `200 {"ok": true}`: the gateway took key and model (no audio, no WebRTC) |
| `GET /health`    | –         | `200 ok`                                                                 |

Errors are JSON `{error, message, upstream_status?}`: `401 unauthorized` (bridge key),
`400 bad_request`/`bad_offer`, `502 upstream_rejected` (the gateway refused the handshake, with
its status: 403 for a model the key may not use), `upstream_error`/`upstream_closed` (refused
after the handshake), `upstream_failed` (unreachable). The Campus server turns them into the
reasons `modelNotAllowed`, `gatewayKeyRejected`, `gatewayRefused`, `gatewayUnreachable`,
`bridgeUnreachable` and `bridgeKeyRejected`, which the admin connection test and the live tab
show. A 401/403 handshake is told apart by the gateway's model list with the same key: if it
works and lacks the model, the key may not use the model.

## Settings

| Variable                         | Default           | Meaning                                                                   |
| -------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `PORT`, `HOST`                   | `8089`, `0.0.0.0` | Where the HTTP API listens. WebRTC media uses every interface.            |
| `BRIDGE_API_KEY`                 | –                 | Bearer the Campus server must send (`TRANSCRIPTION_REALTIME_BRIDGE_KEY`). |
| `TURN_URLS`                      | –                 | Comma-separated `turn:`/`turns:` URLs for the bridge's own ICE.           |
| `TURN_SECRET`                    | –                 | coturn's `static-auth-secret`: credentials are minted per session.        |
| `TURN_USERNAME`, `TURN_PASSWORD` | –                 | Static TURN credentials instead of `TURN_SECRET`.                         |
| `STUN_URLS`                      | –                 | Comma-separated STUN URLs.                                                |
| `HTTPS_PROXY`, `NO_PROXY`        | –                 | Outbound proxy for the gateway's WebSocket.                               |
| `CONNECT_TIMEOUT_S`              | `30`              | A peer not connected by then is closed with its gateway stream.           |
| `PROBE_WAIT_S`                   | `1.5`             | How long `/probe` waits for the gateway to refuse the model.              |
| `LOG_LEVEL`                      | `INFO`            |                                                                           |

Without `BRIDGE_API_KEY`, anyone who reaches the port can make the bridge connect to any
WebSocket (`X-Gateway-Base`): keep the port closed to the outside and set the key.

In the module's admin settings: offered modes with "Local (bridge)", the bridge address as the
Campus server reaches it (`http://localhost:8089` in development, `http://host.docker.internal:8089`
from the production app container), the gateway (empty: the speech recognition address), the
live model (`voxtral-mini-realtime`) and the ICE servers with TURN sign-in "short-lived". The
connection test "Test bridge" checks the bridge, then the gateway with key and model, then an
SDP offer.

## Running it

```sh
# Development: the Campus server runs on this machine and reaches the bridge on localhost.
docker compose --profile realtime up -d --build realtime-bridge
# A TURN relay to try the TURN path locally (TRANSCRIPTION_TURN_SECRET in .env):
docker compose --profile turn up -d coturn

# Production: COMPOSE_PROFILES=realtime in .env.production starts bridge and coturn.
docker compose -f docker-compose.prod.yml --env-file .env.production build realtime-bridge
docker compose -f docker-compose.prod.yml --env-file .env.production up -d

# Without Docker's NAT network (no internet for builds):
docker build --network host -t justcampus-realtime-bridge infra/realtime-bridge
```

Both services use host networking, as in kiChat: WebRTC media runs over UDP on ephemeral ports
and the ICE candidates must carry the host's addresses. Browsers that cannot reach the host
directly (firewalls, VPN) need the TURN relay on a port they can reach; the relay itself only
talks to the bridge on the same host (`TURN_ALLOWED_PEER_IP`).

## Tests

`test_bridge.py` runs the bridge against a fake gateway that speaks vLLM's realtime protocol, with
an aiortc client in the browser's role (audio track and `oai-events` channel): deltas while
speaking, the final transcript on commit, a refused model with the gateway's status, the probe,
the bridge key, unusable offers and peers that never connect.

```sh
docker run --rm --network host -v "$PWD/infra/realtime-bridge/test_bridge.py:/app/test_bridge.py:ro" \
  justcampus-realtime-bridge python -m unittest -v test_bridge
```

The local stand-in `infra/transcription-mock` emulates this API below `/realtime/bridge` for the
automated tests and offline development (bridge address `http://localhost:9200/realtime/bridge`).

## Licence

`bridge.py` derives from HAWKI's realtime bridge, which is published under the GNU General Public
License v3 (HAWKI's dual licence); this directory stays under the GPL v3
(<https://www.gnu.org/licenses/gpl-3.0.html>). It runs as a separate program in its own container.
