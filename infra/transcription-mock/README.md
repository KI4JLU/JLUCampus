# Transcription mock

A local stand-in for every upstream of the transcription module, so the whole pipeline runs
in automated tests and offline development without real services or keys. The module itself
runs against the HRZ services (see the transcription part of `docs/ARCHITECTURE.md`); nothing
points at the mock by default.

```sh
bun run mock:transcription                          # http://127.0.0.1:9200
TRANSCRIPTION_MOCK_PORT=9300 bun run mock:transcription
```

For offline development, point the module's admin form at it (`http` is accepted for
`localhost` only):

| Setting                               | Value                                                 |
| ------------------------------------- | ----------------------------------------------------- |
| Speech endpoint (`asrBaseUrl`)        | `http://localhost:9200/asr/v1`, model `jlu/whisper-1` |
| Diarisation (`diarizationUrl`)        | `http://localhost:9200/diarization/v1`                |
| Chat endpoint (`llmBaseUrl`)          | `http://localhost:9200/llm/v1`, model `mock-chat`     |
| Live gateway (`onpremGatewayUrl`)     | `http://localhost:9200/realtime/v1`                   |
| OpenAI Realtime (`openaiRealtimeUrl`) | `http://localhost:9200/realtime/openai/v1`            |

Any API key works, except for diarisation with `TRANSCRIPTION_MOCK_DIARIZATION_KEY` set: then
another key gets `403`, as the Speaches server answers. The speech model `mock-gateway` answers
as the HRZ gateway does (no word times, the duration as a string); `mock-fail` fails. `GET /health`
answers `{ "ok": true }`.

## Layout

`server.mjs` routes by prefix to one module each; a module exports
`handle(request, response, path)` and returns whether it answered. Routes a module has not
built yet answer `501`.

| File              | Prefix         | Endpoints                                                                                                                                         |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asr.mjs`         | `/asr`         | `GET /v1/models`, `GET /v1/model/info`, `POST /v1/audio/transcriptions`                                                                           |
| `diarization.mjs` | `/diarization` | `POST /v1/audio/diarization`, `POST /v1/audio/speech/timestamps`                                                                                  |
| `llm.mjs`         | `/llm`         | `GET /v1/models`, `POST /v1/chat/completions`                                                                                                     |
| `realtime.mjs`    | `/realtime`    | WebSocket `/v1/realtime?model=…` (vLLM), WebSocket `/openai/v1/realtime?intent=transcription` (OpenAI), `GET /v1/models`, `GET /openai/v1/models` |

The realtime WebSockets speak what the Campus server's live relay talks to: vLLM's protocol as
the HRZ gateway serves Voxtral (`session.update {model}`, appends, `input_audio_buffer.commit
{final: false}` to start decoding, `{final: true}` to end the stream with `transcription.done`)
and OpenAI's transcription sessions (items as `input_audio_buffer.committed`, deltas and
`…completed`; a commit without audio since the last item answers
`input_audio_buffer_commit_empty`). Nothing is recognised: every three seconds of audio bring the
next sentence of a fixed German script, word by word as deltas. Both live modes can so be tried
end to end in the browser.

Any bearer works, unless `TRANSCRIPTION_MOCK_REALTIME_KEY` is set: then another one gets `401` at
the handshake and at the model list. A model whose id contains `denied` is refused with `403` at
the handshake and missing from the model list, as the HRZ gateway refuses a model the key may not
use, so the unavailable state can be tried offline; one with `refused` gets an `error` event and
a close after `session.update`; one with `leak` repeats the bearer in an `error` event, which the
server must not pass on.

`http.mjs` holds the helpers they share. Tests can start the mock on a free port with
`startMock(0)` from `server.mjs`.
