# JLU Campus – Architecture

JLU Campus is a customizable campus dashboard for Justus-Liebig-Universität
Gießen. Admins maintain a catalogue of **components**; every user picks which
components sit in their **sidebar** (each component opens as a full page).
A component's adapter type decides its page and the **widgets** it adds; users
place widgets as resizable tiles on their **dashboard**. Component adapters:
**IFrame** (embeds a site; widget `launcher`), **RSS** (shows a feed; widget
`feed`) and **Link** (a shortcut that opens its URL outside the app; widget
`shortcut`). Widgets are fixed in code per type (`COMPONENT_WIDGETS` in shared),
so a component has nothing to configure per widget. Further adapters (Stud.IP, …)
plug into the same registry and may add several widgets. Besides widgets, users
add their own tiles: folders, shortcuts to any URL, and RSS/Atom/JSON feeds.

There is one backend and two frontends that share one web build:

| Package           | Role                                                                            |
| ----------------- | ------------------------------------------------------------------------------- |
| `apps/server`     | Hono on Node. Better-Auth (Keycloak via OIDC), Drizzle ORM, Postgres, REST API. |
| `apps/web`        | Vite + React 19, TanStack Router + Query, JLU design system, i18n (de/en), PWA. |
| `apps/desktop`    | Electron (electron-vite). Bundles `apps/web/dist`, nothing else.                |
| `packages/shared` | Zod schemas, types, API paths. **The contract. Read it first.**                 |

Tooling: Bun workspaces (`bun install`), Prettier (`.prettierrc.yaml`: single
quotes, no semicolons, width 100), TypeScript strict. Node ≥ 22 at runtime.

## Local infrastructure

`docker compose up -d` starts:

- Postgres 16 on `127.0.0.1:5433` (db/user/password `justcampus`).
- MinIO (S3-compatible storage of the transcription module) with its API on
  `127.0.0.1:9100` and console on `http://localhost:9101` (`justcampus` /
  `justcampus-dev-secret`); `minio-init` creates the bucket `justcampus-transcription`
  and exits. MinIO allows the web origins (`http://localhost:5173`, `http://localhost:3000`,
  `app://-`) by CORS. The images are `pgsty/minio` and `pgsty/mc`, builds of MinIO's
  source, since MinIO publishes none any more.
- Keycloak 26 on `http://localhost:8080` (admin console: `admin` / `admin`),
  importing `infra/keycloak/justcampus-realm.json`: realm `justcampus`,
  confidential client `justcampus` (secret `justcampus-dev-secret`), realm roles
  `admin` and `user`, groups `/Studierende` and `/Beschaeftigte`, flat `roles`
  and full-path `groups` claims in the ID token, access token and userinfo,
  and two users: `alice` / `alice` (admin) and `bob` / `bob` (user).

`bun run mock:transcription` starts a stand-in for every upstream of the
transcription module on `127.0.0.1:9200` (`infra/transcription-mock`, see its README
for the admin settings that point at it). It needs no keys.

Copy `.env.example` to `.env` at the repo root. The server loads the root
`.env` (and an optional `apps/server/.env`) with `dotenv`; Vite reads
`VITE_*` variables from the root `.env` via `envDir`.

## Authentication

- Better-Auth on the server, mounted at `/api/auth/*`, Drizzle adapter, Postgres.
- Keycloak is connected with Better-Auth's **generic OAuth** plugin, provider id
  `keycloak` (`KEYCLOAK_PROVIDER_ID` in shared), discovery URL
  `${KEYCLOAK_ISSUER}/.well-known/openid-configuration`, scopes
  `openid profile email`, PKCE.
- The user table has an extra `role` column (`user` | `admin`) and a nullable
  `language` column (`de` | `en`). `role` is **derived from Keycloak on every
  sign-in**: if the `roles` claim contains `KEYCLOAK_ADMIN_ROLE` (default
  `admin`) the user is `admin`, otherwise `user`. Nothing in the app can change
  it. Use the plugin's option to refresh user info on sign-in so a role change
  in Keycloak applies at the next login.
- Sign-in from the client: Better-Auth 1.7 registers generic OAuth providers as
  core social providers, so the call is
  `authClient.signIn.social({ provider: 'keycloak', callbackURL })` and the
  server-side callback is `/api/auth/callback/keycloak`. The callback URL is
  the frontend's own URL (web origin or `app://-/`).
