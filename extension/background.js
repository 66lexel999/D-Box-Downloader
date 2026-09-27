// D BOX Integration - MV3 service worker.
// --------------------------------------------------------------------------
// Works like IDM's module: downloads are intercepted at the browser's
// download-manager layer (chrome.downloads) — when a download that D BOX should
// own begins, it's cancelled + erased before it gets anywhere and D BOX's New
// Download dialog opens instead. MV3 removed blocking webRequest (the MV2
// approach), and the downloads API is the sanctioned replacement; it also
// catches "Save link as…", which the old network-layer hook never saw.
//
// Being a service worker, this script has NO persistent state: it wakes for
// events (downloads, messages) and dies when idle. Settings are re-read from
// storage on each wake; the D BOX-availability flag is a short-lived cache
// refreshed on demand (content scripts poll status every 5s, keeping it warm).

const DEFAULT_SETTINGS = { enabled: true, myidmBase: "http://127.0.0.1:8081" };
let settings = Object.assign({}, DEFAULT_SETTINGS);

// Settings load races the first event after a wake — async paths await this.
const settingsReady = new Promise((resolve) => {
  chrome.storage.local.get("settings", (r) => {
    if (!r.settings) chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    settings = Object.assign({}, DEFAULT_SETTINGS, r.settings || {});
    resolve();
  });
});
chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.settings) settings = Object.assign({}, DEFAULT_SETTINGS, c.settings.newValue || {});
});

function base() { return settings.myidmBase.replace(/\/+$/, ""); }

// ---- D BOX availability (cached ping) -------------------------------------
let myidmUp = false, lastPing = 0, pingInflight = null;

// pingMyIDM returns the cached flag when younger than maxAge ms, else refreshes
// it (deduping concurrent refreshes). maxAge 0 forces a live check.
async function pingMyIDM(maxAge = 4000) {
  await settingsReady;
  if (Date.now() - lastPing < maxAge) return myidmUp;
  if (!pingInflight) {
    pingInflight = (async () => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1200);
        const r = await fetch(base() + "/api/categories", { signal: ctrl.signal });
        clearTimeout(t);
        myidmUp = r.ok;
      } catch { myidmUp = false; }
      lastPing = Date.now();
      pingInflight = null;
    })();
  }
  await pingInflight;
  return myidmUp;
}

// ---- download capture ------------------------------------------------------
// Everything reaching chrome.downloads IS a download (the browser decided), so
// classification only scopes WHICH file types D BOX takes over — archives,
// installers, media files — matching the old extension's behavior. Images and
// documents the user "Save as…"es stay with the browser.
const BINARY_CT = new Set([
  "application/octet-stream", "application/zip", "application/x-zip-compressed",
  "application/x-rar-compressed", "application/vnd.rar", "application/x-7z-compressed",
  "application/gzip", "application/x-gzip", "application/x-tar", "application/x-bzip2",
  "application/x-msdownload", "application/x-msdos-program", "application/x-msi",
  "application/vnd.android.package-archive", "application/x-apple-diskimage",
  "application/x-iso9660-image", "application/vnd.microsoft.portable-executable"
]);
const DL_EXT = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst", "iso", "cab",
  "exe", "msi", "apk", "dmg", "deb", "rpm", "appimage", "msix", "jar", "bin", "img",
  "mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v", "mpg", "mpeg", "ts", "3gp",
  "mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus"
]);

function extOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}
function extFromUrl(url) {
  try { return extOf(new URL(url).pathname); } catch { return ""; }
}
function isLoopback(url) {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch { return false; }
}

// shouldCapture scopes the takeover: http(s) only (blob:/data:/file: can't be
// re-fetched by D BOX), never D BOX's own traffic, and only file types from the
// capture list (by suggested filename, URL extension, or binary MIME).
function shouldCapture(item) {
  if (!settings.enabled) return false;
  const url = item.finalUrl || item.url || "";
  if (!/^https?:/i.test(url) || isLoopback(url)) return false;
  const ext = extOf(item.filename) || extFromUrl(url);
  if (DL_EXT.has(ext)) return true;
  return BINARY_CT.has((item.mime || "").toLowerCase());
}

