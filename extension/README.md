# MyIDM Integration (Brave/Chromium extension)

The browser side of an IDM-style setup for **MyIDM**. It captures downloads at the
**network-request layer** — exactly like IDM's module — and hands them to MyIDM,
which shows the New Download dialog and runs the segmented download.

```
request returns a file  ──►  extension cancels it at onHeadersReceived
                              (before any Save As dialog)
                                     │
                                     ▼
                              MyIDM /add dialog → segmented engine
                              → Downloads\MyIDM\<Category>\
```

## Why it's Manifest V2

It uses **blocking `webRequest`** (`onHeadersReceived` + `{cancel:true}`) to stop a
download *before* the browser commits to it. Google removed that capability from
MV3 for regular extensions, so this is MV2 — the same generation IDM's module uses.

- **No browser setting to change.** Because it intercepts at the request layer, you
  do **not** need to disable "Ask where to save each file."
- Brave still loads MV2 unpacked extensions (it shows a "deprecated" note). If a
  future Brave drops MV2, the MV3 variant (which needs that setting off) is the
  fallback.

## Install

1. Start **MyIDM** (`A:\PersonalApps\MyIDM\bin\myidm.exe`).
2. **Remove the real "IDM Integration Module"** from `brave://extensions` if present
   — both capture downloads and will fight; the real IDM would win and show its own
   dialog.
3. `brave://extensions` → **Developer mode** on → **Load unpacked** →
   `A:\PersonalApps\BraveDM`. (If you had the older version loaded, click **Remove**
   first, since the manifest version changed, then Load unpacked again.)
4. Pin the toolbar icon; it shows MyIDM's status (green = running).

## How interception works

`onHeadersReceived` (blocking) fires for every `main_frame` / `sub_frame` GET. The
response is treated as a download when:
- `Content-Disposition: attachment`, **or**
- the `Content-Type` is binary/media (octet-stream, zip, video/*, audio/*, …) and
  not a displayable type (html, text, images, json/xml, pdf), **or**
- the URL ends in a known download extension (zip, exe, mp4, …).

When matched, the request is cancelled and MyIDM's `/add` dialog opens. Loopback
URLs (`127.0.0.1`, `localhost`) are never intercepted, so MyIDM's own file streams
and the dialog's requests pass through. A fresh tab opened only for a download is
closed automatically.

## Settings (toolbar → Settings…)

- **Capture downloads** — master on/off.
- **MyIDM address** — must match MyIDM's `-listen` (default `127.0.0.1:8081`).

## Notes / limits

- Captures `http(s)` GET downloads. `blob:` / `data:` downloads (generated in-page)
  and POST downloads can't be handed off and are left to the browser — same as IDM.
- The background page shows as **persistent** (required for blocking webRequest);
  unlike the MV3 service worker it won't show "(Inactive)".
- Categories, folders and the engine all live in MyIDM, not here.
- Custom toolbar art: replace `icons/icon16|48|128.png`.