- Sign-out: `authClient.signOut()` resolves with `{ success, url?, redirect? }`.
  `url` is the Keycloak RP-initiated logout URL (`end_session_endpoint` from
  discovery, `post_logout_redirect_uri` = `WEB_ORIGIN` env, default
  `http://localhost:5173`). The web app navigates there; the desktop app only
  signs out locally.
- Cookies: the Electron renderer runs on `app://-`, which is cross-site to the
  API, so session cookies are `SameSite=None; Secure` by default (Chromium and
  Firefox accept Secure cookies from `http://localhost`). `CORS_ORIGINS` and
  Better-Auth `trustedOrigins` list every frontend origin including `app://-`.
  CORS allows credentials. Because the cookie goes along on cross-site
  requests and CORS does not stop simple ones (form posts, multipart,
  `text/plain`), every `/api/*` request other than GET/HEAD/OPTIONS that
  carries an `Origin` outside `CORS_ORIGINS` and the API's own origin answers
  `403 forbidden` (`src/origin.ts`).
- API authorization: every `/api/*` route except `/api/health` and `/api/auth/*`
  requires a session → `401 { error: { code: 'unauthorized' } }`. `/api/admin/*`
  requires `role === 'admin'` → `403 forbidden`.

## Data model (Drizzle, Postgres)

Better-Auth tables (`user`, `session`, `account`, `verification`) as generated
by the Better-Auth CLI, plus:

```
component         id uuid pk, name text, type text ('iframe' | 'rss' | 'link' | 'translator' |
                  'transcription' | 'files'),
                  icon text null, icon_url text null, config jsonb, enabled bool,
                  singleton bool default false, secrets jsonb default {}, sort_order int,
                  created_at, updated_at
translator_document id uuid pk, component_id → component (cascade), user_id → user (cascade),
                  filename text, size int, source text null, target text, formality text,
                  status text, seconds_remaining int null, error text null,
                  deepl_document_id text, deepl_document_key text (encrypted),
                  result bytea null, result_content_type text null,
                  poll_claimed_at timestamp null, polled_at timestamp null,
                  deleted_at timestamp null, created_at, updated_at, expires_at;
                  indexes (user_id, created_at), (status, expires_at), (expires_at)
transcription_job id uuid pk, component_id → component (cascade), user_id → user (cascade),
                  group_id uuid null, group_order int, filename text, mime_type text, size bigint,
                  duration double null, object_key text, normalized_key text null, status text,
                  settings jsonb, speakers jsonb, mapping jsonb, snippets jsonb, colors jsonb,
                  progress jsonb null, result jsonb null, error jsonb null, upstream_job_id text null,
                  transcript_id → transcription_transcript (set null) null, attempts int,
                  claimed_at, heartbeat_at, cancel_requested_at, uploaded_at, completed_at,
                  deleted_at timestamp null, created_at, updated_at, expires_at timestamp null;
                  indexes (user_id, created_at), (status, claimed_at), (expires_at), (transcript_id)
transcription_transcript id uuid pk, component_id → component (cascade), user_id → user (cascade),
                  idempotency_key uuid, title text, subtitle text null, subtitle_source text null,
                  language text null, duration double null, model text null, provider text null,
                  original_filename text null, file_size bigint null, segments jsonb, words jsonb,
                  text text, source_files jsonb, speaker_colors jsonb, summary_template_id text null,
                  revision int, user_locale text null, created_at, updated_at, expires_at null;
                  indexes (user_id, updated_at), (expires_at), unique (user_id, idempotency_key)
transcription_template id text pk (uuid text), component_id → component (cascade),
                  user_id → user (cascade) null, name text, description text, structure jsonb,
                  version int, output_format_hints text null, created_at, updated_at
transcription_format id uuid pk, component_id → component (cascade), user_id → user (cascade),
                  name text, speakers, timestamps, avatars, bubbles, anonymize bool, order text,
                  created_at, updated_at
transcription_summary id uuid pk, component_id → component (cascade), user_id → user (cascade),
                  transcript_id → transcription_transcript (cascade), kind text ('summary' |
                  'preview'), template_id text, template_version int, transcript_revision int,
                  model text null, settings_hash text, markdown text null, sections jsonb null,
                  generated_at, expires_at null; indexes (transcript_id, template_id, kind), (expires_at)
sidebar_entry     user_id → user (cascade), component_id → component (cascade),
                  position int; pk (user_id, component_id)
feed_read         user_id → user (cascade), feed_url text, read_at timestamp;
                  pk (user_id, feed_url)
dashboard_tile    id uuid pk (client generated), user_id → user (cascade),
                  kind text ('widget' | 'folder' | 'link' | 'feed'),
                  component_id → component (cascade) null, widget_key text null,
                  title text null, url text null (shortcut URL or feed URL), icon text null,
                  x, y, w, h int
dashboard_folder_item id uuid pk, tile_id → dashboard_tile (cascade),
                  kind text ('widget' | 'link'), component_id → component (cascade) null,
                  widget_key text null, title, url, icon text null (shortcuts), position int;
                  unique (tile_id, component_id, widget_key)
folder_template   id uuid pk, name text, icon text null, enabled bool, sort_order int,
                  created_at, updated_at
folder_template_item template_id → folder_template (cascade), component_id → component (cascade),
                  widget_key text, position int; pk (template_id, component_id, widget_key)
```