let lastDownWarn = 0;
function warnNotRunning() {
  const now = Date.now();
  if (now - lastDownWarn < 3600000) return;
  lastDownWarn = now;
  chrome.notifications.create({
    type: "basic", iconUrl: "icons/icon128.png",
    title: "D BOX is not running",
    message: "Start D BOX to capture downloads. This one was left to the browser."
  }, () => void chrome.runtime.lastError);
}

// ---- media sniffer (IDM-style network capture) ---------------------------
// yt-dlp can't resolve many embedded players by page URL (uqload, etc.), but the
// player still FETCHES the real media over the network. MV3 forbids blocking
// webRequest but permits OBSERVING it, so we watch each tab's requests and
// collect the media it loads. The overlay offers those direct streams when the
// yt-dlp probe fails — exactly like IDM's "Download this video" list.
//
// Captures are persisted in chrome.storage.session (NOT just an in-memory Map):
// the MV3 service worker is killed when idle, so by the time the user clicks the
// button minutes later, an in-memory store would be empty. storage.session
// survives SW restarts for the browser session.
//
// Two observers, because one isn't enough:
//   onBeforeRequest  — fires for EVERY request; catches the <video>/<audio> load
//                      by resource TYPE "media" even when the URL has no telltale
//                      extension (uqload serves tokenized URLs), and catches
//                      .m3u8/.ts by URL pattern.
//   onHeadersReceived — enriches with Content-Length (size) + Content-Type.
const MEDIA_RE = /\.(m3u8|mpd|mp4|m4v|webm|mkv|mov|flv|avi|ts|m4s|srt|vtt|mp3|m4a|aac|ogg|opus|wav|flac)(\?|#|$)/i;

function mediaExt(url, ct) {
  const m = MEDIA_RE.exec(String(url).split("#")[0]);
  if (m) return m[1].toLowerCase();
  ct = (ct || "").toLowerCase();
  if (ct.includes("mpegurl") || ct.includes("m3u8")) return "m3u8";
  if (ct.includes("dash+xml")) return "mpd";
  if (ct.startsWith("video/")) return ct.includes("webm") ? "webm" : "mp4";
  if (ct.startsWith("audio/")) return ct.includes("mpeg") ? "mp3" : "m4a";
  if (ct.includes("subrip") || ct.includes("text/vtt")) return ct.includes("vtt") ? "vtt" : "srt";
  return "";
}
// kind drives how the overlay downloads it: hls -> yt-dlp (handles the playlist);
// sub -> plain file; seg -> an HLS chunk we fold into "file" only if large;
// file -> a progressive media file D BOX grabs directly.
function extKind(ext) {
  if (ext === "m3u8" || ext === "mpd") return "hls";
  if (ext === "srt" || ext === "vtt") return "sub";
  if (ext === "ts" || ext === "m4s") return "seg";
  return "file";
}

const sessKey = (tabId) => "media_" + tabId;
const writeChain = new Map(); // tabId -> tail promise (serialize storage writes)
const seenSize = new Map();   // tabId -> Map(url -> size)  in-memory write throttle

function withChain(tabId, fn) {
  const tail = (writeChain.get(tabId) || Promise.resolve()).then(fn).catch(() => {});
  writeChain.set(tabId, tail);
}

// capture merges one media hit into the tab's persisted list. Each item is tagged
// with the FRAME that loaded it and a timestamp, so switching videos (which
// reloads the player iframe) doesn't leave stale streams ahead of the new one.
// Writes are serialized per tab and throttled: a URL is only (re)written when
// it's new or its size grew, so a buffering video's many range requests cost ~1.
function capture(tabId, frameId, url, ext, size) {
  if (tabId < 0 || !ext) return;
  try { if (new URL(url).origin === base()) return; } catch (_) { return; } // skip D BOX's own traffic
  let kind = extKind(ext);
  if (kind === "seg") {
    // HLS/DASH chunk. Skip unless it's clearly a large STANDALONE progressive
    // file (known size ≥ 5 MB); an unknown/small size is a playlist segment.
    if (!size || size < 5 * 1024 * 1024) return;
    kind = "file";
  }
  const key = String(url).split("#")[0];
  let sm = seenSize.get(tabId);
  if (!sm) { sm = new Map(); seenSize.set(tabId, sm); }
  const known = sm.get(key);
  if (known !== undefined && (!size || size <= known)) return; // no new info
  sm.set(key, size || known || 0);

  const item = { url: key, ext, size: size || known || 0, kind, frameId, ts: Date.now() };
  withChain(tabId, async () => {
    const k = sessKey(tabId);
    let list;
    try { list = (await chrome.storage.session.get(k))[k] || []; } catch (_) { list = []; }
    const i = list.findIndex((x) => x.url === item.url);
    if (i >= 0) { if (item.size > (list[i].size || 0)) list[i].size = item.size; list[i].ts = item.ts; list[i].frameId = frameId; }
    else { list.push(item); if (list.length > 120) list.shift(); }
    try { await chrome.storage.session.set({ [k]: list }); } catch (_) {}
  });
}

function resetTab(tabId) {
  seenSize.delete(tabId);
  hdrSeen.delete(tabId);
  writeChain.delete(tabId);
  chrome.storage.session.remove([sessKey(tabId), hdrKey(tabId)]).catch(() => {});
}

// resetFrame drops one frame's captures when its iframe navigates to a new
// document — so a new video loading in the SAME player frame replaces the old
// one instead of stacking behind it (the "same video every time" bug).
function resetFrame(tabId, frameId) {
  if (seenSize.has(tabId)) seenSize.get(tabId).clear(); // force re-capture of the new doc's media
  withChain(tabId, async () => {
    const k = sessKey(tabId);
    let list;
    try { list = (await chrome.storage.session.get(k))[k] || []; } catch (_) { return; }
    const kept = list.filter((x) => x.frameId !== frameId);
    if (kept.length !== list.length) { try { await chrome.storage.session.set({ [k]: kept }); } catch (_) {} }
  });
}

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type === "main_frame") { resetTab(d.tabId); return; }       // new page -> full reset
    if (d.type === "sub_frame") { resetFrame(d.tabId, d.frameId); return; } // iframe -> new player, clear its old media
    let ext = mediaExt(d.url, "");
    if (!ext && d.type === "media") ext = "mp4"; // a <video>/<audio> load with no telltale extension
    if (ext) capture(d.tabId, d.frameId, d.url, ext, 0);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0) return;
    let ct = "", len = 0;
    for (const h of d.responseHeaders || []) {
      const n = h.name.toLowerCase();
      if (n === "content-type") ct = h.value || "";
      else if (n === "content-length") len = parseInt(h.value, 10) || 0;
    }
    let ext = mediaExt(d.url, ct);
    if (!ext && d.type === "media") ext = ct.includes("webm") ? "webm" : "mp4";
    if (ext) capture(d.tabId, d.frameId, d.url, ext, len);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// The Referer/Origin the browser sent when the player fetched each stream.
