# Transcription mock

A local stand-in for every upstream of the transcription module, so the whole pipeline runs
in development and tests without real services or keys.

```sh
bun run mock:transcription                          # http://127.0.0.1:9200
TRANSCRIPTION_MOCK_PORT=9300 bun run mock:transcription
```

Point the module's admin form at it (`http` is accepted for `localhost` only):

| Setting                                  | Value                                                 |
| ---------------------------------------- | ----------------------------------------------------- |
| Speech endpoint (`asrBaseUrl`)           | `http://localhost:9200/asr/v1`, model `jlu/whisper-1` |
| Diarisation (`diarizationUrl`)           | `http://localhost:9200/diarization/diarize`           |
| Chat endpoint (`llmBaseUrl`)             | `http://localhost:9200/llm/v1`, model `mock-chat`     |
| On-prem signaling (`onpremSignalingUrl`) | `http://localhost:9200/realtime/onprem/signaling`     |
| OpenAI Realtime (`openaiRealtimeUrl`)    | `http://localhost:9200/realtime/openai/v1`            |

Any API key works. `GET /health` answers `{ "ok": true }`.

## Layout

`server.mjs` routes by prefix to one module each; a module exports
`handle(request, response, path)` and returns whether it answered. Routes a module has not
built yet answer `501`.

| File              | Prefix         | Endpoints                                                                                             |
| ----------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| `asr.mjs`         | `/asr`         | `GET /v1/models`, `POST /v1/audio/transcriptions`                                                     |
| `diarization.mjs` | `/diarization` | `POST /diarize`                                                                                       |
| `llm.mjs`         | `/llm`         | `GET /v1/models`, `POST /v1/chat/completions`                                                         |
| `realtime.mjs`    | `/realtime`    | `POST /onprem/signaling`, `POST /openai/v1/realtime/client_secrets`, `POST /openai/v1/realtime/calls` |

Live transcription answers with a real WebRTC peer (`realtime-peer.mjs`, on the root
devDependency `werift`): it takes the browser's audio and sends a fixed German script over the
`oai-events` data channel, one sentence per three seconds of audio, word by word as
`conversation.item.input_audio_transcription.delta` and then `…completed`. On-prem stop
(`input_audio_buffer.commit`) finishes the current sentence at once. Both live modes can so be
tried end to end in the browser. Offers the peer cannot negotiate are refused with 400; peers that
never connect close after 30 s. Only without `werift` installed does the mock fall back to a
signaling-only stub answer.

`http.mjs` holds the helpers they share. Tests can start the mock on a free port with
`startMock(0)` from `server.mjs`.
