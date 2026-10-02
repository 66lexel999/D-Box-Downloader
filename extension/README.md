# D BOX Integration (Brave / Chrome extension)

The browser side of D BOX, like IDM's integration module. Manifest V3.

- **Download capture** — when the browser starts a download D BOX should own
  (archives, installers, video/audio), it's cancelled at the browser's download
  manager (`chrome.downloads`) and D BOX's New Download window opens instead.
  No browser setting has to change.
- **"Download this video" button** — appears over the largest video on a page
  (including players embedded in iframes). Its menu lists qualities from D BOX's
  yt-dlp probe, followed by the streams the page actually played (captured off
  the network), IDM-style — so if yt-dlp picks up the wrong thing on a page, the
  real stream is still one click away. For a player inside an iframe, the
  player's own URL is what's downloaded, with the page as Referer. **Drag the button** to
  put it anywhere on the video; the spot is remembered per site ("Reset button
  position" in the menu puts it back).
- **Image grabber** — hover a large image for a download badge.

## What D BOX receives with a download

So that D BOX's request looks like the browser's own (many video hosts refuse
anything else — hotlink protection, Cloudflare rules), each hand-off carries:

| Field       | Source                                                              |
| ----------- | ------------------------------------------------------------------- |
| `referer`   | the Referer/Origin the player really sent (observed via webRequest), else the page |
| `cookies`   | `chrome.cookies` for the file's/stream's URL                        |
| `userAgent` | `navigator.userAgent` (Cloudflare ties its clearance cookie to it)  |
| `title`     | the tab's title — used to name the file                             |

Everything goes only to D BOX on `127.0.0.1`. D BOX keeps cookies server-side
for that one download (the New Download window gets a short-lived token, never
the cookies themselves).

Captured HLS/DASH streams open in D BOX's New Download window as normal
downloads: D BOX downloads HLS natively (best quality, separate audio track
included) and hands DASH to yt-dlp; if the server still refuses, D BOX retries
through yt-dlp with browser impersonation.

## Install / update

1. Start **D BOX**.
2. Remove the real "IDM Integration Module" if present (both capture downloads).
3. `brave://extensions` → **Developer mode** on → **Load unpacked** → this folder.
   To update an unpacked copy, replace the files and click the extension's
   **reload** (↻) button, then reload open tabs.
4. Pin the toolbar icon. **One click opens the D BOX window** (even when D BOX
   is waiting hidden in the tray). Right-click it to switch **Capture
   downloads** on/off or open **Options** (D BOX's address).

## Why the overlay is in a Shadow DOM

The button, menu and image badge render inside a closed shadow root, so the
page's CSS can't restyle them (Bootstrap's `.row`, right-to-left pages, big
fonts, etc. used to add a horizontal scrollbar, wrap rows and clip the menu).

## Limits

- `blob:`/`data:` downloads (generated in-page) and POST downloads can't be
  handed off and stay with the browser — same as IDM.
- DRM-protected streams (Widevine/FairPlay) can't be downloaded.