// Many stream servers only answer requests that come "from" the page the video
// plays on (hotlink protection, Cloudflare rules) — IDM and JDownloader replay
// exactly these headers, and so does D BOX now. Observed only (non-blocking);
// "extraHeaders" is what makes Referer/Origin visible to the listener. Only
// manifests and media files are recorded (not every HLS segment).
const hdrKey = (tabId) => "hdr_" + tabId;
const hdrSeen = new Map(); // tabId -> Set(url)  in-memory write throttle

chrome.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const ext = mediaExt(d.url, "");
    const kind = ext ? extKind(ext) : (d.type === "media" ? "file" : "");
    if (kind !== "hls" && kind !== "file") return;
    const key = String(d.url).split("#")[0];
    let seen = hdrSeen.get(d.tabId);
    if (!seen) { seen = new Set(); hdrSeen.set(d.tabId, seen); }
    if (seen.has(key)) return;
    seen.add(key);
    let referer = "", origin = "";
    for (const h of d.requestHeaders || []) {
      const n = h.name.toLowerCase();
      if (n === "referer") referer = h.value || "";
      else if (n === "origin" && h.value !== "null") origin = h.value || "";
    }
    if (!referer && !origin) return;
    withChain(d.tabId, async () => {
      const k = hdrKey(d.tabId);
      let m;
      try { m = (await chrome.storage.session.get(k))[k] || {}; } catch (_) { m = {}; }
      m[key] = { referer, origin };
      const keys = Object.keys(m);
      if (keys.length > 150) delete m[keys[0]];
      try { await chrome.storage.session.set({ [k]: m }); } catch (_) {}
    });
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.tabs.onRemoved.addListener(resetTab);