There is no widget table: a widget is `(component_id, widget_key)`, and the
server checks that the key belongs to the component's type
(`widgetDefinition` in shared), which also supplies the minimum tile size.
`PUT /api/sidebar` and `PUT /api/dashboard` replace the user's rows in one
transaction. Reads filter out disabled components and their widgets. Deleting a
component cascades.
Feed read state is per user and feed URL; the server keeps the latest read timestamp.
Folder templates list widgets and are copied into ordinary dashboard folders when added; there is no later sync.

`component` has a partial unique index on `type` where `singleton = true`.
Existing and ordinary components have `singleton = false`.

```
layout_preset     id uuid pk, name text, audience_kind text ('role' | 'group' | 'everyone'),
                  audience_name text null, sort_order int, sidebar jsonb (component ids),
                  dashboard jsonb (tiles as in dashboardPutSchema), created_at, updated_at;
                  at most one 'everyone' row
user              + keycloak_roles text[], keycloak_groups text[], layout_initialized_at timestamp null
```

Layout presets are the starting sidebar and dashboard admins define per
Keycloak realm role or group (full path, e.g. `/Studierende`), plus one
`everyone` fallback. Every sign-in stores the user's roles and groups. On the
first sign-in (`layout_initialized_at` null) the server takes the first
preset in `sort_order` whose role or group the user has, else the `everyone`
preset, and copies it once into the user's rows with fresh ids, dropping
widgets of disabled or deleted components. Presets are snapshots stored as
jsonb; later edits never reach existing users. Users who existed before
presets were introduced count as initialised.

## Modules (singleton components)

Modules are built-in component types listed in `SINGLETON_COMPONENT_TYPES`.
They remain ordinary `component` rows, so sidebars, widgets, folders and
presets keep referring to a component id. At startup the server inserts each
missing module at the end of the catalogue with its default name, icon and
config. New module rows are disabled. Admins may configure and enable them,
but cannot create, delete or change the type of one.

Each server module supplies its defaults, config schema and a Hono sub-app in
`apps/server/src/modules`. Its routes live below `/api/modules/<type>` and use
the normal session middleware. The module middleware only loads enabled
singleton rows. Missing or disabled modules answer `404 not_found`. A module
may add an admin sub-app below `/api/admin/modules/<type>`; it runs after the
admin check and also loads disabled rows, so admins can set a module up before
enabling it.

`component.secrets` maps secret names to AES-256-GCM ciphertexts. The server
uses `COMPONENT_SECRETS_KEY`, a base64-encoded 32-byte key. Each ciphertext has
a random 12-byte IV and authenticates `<component id>:<secret key>` as AAD.
Admin responses expose only a boolean per declared secret. A string replaces
a secret, `null` removes it, and an absent key leaves it unchanged.

A module may add tables whose rows reference `component.id`; use that foreign
key as the module instance and cascade deletes only if the module lifecycle
allows it. Translator documents reference their module's component row.

### Translator

The translator (`apps/server/src/modules/translator`) follows HAWKI's
translation service. It has two modes, translate and rephrase, and two kinds
of engines:

- **DeepL**, offered once the `deeplApiKey` secret is set. Translation uses
  `/v2/translate` (formality as `prefer_more` / `prefer_less`, so languages
  without the distinction are not an error), rephrasing uses DeepL Write
  (`/v2/write/rephrase`), which takes a writing style or a tone, not both.
  The API origin is `deeplApiUrl`, or picked from the key (`:fx` keys use
  `api-free.deepl.com`).
