# JLU Campus

A customizable campus dashboard for Justus-Liebig-Universität Gießen. Admins
maintain a catalogue of components (IFrame, RSS and Link adapters: name, icon,
URL) and configure built-in modules such as the translator. Each component is a
page in the sidebar and adds widgets, which users
place as resizable tiles on a free-grid dashboard. Available as a web app (installable PWA) and as
a desktop app for Windows, macOS and Linux that bundles the same web build.

| Package           | Stack                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| `apps/server`     | Hono on Node, Better-Auth (Keycloak via OIDC), Drizzle ORM, PostgreSQL   |
| `apps/web`        | React 19, Vite, TanStack Router + Query, JLU Design System, i18next, PWA |
| `apps/desktop`    | Electron (electron-vite, electron-builder); bundles `apps/web/dist`      |
| `packages/shared` | Zod schemas, types and API paths shared by all three                     |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Getting started

Requirements: [Bun](https://bun.sh) ≥ 1.3, Node ≥ 22, Docker (or Podman with
the compose plugin), `git`.

```bash
bun install                 # also builds the JLU design system from its git tag
cp .env.example .env        # defaults match docker-compose
bun run infra:up            # Postgres on :5433, Keycloak on :8080, MinIO on :9100/:9101
bun run db:migrate
bun run db:seed             # two example components
bun run sandbox:build       # image the translator editor's Python code blocks run in
bun run dev                 # API on http://localhost:3000, web on http://localhost:5173
```

The translator module needs a DeepL API key and/or an OpenAI-compatible
endpoint with at least one model; admins set both under Admin → Components.
Python code blocks in its editor run on the server, each in a fresh container
of that image without network (Docker or Podman, best under gVisor as in HAWKI;
without root `bun run sandbox:gvisor` sets it up for rootless Podman, see
`.env.example`).

The transcription module keeps audio in MinIO (`TRANSCRIPTION_S3_*` in
`.env.example`) and needs `ffmpeg` on the server. It uses the university's
services as kiChat does: speech recognition (`jlu/whisper-1`) and the chat
models (`jlu/qwen3.8-27b`, `jlu/qwen3.8-27b-fast`) of the HRZ gateway
`https://api.hrz.uni-giessen.de/v1`, which a fresh module is preset to, speaker
recognition on kiChat's Speaches server (pyannote, its own key) and, for live
transcription, the gateway's realtime WebSocket (`voxtral-mini-realtime`), which
the server relays: browsers stream to the app's own
`wss://…/api/modules/transcription/live`, so live transcription needs no port
besides HTTPS and no key reaches the browser. Under
Admin → Components → Transkription enter the API keys, press _Modelle abrufen_
for speech and chat, check each service with _Verbindung testen_ and enable the
module; [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#backends) lists every
setting. Behind an outbound proxy set `HTTPS_PROXY`, `NODE_USE_ENV_PROXY=1` and
`NO_PROXY` as `.env.example` shows. `bun run mock:transcription` stands in for
all of these in automated tests and offline development only
(`infra/transcription-mock/README.md`).

`COMPONENT_SECRETS_KEY` encrypts module secrets such as API keys. Generate a
production value with `openssl rand -base64 32`; changing it makes stored
secrets unreadable.

Sign in with one of the seeded Keycloak users:

| User    | Password | Role  |
| ------- | -------- | ----- |
| `alice` | `alice`  | admin |
| `bob`   | `bob`    | user  |

The Keycloak admin console is at http://localhost:8080 (`admin` / `admin`).
Users with the realm role `admin` (configurable via `KEYCLOAK_ADMIN_ROLE`) see
the admin panel at `/admin/components`.

## Desktop app

```bash
bun run build:desktop                  # builds apps/web, copies it into apps/desktop/out/renderer
bun run --filter @justcampus/desktop build:linux   # or build:win / build:mac
bun run dev:desktop                    # development: loads the web dev server
```

The desktop app talks to the API at `DESKTOP_API_URL` (build time) or
`JUSTCAMPUS_API_URL` (runtime environment variable).

## Production

`bun run build` builds the shared package, the server (`apps/server/dist`) and
the web app (`apps/web/dist`). Set `SERVE_WEB_DIR=../web/dist` (or an absolute
path) and the server serves the web app itself, so one origin hosts both. Run
migrations with `node apps/server/dist/migrate.js` before starting
`node apps/server/dist/index.js`.

### Docker

The `Dockerfile` packs the server and the web app into one image that runs
migrations on start and serves both from port 3000. Publishing a GitHub release,
or starting the **Docker** workflow by hand, pushes it to
`ghcr.io/ki4jlu/jlucampus` (`.github/workflows/docker.yml`). Releases are
tagged with their version and `latest`, manual runs with the branch name; every
image also gets `sha-<short>`.

`docker-compose.prod.yml` runs that image with Postgres and MinIO (the
transcription module's audio). Keycloak and the TLS-terminating reverse proxy
run outside it; the proxy also publishes MinIO on its own host name
(`TRANSCRIPTION_S3_PUBLIC_ENDPOINT`), since browsers upload to it directly. It
must pass WebSocket upgrades for `/api` (live transcription), with a read
timeout above a minute; for nginx:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

location /api/ {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection $connection_upgrade;
  proxy_set_header Host $host;
  proxy_read_timeout 300s;
}
```

```bash
cp .env.production.example .env.production   # fill in secrets and URLs
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

The app listens on `127.0.0.1:3000` by default (`APP_BIND`, `APP_PORT`). Pin
a release with `JUSTCAMPUS_TAG=1.2.3`. If the GHCR package is private, run
`docker login ghcr.io` on the host first.

## CI

GitHub Actions run lint, typecheck, tests and `bun run build` on every pull
request and every push to `master` (`.github/workflows/ci.yml`). Publishing a
GitHub release runs the same checks and build again (`release.yml`) and keeps
`web-<tag>` and `server-<tag>` as workflow artifacts for 90 days; `docker.yml`
pushes the production image (see [Docker](#docker)).

## Scripts

| Command               | Purpose                                      |
| --------------------- | -------------------------------------------- |
| `bun run dev`         | Server and web app in watch mode             |
| `bun run typecheck`   | TypeScript in every package                  |
| `bun run lint`        | ESLint, including the design-system rules    |
| `bun run test`        | Vitest in every package                      |
| `bun run db:generate` | Generate a Drizzle migration from the schema |
| `bun run format`      | Prettier                                     |