// sniffedMedia returns the CURRENTLY-PLAYING video's streams for a tab. The
// current video is whichever frame produced the most recent playable stream, so
// switching tutorials/servers never serves a stale video. Within that frame:
// empty-placeholder subs are dropped, an HLS master hides its sub-playlists, and
// results are ranked (HLS, then progressive files, then subtitles), newest first.
async function sniffedMedia(tabId) {
  let list = [];
  try { list = (await chrome.storage.session.get(sessKey(tabId)))[sessKey(tabId)] || []; } catch (_) {}
  list = list.filter((s) => !(s.kind === "sub" && /empty\.(srt|vtt)/i.test(s.url)));
  if (!list.length) return [];
  // Pick the frame of the freshest video/HLS stream = the active player.
  const playable = list.filter((s) => s.kind === "hls" || s.kind === "file");
  const newest = (playable.length ? playable : list).reduce((a, b) => (b.ts || 0) > (a.ts || 0) ? b : a);
  list = list.filter((s) => s.frameId === newest.frameId);
  const hasMaster = list.some((s) => s.kind === "hls" && /master\.m3u8/i.test(s.url));
  if (hasMaster) list = list.filter((s) => s.kind !== "hls" || /master\.m3u8/i.test(s.url));
  const rank = { hls: 0, file: 1, sub: 2 };
  list.sort((a, b) => (rank[a.kind] - rank[b.kind]) || ((b.ts || 0) - (a.ts || 0)) || ((b.size || 0) - (a.size || 0)));
  let hdrs = {};
  try { hdrs = (await chrome.storage.session.get(hdrKey(tabId)))[hdrKey(tabId)] || {}; } catch (_) {}
  return list.map((s) => Object.assign({}, s, hdrs[s.url] || {}));
}

// ---- page context handed to D BOX -----------------------------------------
// cookieHeader returns the browser's cookies for url as a Cookie header value
// (httpOnly included — chrome.cookies sees them). Sent only to the local D BOX
// app, which keeps them server-side for this one download.
function cookieHeader(url) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll({ url }, (list) => {
        if (chrome.runtime.lastError || !list) { resolve(""); return; }
        resolve(list.map((c) => c.name + "=" + c.value).join("; "));
      });
    } catch { resolve(""); }
  });
}

// pageContext is what makes D BOX's request look like the browser's own: the
// page it came from, the site's cookies, the browser's User-Agent (Cloudflare
// ties its clearance cookie to it) and, for player requests, the Origin.
async function pageContext(url, referer, origin) {
  const ctx = { userAgent: navigator.userAgent };
  if (referer) ctx.referer = referer;
  const cookies = await cookieHeader(url);
  if (cookies) ctx.cookies = cookies;
  if (origin) ctx.headers = { Origin: origin };
  return ctx;
}

async function handOff(url, name, referer) {
  // Prefer D BOX's own native "New Download" window; if it's headless (no GUI)
  // it answers {native:false} and we open the browser popup dialog instead.
  // The page context rides along so hotlink-protected files download too.
  const ctx = await pageContext(url, referer, "");
  fetch(base() + "/api/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ url, name }, ctx))
  })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((d) => { if (!d || !d.native) openAddPopup(url, name, referer); })
    .catch(() => openAddPopup(url, name, referer));
}

// openAddPopup is the headless fallback. Cookies are NOT put in this URL; the
// dialog still passes the page along as the Referer.
function openAddPopup(url, name, referer) {
  const params = new URLSearchParams({ url, name, ext: chrome.runtime.id });
  if (referer) params.set("referer", referer);
  chrome.windows.create({
    url: base() + "/add?" + params.toString(),
    type: "popup", width: 600, height: 460
  });
}