- **Models of an OpenAI-compatible endpoint** (`llmBaseUrl` up to `/v1`, the
  admin-listed `llmModels`, optional `llmApiKey`), engine id `llm:<model id>`.
  Requests go to `/chat/completions` with prompts ported from HAWKI and ask
  for a JSON answer, which the server parses leniently. The admin form fills
  `llmModels` from the endpoint's `GET /models` (through
  `POST /api/admin/modules/translator/models`, with the key typed in the form
  or the saved one): chat models in the endpoint's order, labelled by their
  `name` or id, without embedding, speech and image models. Display names the
  admin gave stay; the list is saved like any other config change.

`GET /api/modules/translator/engines` lists the offered engines and the
default (`defaultEngine`, else the first), plus whether documents are offered.
Text calls refuse redirects, time out after 60 s and are cancelled when the
client aborts. Texts only pass through the server.

Document translation needs `documentsEnabled` and a DeepL key. The signed-in
user can upload a supported file at `/documents`, list unexpired jobs, read or
soft-delete one at `/documents/:id`, and download its result at
`/documents/:id/download` once done. The original goes straight to DeepL;
`translator_document` stores metadata, an AES-256-GCM encrypted DeepL document
key bound to the row id, and the translated bytes. Each user may have three
active jobs and start 50 uploads per rolling 24 hours; deleted jobs count toward
the latter. Concurrent upload reservations are per Node process. Delete hides
the row and clears its result; expiry cleanup hard-deletes it. Running jobs
expire 24 hours after upload; completed jobs expire 24 hours after completion.
The worker checks active jobs every five seconds, four at a time, and never
overlaps ticks. GET of one active job also checks DeepL, at most once every two
seconds. A database claim makes the worker and GET share the one-time result
download safely. Result storage retries three times; a missing DeepL result,
or one over 50 MiB (checked by `Content-Length` and while streaming), ends
the job with `failed`. Unavailable documents answer 404 before the body limit.

Python code blocks of the AI editor run at `/execute-python`, as in HAWKI: each
run starts a fresh container of the sandbox image (`infra/python-sandbox`,
`bun run sandbox:build`) with `docker run --rm --network=none --read-only
--cap-drop=ALL`, 256 MB memory, one CPU, 64 processes, a 64 MB `/tmp` and the
code read-only at `/work/code.py`, as `sandboxuser`. The run ends after 10 s or
512 KiB of stdout or stderr; the container is then removed. `PYTHON_SANDBOX_*`
choose the CLI (Docker or Podman), the image and a runtime such as gVisor's
`runsc`; `infra/python-sandbox/runsc-rootless` runs gVisor under rootless Podman,
with the limits in a systemd user scope, and makes the container look as under
Docker (memory, CPUs, files, mounts, loopback).

HAWKI's throttle: translating, rewriting, detecting, suggestions, the AI editor,
Python runs and document uploads add to one count per user and minute
(`throttle.ts`). The first request opens the minute; text requests are refused
once it reaches 60, uploads once it reaches 10, with 429 `Too Many Attempts.`
and Laravel's `X-RateLimit-*` and `Retry-After` headers. Refused requests do
not count; runs at once are not limited.

### Transcription

The transcription module (`apps/server/src/modules/transcription`) ports kiChat's
transcription service; `docs/TRANSCRIPTION-REQUIREMENTS.md` is its checklist (T-01 to
T-63). Its contract is `packages/shared/src/transcription.ts` (re-exported by the shared
index): schemas, limits, the five built-in summary templates, the transcript presets and
`TRANSCRIPTION_API`, every route below `/api/modules/transcription` and the admin routes
below `/api/admin/modules/transcription`. Each area has its own router (`jobs/`,
`transcripts/`, `formats/`, `templates/`, `summaries/`, `optimize/`, `realtime/`,
`admin/`); `index.ts` mounts them and answers `GET /capabilities`, what the settings,
secrets and storage make available (`config.ts`). Routes not built yet answer
`501 not_implemented`.

