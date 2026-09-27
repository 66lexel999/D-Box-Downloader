# D BOX

A self-contained, segmented download manager — single ~10 MB binary, zero
dependencies (Go stdlib only), embedded web UI.

Architecture derived from [maxuanquang/idm](https://github.com/maxuanquang/idm)
(handler → logic → dataaccess layering, task lifecycle) with its distributed
stack collapsed for a local single-user app:

| reference (maxuanquang/idm) | D BOX                              |
| --------------------------- | ---------------------------------- |
| MySQL + GORM                | atomic JSON store (`tasks.json`)   |
| Kafka producer/consumer     | in-process FIFO queue + scheduler  |
| Redis cache + JWT accounts  | none — binds to localhost          |
| MinIO object storage        | direct-to-disk (`*.part` → rename) |
| gRPC + grpc-gateway         | stdlib REST + SSE                  |
| React SPA                   | embedded single-file UI            |
| single-stream `io.Copy`     | multi-connection segmented engine  |

## Download

**[`release/DBox.exe`](release/DBox.exe)** — ready to run on Windows 10/11
(64-bit). Replace your existing `DBox.exe` with it (usually in
`%LOCALAPPDATA%\Programs\D BOX`) after quitting D BOX from its tray icon.
Windows may warn about an unsigned app: *More info → Run anyway*. The browser
extension is in [`extension/`](extension/) (load it unpacked).

This build's in-app auto-update is off, so it isn't replaced by an older
release. Rebuild it with:

```bash
GOOS=windows GOARCH=amd64 go build -trimpath -tags "desktop production" \
  -ldflags "-H windowsgui -X myidm/internal/version.Version=$(cat VERSION)" \
  -o release/DBox.exe ./cmd/myidm
```

## Features

- **Segmented downloads** — up to 32 parallel range connections per file,
  auto-sized (min 512 KB/segment)
- **Pause / resume** — segment offsets persist; resumes exactly where it
  stopped, validated with `If-Range` (ETag/Last-Modified) so a changed source
  fails loudly instead of corrupting the file
- **Crash recovery** — progress flushed every 2 s; interrupted tasks re-queue
  and continue on next launch
- **Fallbacks** — servers without range support get a single stream; chunked
  responses (unknown size) work too
- **Queue** — N tasks download at once (default 3), the rest wait
- **Global speed limit** — leaky-bucket across all connections (`-limit 2M`)
- **Per-connection retries** with exponential backoff, budget resets on progress
- **Live web UI** — per-segment progress bars, speed/ETA, SSE updates, pause /
  resume / cancel / open / show-in-folder
- **Streams (HLS / .m3u8)** — native downloader: picks the best quality, adds
  the separate audio track, decrypts AES-128, handles byte-range and fMP4
  playlists, downloads segments in parallel and resumes after a pause. Live
  streams are **recorded**; Pause stops and saves the recording. The result is
  rewrapped to MP4 with ffmpeg (a playable .ts/fMP4 is kept without it)
- **Web pages & DASH** — paste a page instead of a file and D BOX hands it to
  yt-dlp, which finds the video (with its real title and an estimated size);
  DASH (.mpd) manifests go the same way
- **Page crawler (JDownloader-style)** — for sites yt-dlp calls "Unsupported
  URL", D BOX searches the page itself: player iframes and "server" lists
  (followed two levels deep, each with the right Referer), inline player
  configs, P.A.C.K.E.R.-packed player scripts, and direct stream/file links —
  then downloads the first candidate that answers like media (streams and video
  before audio, so a page's ringtone never wins over its video)
- **Real names and sizes** — names come from Content-Disposition (including
  malformed / RFC 5987 / percent-encoded ones), pre-signed S3/GCS/Azure links
  (`response-content-disposition=`, `rscd=`), the original link when a CDN
  redirects to a hash, the page title, or the page the link came from; missing
  extensions come from the Content-Type or the file's magic bytes. Sizes a
  server hides are found via HEAD, and streams show an estimate (`~`)
- **Hotlink-protected files** — requests replay the page's Referer, cookies and
  headers (from the browser extension); when a server refuses anyway, the probe
  retries without a Range header and with same-site Referers
- **ffmpeg on demand** — the first video that needs merging or conversion
  fetches ffmpeg once (yt-dlp's static build, ~190 MB) into
  `%LOCALAPPDATA%\flowerX\tools`; without it yt-dlp picks single-file formats
  so a video is never saved without sound

## Build & run

```bash
go build -tags "desktop production" -ldflags "-H windowsgui" -o bin/DBox.exe ./cmd/myidm
bin/DBox.exe
```

Opens `http://127.0.0.1:8081`. Files land in `%USERPROFILE%\Downloads\flowerX`,
state in `%LOCALAPPDATA%\flowerX\tasks.json`.

```
-listen 127.0.0.1:8081   UI/API address
-dir <path>              download directory
-data <path>             state directory
-segments 8              default connections per download (1-32)
-concurrent 3            max simultaneous downloads
-limit 0                 global speed cap (e.g. 2M, 500K; 0 = unlimited)
-retries 5               retries per connection
-ua <string>             User-Agent
-open=true               open browser on start
```

## API

| Method | Path                    | Description                            |
| ------ | ----------------------- | -------------------------------------- |
| GET    | `/api/tasks`            | list tasks (newest first)              |
| POST   | `/api/tasks`            | `{"url":"…","fileName":"…","segments":8}` + page context (below) |
| GET    | `/api/inspect?url=…`    | probe without downloading: `kind` (file/hls/dash/page/drm), `fileName`, `size`, `sizeEstimated`, `live`; video formats for pages |
| POST   | `/api/prompt`           | open the New Download dialog for `{"url":"…"}` + page context |
| POST   | `/api/video`            | yt-dlp download `{"url","title","selector","ext","audio"}` + page context |
| GET    | `/api/tasks/{id}`       | one task                               |
| POST   | `/api/tasks/{id}/pause` | pause (keeps segment progress)         |
| POST   | `/api/tasks/{id}/resume`| resume / retry                         |
| POST   | `/api/tasks/{id}/schedule`| `{"at":<epoch ms>}` start later; `0` cancels |
| DELETE | `/api/tasks/{id}?file=1`| remove entry (`file=1` deletes data)   |
| GET    | `/api/tasks/{id}/file`  | stream the completed file              |
| POST   | `/api/tasks/{id}/reveal`| select file in Explorer                |
| GET    | `/api/events`           | SSE: full task snapshot every 500 ms   |

### Page context (for the browser extension)

`POST /api/tasks`, `/api/video` and `/api/prompt` accept optional fields that
make D BOX's requests look like the page's own — many video hosts refuse
downloads without them:

| Field     | Meaning                                                        |
| --------- | -------------------------------------------------------------- |
| `referer` | the page the link / video was found on (`pageUrl` is an alias) |
| `cookies` | `"a=1; b=2"` — the file site's cookies                         |
| `headers` | extra request headers, e.g. `{"Origin":"https://…"}`           |
| `title`   | the page / video title, used when the server's name is generic |

`/api/prompt` keeps the cookies/headers server-side and passes the dialog a
short-lived `ctx` token instead, so they never appear in a URL or command line.
Cookies posted to `/api/cookies` are also applied to plain file downloads of
that site.

## Layout

```
cmd/myidm/            entrypoint, flags, graceful shutdown
internal/config/      flag parsing, defaults
internal/store/       atomic JSON persistence
internal/engine/      scheduler, segment planner, ranged/whole-stream
                      downloaders, rate limiter, probe (size/ranges/filename)
internal/server/      REST + SSE handlers, embedded web UI
extension/            the D BOX Integration browser extension (load unpacked in
                      Brave/Chrome; see extension/README.md)
tools/testserver/     HTTP server simulating ranged/slow/no-range/chunked origins
tools/e2e.sh          end-to-end suite (integrity, pause/resume, crash recovery)
```

## Tests

```bash
go build -o bin/testserver.exe ./tools/testserver
bash tools/e2e.sh
```

21 checks: SHA256 integrity across 6-connection downloads, pause/resume,
no-range fallback, chunked transfer, hard-kill crash recovery, real-world URL.