// onDeterminingFilename fires once per download with the browser's suggested
// filename (Content-Disposition already resolved). Returning true lets suggest()
// be called async, after the D BOX liveness check.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    await settingsReady;
    if (!shouldCapture(item)) { suggest(); return; }
    const up = await pingMyIDM(0); // live check — capture must not eat the download if D BOX is gone
    suggest(); // let the browser's pipeline settle; cancel() below still wins
    if (!up) { warnNotRunning(); return; }
    const name = (item.filename || "").split(/[\\/]/).pop() || "download";
    chrome.downloads.cancel(item.id, () => {
      void chrome.runtime.lastError;
      // erase removes the cancelled stub from the browser's download shelf/history
      chrome.downloads.erase({ id: item.id }, () => void chrome.runtime.lastError);
      handOff(item.finalUrl || item.url, name, item.referrer || "");
    });
  })();
  return true; // async suggest()
});

// ---- login cookies for yt-dlp (Instagram stories/reels, etc.) ------------
// yt-dlp runs as a separate process and can't read the browser's cookie DB while
// Brave is open (the file is locked). But WE are inside Brave with the live
// session, so we read the site's cookies via chrome.cookies and hand them to
// D BOX, which writes a cookies.txt and passes --cookies to yt-dlp. Scoped to
// hosts that actually gate media behind a login; re-pushed at most every ~2 min.
const COOKIE_HOSTS = /(^|\.)(instagram|facebook|fb|threads|tiktok|twitter|x|reddit|patreon|nicovideo|weibo|bilibili)\.(com|net|tv|jp|cn)$/i;
const cookiePushed = new Map(); // registrable-domain -> timestamp (resets with the worker; harmless)

function needsCookies(host) { return COOKIE_HOSTS.test(host); }

// getAll cookies visible to a URL (includes httpOnly, which holds Instagram's
// sessionid), mapped to D BOX's field names.
function collectCookies(url) {
  return new Promise((resolve) => {
    try {
      chrome.cookies.getAll({ url }, (list) => {
        if (chrome.runtime.lastError || !list) { resolve([]); return; }
        resolve(list.map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          secure: !!c.secure, httpOnly: !!c.httpOnly, hostOnly: !!c.hostOnly,
          expiry: c.expirationDate || 0, // seconds; absent => session cookie
        })));
      });
    } catch { resolve([]); }
  });
}

// Push the current session's cookies for url's site to D BOX before a probe or
// download, so yt-dlp is authenticated. Awaited so the probe that follows sees
// the cookie file. Deduped per domain within a 2-minute window.
async function ensureCookies(url, force) {
  let host;
  try { host = new URL(url).hostname; } catch { return; }
  if (!needsCookies(host)) return;
  const key = host.split(".").slice(-2).join(".");
  const now = Date.now();
  if (!force && now - (cookiePushed.get(key) || 0) < 120000) return;
  const cookies = await collectCookies(url);
  if (!cookies.length) return; // not logged in / nothing to send
  try {
    await fetch(base() + "/api/cookies", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, cookies }),
    });
    cookiePushed.set(key, now);
  } catch (_) {}
}