The server runs the whole pipeline. Browsers upload each file straight to object storage
with a signed `PUT` for exactly its size and type (`storage.ts`, `@aws-sdk/client-s3`);
the server checks the stored bytes, then a worker normalises and chunks the audio with
`ffmpeg` (`TRANSCRIPTION_FFMPEG`, `TRANSCRIPTION_FFPROBE`, installed in the Docker image),
analyses the voices with the admin's HTTP diarisation endpoint, transcribes through an
OpenAI-compatible `POST /audio/transcriptions` (`verbose_json` with segments) and corrects
the text with an OpenAI-compatible chat endpoint, which also writes summaries, subtitles
and speaker optimisations. Diarised speakers get the name of the user's voice whose sample
windows overlap them most. Playback and samples use fresh signed `GET` URLs from
authenticated routes; signed URLs are never stored. The analysis also stores the waveform
(20 peaks per second) right after normalising, before diarisation, for files too large for
the browser to decode; the upload queue asks for it once the analysis ended, failed or not.
All of a job's objects lie below `transcription/<component>/jobs/<job>/`. Deleting a job
deletes that prefix and the row. The job sweep (`sweepJobs`) removes deleted, expired and
orphaned jobs the same way, but first claims each with one conditional `UPDATE` that sets
`deleted_at` (`claimJobsForCleanup`, skipping rows another transaction locks). Saving
(`SELECT … FOR UPDATE`), analysis, dispatch and worker writes only touch jobs neither deleted
nor expired, so a job is either saved or given a new expiry before the claim, and then not
claimed, or claimed, and then no longer saved or revived. A saved transcript's audio stays
until the transcript is deleted or its retention expires. A signed upload's URL is checked
only when its `PUT` starts, so a slow transfer may still store audio after that. The orphan
sweep (`jobs/orphans.ts`) therefore lists the storage itself: every minute one page of up to
1000 keys below `transcription/`, continuing after the last key, and deletes job objects
older than 15 minutes whose job row no longer exists. Objects of an existing row, even a
deleted or expired one, are left to the job sweep's claim. A purged row never returns, so
the sweep needs no assumed transfer time.
The number of files per transcript is limited only by the admin's optional setting (and a
generous anti-abuse bound in the contract), checked when the group is saved. Upstream calls (`http.ts`) refuse redirects,
time out and follow the caller's abort; failures answer `502 module_unavailable`.

Storage is configured by `TRANSCRIPTION_S3_*`: the endpoint the server uses, the public
endpoint signed URLs point at (browsers must reach it; it needs its own host name, since a
path prefix breaks the signatures), region, bucket, keys and path-style addressing. Without
a bucket the module offers no uploads. Saved transcripts stay until the user deletes them,
unless the admin sets `transcriptRetentionHours`; unsaved, failed and cancelled jobs and
their audio go after `unsavedJobRetentionHours` (24). Admin secrets: `apiKey` (speech),
`diarizationApiKey`, `llmApiKey` and `openaiRealtimeApiKey`. Live transcription runs over
WebRTC, either through the admin's on-prem bridge (the server forwards the SDP offer) or
OpenAI Realtime with ephemeral keys the server issues. `loadModuleRuntime`
(`modules/runtime.ts`) gives the worker and sweeps a module's config and decrypted secrets
outside a request.

The web adapter (`apps/web/src/adapters/transcription/`) keeps one folder per area
(`upload/`, `mapping/`, `result/`, `history/`, `segments/`, `export/`, `summary/`,
`templates/`, `recording/`, `live/`, `widgets/`). `page.tsx` switches the work area
between the entry choice, upload, recording, live transcription and a saved transcript,
and fills the `PageSidePanel` with the view's settings and the history; `workspace.tsx`
holds the state the areas share (`useTranscriptionWorkspace`), `api.ts` a typed function
and TanStack Query hook per endpoint plus the signed upload with progress, `audio/` the
waveform player. Texts live in `i18n/{de,en}/<area>.json`, merged into the app's resources
under `transcription`; kiChat's catalogue is kept verbatim. Widgets: `quick` and `recent`.
The shell renders a page in another tree below and above `lg` and drops it behind the narrow
layout's navigation tab, so the page keeps what must outlive a remount (view, upload queue,
recording and live session, takes) in `page-memory.ts`, one memory per component, disposed
once the address is no longer the page's.

Desktop components (`DESKTOP_COMPONENT_TYPES`, so far `files`) are built-in
rows too (`singleton = true`, same rules), created **enabled** with the name
and icon from `desktopComponentDefaults` and an empty config. They have no
server module: their page and everything it does live in the desktop app (see
[Desktop modules](DESKTOP-MODULES.md)).

To add a module, add its type, config, secrets and widgets to shared, implement
and register its server module, then add the web adapter. The typed server
registry fails type checking when a shared singleton type has no server entry.

## Feed proxy

Browsers cannot read most feeds (CORS), so `GET /api/feed?url=` (any signed-in
user) fetches and normalises them in `apps/server/src/feed.ts` with
`feedsmith`. Only `http(s)` URLs without credentials; every resolved address
must be public unicast (private, loopback, link-local, CGNAT, multicast,
documentation, IPv4-mapped/NAT64 ranges are refused) and the connection is
pinned to the checked address, so DNS rebinding cannot redirect it. At most 3
redirects (each re-checked), 5 s, 2 MB decompressed. Text is plain (tags
stripped, entities decoded), links must be `http(s)`, the body is decoded in
its declared charset. Results are cached in memory (10 min, failures 1 min,
500 entries). `FEED_ALLOW_PRIVATE_HOSTS=true` lifts the address check for
development and intranet feeds. Failures answer `502 feed_unavailable`.

## API

See `packages/shared/src/index.ts` (`API` object and schemas). JSON only.
Validation errors return `400` with `code: 'validation'` and Zod issues.
Responses are shaped exactly as the shared schemas describe (dates as ISO
strings).

## Web app

- Routes (TanStack Router, code-based like JLU Mail, **browser history**):
  `/login`, `/` (dashboard), `/c/$componentId` (component full page),
  `/admin/components`, `/admin/folders`, `/admin/presets` and
  `/admin/presets/$presetId` (admin only). Settings (language, colour scheme)
  are a `SettingsDialog` opened from the user menu, not a route.
  The preset editor reuses the user's dashboard grid and sidebar editor.
  The root route loads the session; unauthenticated users go to `/login`.
- Design system: `@ki4jlu/design-system` exactly like JLU Mail — tokens.css,
  Inter/Manrope from fontsource, `ThemeProvider`, `theme-init.js` in `<head>`
  (CSP-safe), ESLint plugin rules `no-hardcoded-colors` (error),
  `no-raw-ui-elements` (warn), `layout-only-classname` (warn). Frame:
  `AppShellLayout` with `Logo product="Campus"`, `NavItem`s for dashboard +
  the user's sidebar components. The column's footer holds "More apps" and the
  `SidebarUserMenu` (settings, admin, sign out, language). "More apps" is also
  the sidebar editor: its panel lists the components not in the sidebar with a
  search, as rows that open nothing, and while it is open the sidebar's links
  turn into sortable rows; components drag between the two or join and leave
  with the rows' buttons. The dashboard
  hides the shell's top bar; its edit actions sit above the grid.
- Dashboard: `react-grid-layout` (v2), 12 columns (`DASHBOARD_COLS`), row
  height `DASHBOARD_ROW_HEIGHT`, edit mode toggles drag/resize, "add widget"
  dialog lists the widgets of enabled components, tile header opens the
  component's page and removes the tile.
  Layout is saved with `PUT /api/dashboard` (debounced while editing).