// ---- messages from the content-script overlay -----------------------------
// The worker holds the D BOX host permission, so it does the fetches
// (content-script fetch would hit CORS).
async function postJSON(path, body) {
  const r = await fetch(base() + path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await settingsReady;
    try {
      // topPageURL resolves what yt-dlp should probe/download when a CONTENT
      // SCRIPT passes "my own frame's URL". In an iframe-embedded player
      // (DailyMotion's geo.dailymotion.com/player/xtv3w.html, YouTube embeds,
      // etc.) location.href is a player SHELL yt-dlp can't resolve, while the
      // tab's top-level URL is the real page. In the top frame both are equal.
      const topPageURL = (u) => {
        if (u && sender.url && u === sender.url && sender.tab && sender.tab.url && sender.tab.url !== u) {
          return sender.tab.url;
        }
        return u;
      };
      if (msg.type === "status") {
        sendResponse({ ok: await pingMyIDM() });
      } else if (msg.type === "sniffed") {
        // What has the network shown us for this tab? Used as the fallback when
        // the yt-dlp probe fails on an embedded player (uqload, etc.).
        const tid = (sender.tab && sender.tab.id) || msg.tabId;
        sendResponse({ ok: true, streams: await sniffedMedia(tid) });
      } else if (msg.type === "probe") {
        // Probe the frame's own URL first — for player EMBEDS (uqload, dood, …)
        // the frame URL is exactly what yt-dlp resolves. When that fails (a
        // player shell like DailyMotion's geo.dailymotion.com/player/xtv3w.html),
        // retry with the tab's top-level page URL, which is the real video page.
        const tabURL = (sender.tab && sender.tab.url) || "";
        const candidates = [msg.url];
        if (tabURL && tabURL !== msg.url) candidates.push(tabURL);
        let r = null, data = null, resolved = "";
        for (const u of candidates) {
          await ensureCookies(u); // authenticate yt-dlp BEFORE probing (IG/etc.)
          // An embedded player (the frame URL) usually only answers when the
          // embedding page is the Referer.
          const ref = tabURL && tabURL !== u ? "&referer=" + encodeURIComponent(tabURL) : "";
          r = await fetch(base() + "/api/probe?url=" + encodeURIComponent(u) + ref);
          data = await r.json().catch(() => ({}));
          if (r.ok) { resolved = u; break; }
        }
        if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
        sendResponse({ ok: true, result: data, resolved });
      } else if (msg.type === "queueVideo") {
        sendResponse({ ok: true, result: await postJSON("/api/video", msg.payload) });
      } else if (msg.type === "promptVideo") {
        // Open D BOX's New Download window for a video; fall back to a direct
        // queue if D BOX is headless (answers native:false / errors).
        const p = msg.payload || {};
        const pageURL = topPageURL(p.url);
        await ensureCookies(pageURL, true); // refresh cookies right before the download
        const tabURL = (sender.tab && sender.tab.url) || "";
        const ctx = await pageContext(pageURL, tabURL && tabURL !== pageURL ? tabURL : "", "");
        let native = false;
        try {
          const d = await postJSON("/api/prompt", Object.assign({
            url: pageURL, name: p.title, video: true,
            selector: p.selector, ext: p.ext, audio: !!p.audio, title: p.title
          }, ctx));
          native = !!(d && d.native);
        } catch (_) {}
        if (native) sendResponse({ ok: true, native: true });
        else sendResponse({ ok: true, result: await postJSON("/api/video", Object.assign({
          url: pageURL, title: p.title, selector: p.selector, ext: p.ext, audio: !!p.audio,
          size: p.size || 0, category: "Video"
        }, ctx)) });
      } else if (msg.type === "promptStream") {
        // A stream/file the page loaded (captured off the network). Hand it to
        // D BOX's New Download window as a plain download: D BOX detects HLS and
        // downloads it natively (best quality + separate audio track), sends
        // DASH to yt-dlp, and falls back to yt-dlp-as-a-browser if the server
        // still refuses. The Referer/Origin the player really used, the site's
        // cookies and Brave's User-Agent go with it.
        const p = msg.payload || {};
        if (p.kind === "sub") {
          const ctx = await pageContext(p.url, p.referer || p.frameUrl || "", "");
          const name = ((p.url.split("?")[0].split("/").pop()) || ("subtitles." + p.ext)).replace(/[<>:"/\\|?*]+/g, "_");
          sendResponse({ ok: true, result: await postJSON("/api/tasks", Object.assign({ url: p.url, fileName: name, category: "Documents" }, ctx)) });
          return;
        }
        const title = (sender.tab && sender.tab.title) || p.title || "";
        const ctx = await pageContext(p.url, p.referer || p.frameUrl || (sender.tab && sender.tab.url) || "", p.origin || "");
        let native = false;
        try {
          const d = await postJSON("/api/prompt", Object.assign({ url: p.url, title }, ctx));
          native = !!(d && d.native);
        } catch (_) {}
        if (native) sendResponse({ ok: true, native: true });
        else sendResponse({ ok: true, result: await postJSON("/api/tasks", Object.assign({ url: p.url, title, category: "Video" }, ctx)) });
      } else if (msg.type === "queueFile") {
        const p = msg.payload || {};
        const ctx = await pageContext(p.url, p.referer || (sender.tab && sender.tab.url) || "", "");
        sendResponse({ ok: true, result: await postJSON("/api/tasks", Object.assign({}, p, ctx)) });
      } else {
        sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // async response
});

// D BOX's dialog asks us to close its popup window after queueing the download.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "closeDialog" && sender.tab) {
    chrome.windows.remove(sender.tab.windowId, () => void chrome.runtime.lastError);
    sendResponse({ ok: true });
  }
  return true;
});