- Adapter registry: `src/adapters/registry.ts` maps `ComponentType` →
  `{ Page, ConfigFields, defaultConfig, sourceUrl?, externalUrl?, feedUrl?, widgets }`,
  where `widgets` holds a `Tile` for every key the type has in
  `COMPONENT_WIDGETS`, and a `name` where a type offers several widgets (the add-widget
  dialog shows it after the component's name). Adapters with `externalUrl` (`link`) open outside the
  app from tiles, folders and the sidebar instead of navigating to
  `/c/$componentId`. Adapters with `feedUrl` (`rss`) get a dot in the sidebar
  while their feed has unread entries.
- Module adapters (`translator`) have no `sourceUrl`; the admin list marks
  them "Module" and offers no delete, and the component form neither offers
  module types for new components nor lets a module change its type. The
  translator page (`src/adapters/translator/`) switches between translating
  (`API.translate`), translating documents (`API.translatorDocuments`, only
  while the engine list says `documents`; a dropzone and the user's jobs,
  refetched every 3 s while one runs, downloads are plain links to
  `API.translatorDocumentDownload`) and rephrasing (`API.rephrase`), with settings for
  engine, formality, writing style and tone, live mode (runs after a pause in
  typing, not offered for DeepL) and "show changes" (a word diff against the
  submitted text or the previous translation). These settings stay in
  `localStorage`. The layout follows HAWKI: one card with the language bar,
  input and result side by side and the submit button. From `lg` up the
  modes and the settings of the chosen one sit in a collapsible, resizable
  column on the right of the shell (`PageSidePanel`: the page portals into a
  slot the frame shows only while a page fills it); below `lg` the modes are
  a segmented control above the card and the settings a card under it.
  Languages are named with `Intl.DisplayNames`; the `quick`
  tile translates with the default engine and always detects the source
  language. The component form renders one write-only
  `SecretField` per `COMPONENT_SECRETS[type]` entry (texts under
  `component.<type>.secrets.<key>`) and sends only changed secrets;
  `toComponentInput` never sends any.
- Shortcuts show the site's `/favicon.ico` unless the user picked a Lucide
  icon, falling back to a globe. Feeds are read through `GET /api/feed`.
  Opening an RSS page or pressing a feed tile's "mark as read" button marks
  the feed read (`PUT /api/feed/read`); showing a tile does not, except that
  a feed never read is marked on first display so later entries can be new.
- i18n: `i18next` + `react-i18next`, resources `src/i18n/de.json` and
  `en.json`. Language = user's saved language, else browser detector, else
  `de`. Changing it PATCHes `/api/me` and updates `<html lang>`.
- API access: `src/lib/api.ts` uses `window.justCampus?.apiUrl ??
import.meta.env.VITE_API_URL ?? ''` as base and `credentials: 'include'`.
- PWA: `vite-plugin-pwa` generates `manifest.webmanifest` (name "JLU Campus",
  short name "Campus", standalone, theme colour from tokens) and icons in
  `public/icons/` (192, 512, maskable, apple-touch) generated with `sharp`
  from `public/icon.svg`. Also emit a static `public/manifest.json` copy of
  the manifest as requested.

## Desktop app

- electron-vite builds `main` and `preload` only. `scripts/copy-web-build.mjs`
  copies `apps/web/dist` to `apps/desktop/out/renderer` before the build.
- Main registers the privileged scheme `app` and serves `out/renderer` from
  `app://-/` with an SPA fallback to `index.html`. In development it loads
  `http://localhost:5173` instead.
- Preload exposes `window.justCampus` (`DesktopBridge` from shared):
  `platform`, `os`, `apiUrl` (`JUSTCAMPUS_API_URL` env, else the build-time
  `DESKTOP_API_URL`, else `http://localhost:3000`), `openExternal`,
  `onNavigate`, `setLanguage` and `modules`, the desktop modules
  (`notifications`, `files`, `system`). Each module is a main-process part in
  `src/main/modules/` plus UI in the web build that stays dormant without the
  bridge; see [docs/DESKTOP-MODULES.md](DESKTOP-MODULES.md). Their local state
  is `desktop-settings.json` in `userData`.
- The app holds a single-instance lock and handles `jlucampus://` links
  (`protocols` in `electron-builder.yml`); closing the window keeps it in the
  tray unless the user turned that off.
- Sign-in navigates the main window to Keycloak and back; the server's final
  redirect targets `app://-/`. Main handles `will-redirect` / `will-navigate`
  to `app://` by loading the URL itself if Chromium does not follow it. Only
  main-frame redirects count: embedded sites redirect inside their iframe.
- CSP via `session.webRequest.onHeadersReceived`: `default-src 'self'`,
  `connect-src` and `media-src` the API origin plus `JUSTCAMPUS_CONNECT_ORIGINS` (runtime)
  or the build's `DESKTOP_CONNECT_ORIGINS`, by default the local MinIO and
  `https://api.openai.com` (transcription storage and OpenAI Realtime; `media-src` also
  `blob:` and `data:`), `frame-src https: http://localhost:*`,
  `img-src 'self' https: data:`, fonts and styles self/inline.
- Permissions (`src/main/media-permissions.ts`): the app's own main frame may use the
  microphone (audio only) and element fullscreen, for the transcription module's recording,
  live transcription and maximised live text; everything else, and every embedded site, is
  refused. macOS builds declare the microphone use (`build/entitlements.mac.plist`).
- Everything else (window state, external links → `shell.openExternal`,
  no Node in the renderer, context isolation) follows electron-vite defaults.
