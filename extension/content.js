// D BOX grab overlay: a floating "Download this video" button (IDM-style) on
// pages with a video, whose dropdown lists qualities from D BOX's yt-dlp probe
// (or the streams the page loaded); plus a hover "download" badge on large
// images. All network work is proxied through the background worker (which
// holds the D BOX host permission).
//
// The UI lives in a closed SHADOW ROOT. It used to be plain elements with class
// names like .row/.close/.msg added to the page, so the page's own CSS styled
// it too — Bootstrap's `.row` (negative side margins + flex-wrap) gave the menu
// a horizontal scrollbar and split "1." and the label onto separate lines, and
// right-to-left pages flipped and clipped it. Page CSS can't reach inside a
// shadow root.
(function () {
  "use strict";
  const isTop = window.top === window;
  // Runs in ALL frames (all_frames:true): an iframe-embedded player (uqload,
  // streamtape, dood…) gets the button too and probes its own frame URL. Skip
  // frames too small to hold a real player (ads, pixels).
  if (!isTop && innerWidth && innerHeight && (innerWidth < 320 || innerHeight < 180)) return;

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.vbtn {
  position: fixed; display: none; align-items: center; gap: 6px;
  padding: 3px 6px 3px 8px; margin: 0;
  font: 12px/1.2 "Segoe UI", Tahoma, sans-serif; color: #e8e8e8; direction: ltr;
  background: linear-gradient(#3b3f43, #2a2d30);
  border: 1px solid #565b60; border-radius: 3px;
  box-shadow: 0 1px 4px rgba(0,0,0,.35);
  cursor: pointer; user-select: none; white-space: nowrap; touch-action: none;
}
.vbtn.dragging { cursor: grabbing; opacity: .9; box-shadow: 0 4px 14px rgba(0,0,0,.5); }
.vbtn .play { width: 16px; height: 16px; display: block; flex: none; object-fit: contain; pointer-events: none; }
.vbtn .x {
  display: inline-grid; place-items: center; width: 14px; height: 14px; margin-left: 2px;
  border: 1px solid #5a5f64; border-radius: 2px; background: #44494d; color: #cfd2d4;
  font-size: 10px; line-height: 1;
}
.vbtn .x:hover { background: #565b60; }
/* Formats prefetched and ready: green outline. */
.vbtn.ready { border-color: #1faa3f; box-shadow: 0 1px 4px rgba(0,0,0,.35), 0 0 0 1px rgba(31,170,63,.45); }

.menu {
  position: fixed; direction: ltr; text-align: left;
  width: max-content; min-width: min(280px, calc(100vw - 16px)); max-width: min(520px, calc(100vw - 16px));
  max-height: min(70vh, calc(100vh - 16px)); overflow-x: hidden; overflow-y: auto;
  background: #2b2b2b; color: #eaeaea; border: 1px solid #111; border-radius: 4px;
  box-shadow: 0 6px 22px rgba(0,0,0,.55);
  font: 12px/1.4 "Segoe UI", Tahoma, sans-serif; padding: 4px 0; margin: 0;
}
.head {
  padding: 6px 12px; margin-bottom: 4px; color: #cfcfcf; font-weight: 600;
  border-bottom: 1px solid #3a3a3a; white-space: normal; overflow-wrap: anywhere;
}
.sub { padding: 0 12px 4px; font-size: 11px; opacity: .7; }
.item { display: flex; align-items: baseline; gap: 8px; padding: 6px 12px; cursor: pointer; min-width: 0; }
.item:hover { background: #3d6199; color: #fff; }
.item .n { color: #8a8a8a; flex: none; min-width: 16px; }
.item:hover .n { color: #d6e2f5; }
.item .lbl { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item .sz { flex: none; padding-left: 10px; color: #9a9a9a; font-variant-numeric: tabular-nums; }
.item:hover .sz { color: #e6eefb; }
.note { padding: 8px 12px; color: #cfcfcf; white-space: normal; overflow-wrap: anywhere; }
.note.err { color: #ff9c9c; }
.foot { border-top: 1px solid #3a3a3a; margin-top: 4px; padding: 5px 12px; font-size: 11px; color: #9a9a9a; cursor: pointer; }
.foot:hover { color: #fff; }

.imgbtn {
  position: fixed; display: none; place-items: center; width: 26px; height: 26px;
  background: rgba(20,20,20,.82); color: #fff; font: 15px/1 "Segoe UI", sans-serif;
  border: 1px solid rgba(255,255,255,.35); border-radius: 5px; cursor: pointer;
  box-shadow: 0 1px 5px rgba(0,0,0,.5);
}
.imgbtn:hover { background: #2563eb; }
.imgbtn img { width: 18px; height: 18px; object-fit: contain; display: block; }
`;

  // ---- shadow host --------------------------------------------------------
  let host = null, root = null;
  function ui() {
    if (root) return root;
    host = document.createElement("dbox-overlay");
    // Pin the host itself against page CSS (!important beats non-important page rules).
    for (const [k, v] of [["all", "initial"], ["position", "fixed"], ["top", "0"], ["left", "0"],
      ["width", "0"], ["height", "0"], ["z-index", "2147483647"], ["display", "block"]]) {
      host.style.setProperty(k, v, "important");
    }
    root = host.attachShadow({ mode: "closed" });
    const st = document.createElement("style");
    st.textContent = CSS;
    root.appendChild(st);
    document.documentElement.appendChild(host);
    return root;
  }
  // inUI reports whether an event happened inside our overlay (events from a
  // shadow root reach document listeners retargeted to the host).
  const inUI = (e) => !!host && e.composedPath().includes(host);

  let btn = null, menu = null, curVideo = null, dismissed = false, lastUrl = location.href;
  let curResolved = location.href; // the URL the successful probe actually resolved (frame or top page)
  let upCache = { val: false, ts: 0 };
  // Prefetched probe results, keyed by URL, so clicking opens the quality menu
  // instantly instead of waiting on yt-dlp. Failures retry after a cooldown.
  const probeCache = new Map(); // url -> { p, ts, ok, msg }

  function warm(url) {
    const e = probeCache.get(url);
    if (e && (e.ok === undefined || e.ok || Date.now() - e.ts < 12000)) return e.p;
    if (probeCache.size > 40) probeCache.clear();
    const entry = { p: null, ts: Date.now(), ok: undefined, msg: null };
    entry.p = send({ type: "probe", url }).then((r) => {
      entry.ok = !!(r && r.ok);
      entry.ts = Date.now();
      entry.msg = r;
      if (entry.ok) {
        curResolved = (r && r.resolved) || url;
        if (url === location.href) markReady();
      }
      return r;
    });
    probeCache.set(url, entry);
    return entry.p;
  }
  function cachedMsg(url) {
    const e = probeCache.get(url);
    return e && e.ok ? e.msg : null;
  }
  function markReady() {
    if (!btn) return;
    btn.classList.add("ready");
    btn.title = "Formats ready — click to pick a quality · drag to move";
  }
  function clearReady() { if (btn) btn.classList.remove("ready"); }

  function send(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false })); }
      catch { resolve({ ok: false }); }
    });
  }
  async function dboxUp() {
    const now = Date.now();
    if (now - upCache.ts < 5000) return upCache.val;
    const r = await send({ type: "status" });
    upCache = { val: !!(r && r.ok), ts: now };
    return upCache.val;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  // ---- video discovery ------------------------------------------------------
  // Some players render <video> inside shadow DOM; the light-DOM scan runs
  // first, then a recursive shadow scan when it finds nothing.
  function videosInShadow(r, out) {
    for (const el of r.querySelectorAll("*")) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      for (const v of sr.querySelectorAll("video")) out.push(v);
      videosInShadow(sr, out);
    }
  }
  function largestVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    if (!vids.length) videosInShadow(document, vids);
    let best = null, bestArea = 0;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.width < 220 || r.height < 140) continue;
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  // ---- the button: click opens the menu, drag moves it ---------------------
  // Its position is remembered per site, relative to the video (fractions of
  // the video's box), so it stays where you put it as the player resizes.
  const posKey = "btnpos:" + location.hostname;
  let pos = null;       // { fx, fy } center of the button within the video, 0..1
  let drag = null;      // active drag state
  let suppressClick = false;
  try { chrome.storage.local.get(posKey, (r) => { if (r && r[posKey]) pos = r[posKey]; }); } catch (_) {}

  function ensureButton() {
    if (btn) return btn;
    btn = document.createElement("div");
    btn.className = "vbtn";
    btn.innerHTML =
      '<img class="play" src="' + chrome.runtime.getURL("icons/download.png") + '" alt="">' +
      '<span class="x" title="Hide">&#10005;</span>';
    btn.title = "Download this video — click to pick a quality · drag to move";
    btn.addEventListener("click", onOpen);
    btn.querySelector(".x").addEventListener("click", (e) => {
      e.stopPropagation(); dismissed = true; hideAll();
    });
    btn.addEventListener("pointerdown", dragStart);
    btn.addEventListener("pointermove", dragMove);
    btn.addEventListener("pointerup", dragEnd);
    btn.addEventListener("pointercancel", dragEnd);
    ui().appendChild(btn);
    return btn;
  }

  function dragStart(e) {
    if (e.button !== 0 || e.target.closest(".x")) return;
    const r = btn.getBoundingClientRect();
    drag = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    try { btn.setPointerCapture(e.pointerId); } catch (_) {}
  }
  function dragMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return; // a click, not a drag (yet)
    if (!drag.moved) { drag.moved = true; btn.classList.add("dragging"); closeMenu(); }
    btn.style.left = clamp(drag.ox + dx, 2, innerWidth - btn.offsetWidth - 2) + "px";
    btn.style.top = clamp(drag.oy + dy, 2, innerHeight - btn.offsetHeight - 2) + "px";
  }
  function dragEnd(e) {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    btn.classList.remove("dragging");
    try { btn.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!moved) return;
    suppressClick = true; // the click that follows this pointerup is the drop, not "open"
    setTimeout(() => { suppressClick = false; }, 350);
    if (curVideo) {
      const v = curVideo.getBoundingClientRect(), b = btn.getBoundingClientRect();
      if (v.width > 0 && v.height > 0) {
        pos = {
          fx: clamp((b.left + b.width / 2 - v.left) / v.width, 0, 1),
          fy: clamp((b.top + b.height / 2 - v.top) / v.height, 0, 1),
        };
        try { chrome.storage.local.set({ [posKey]: pos }); } catch (_) {}
      }
    }
  }
  function resetPosition() {
    pos = null;
    try { chrome.storage.local.remove(posKey); } catch (_) {}
    if (curVideo) positionButton(curVideo);
  }

  function positionButton(v) {
    if (drag) return; // never fight the user's drag
    const r = v.getBoundingClientRect();
    const w = btn.offsetWidth || 52, h = btn.offsetHeight || 24;
    let left, top;
    if (pos) {
      left = r.left + pos.fx * r.width - w / 2;
      top = r.top + pos.fy * r.height - h / 2;
    } else { // default: the video's top-right corner
      left = r.right - w - 6;
      top = r.top + 8;
    }
    btn.style.left = clamp(left, 2, innerWidth - w - 2) + "px";
    btn.style.top = clamp(top, 2, innerHeight - h - 2) + "px";
    if (menu) placeMenu();
  }

  // ---- the menu -------------------------------------------------------------
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function hideAll() { if (btn) btn.style.display = "none"; closeMenu(); }

  // placeMenu keeps the menu fully inside the window: under the button when it
  // fits, above it otherwise, never past the left/right edge.
  function placeMenu() {
    if (!menu || !btn) return;
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const left = clamp(r.left, 8, Math.max(8, innerWidth - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > innerHeight - 8 && r.top - mh - 4 >= 8) top = r.top - mh - 4;
    menu.style.left = left + "px";
    menu.style.top = clamp(top, 8, Math.max(8, innerHeight - mh - 8)) + "px";
  }
  function setMenu(html) {
    if (!menu) return;
    menu.innerHTML = html + (pos ? '<div class="foot" data-reset="1">&#8634; Reset button position</div>' : "");
    const f = menu.querySelector("[data-reset]");
    if (f) f.addEventListener("click", () => { closeMenu(); resetPosition(); });
    placeMenu();
  }
  // Titles and labels may be Arabic/Hebrew: dir=auto lays each out in its own
  // direction inside the left-to-right menu.
  const headHTML = (t) => '<div class="head" dir="auto">' + esc(t) + "</div>";
  const itemHTML = (attr, i, label, size) =>
    '<div class="item" ' + attr + '><span class="n">' + (i + 1) + '.</span><span class="lbl" dir="auto">' +
    esc(label) + "</span>" + (size ? '<span class="sz">' + size + "</span>" : "") + "</div>";

  async function onOpen(e) {
    e.stopPropagation();
    if (suppressClick) { suppressClick = false; return; }
    if (menu) { closeMenu(); return; }
    menu = document.createElement("div");
    menu.className = "menu";
    ui().appendChild(menu);

    const cached = cachedMsg(location.href);
    if (cached) { renderMenu(cached.result); return; }

    setMenu('<div class="note">Probing formats…</div>');
    const res = await warm(location.href);
    if (!menu) return;
    if (!res || !res.ok) {
      const err = (res && res.error) || "";
      // IDM-style fallback: yt-dlp couldn't handle this URL, but the browser
      // DID load the real media — offer what the background saw on the network.
      const sn = await send({ type: "sniffed" });
      if (!menu) return;
      const streams = (sn && sn.streams) || [];
      if (streams.length) { renderSniffed(streams); return; }
      const ig = /instagram\.com/i.test(location.href);
      let m;
      if (/not found|not installed/i.test(err)) {
        m = "yt-dlp isn’t installed — put yt-dlp.exe next to DBox.exe.";
      } else if (!res || !err || /failed to fetch|networkerror|connection|refused/i.test(err)) {
        m = "Couldn’t reach D BOX — make sure it’s running.";
      } else if (ig && /log ?in|login|sign ?in|cookies|authentication|rate.?limit|restricted|empty|not available|unavailable|unreachable/i.test(err)) {
        m = "Instagram wouldn’t authorize this. Make sure you’re logged into Instagram in Brave (open instagram.com), then try again — stories also expire after 24h.";
      } else if (/private|not available|unavailable|deleted|removed|age|restricted/i.test(err)) {
        m = "This video can’t be read — it may be private, age-restricted, deleted, or region-locked.";
      } else {
        m = "Couldn’t read this video: play it for a moment (D BOX watches the network), then click here again. " + err;
      }
      setMenu('<div class="note err">' + esc(m) + "</div>");
      return;
    }
    renderMenu(res.result);
  }

  function pageTitle() {
    return (document.title || "video").replace(/\s+-\s+YouTube$/, "").trim();
  }

  // renderSniffed lists the media the page actually loaded (captured off the
  // network by the background worker) — IDM's mechanism.
  function renderSniffed(streams) {
    let html = headHTML(pageTitle()) + '<div class="sub">Streams captured from the page:</div>';
    streams.forEach((s, i) => {
      const label = s.kind === "hls" ? "Video stream (" + s.ext.toUpperCase() + ")"
                  : s.kind === "sub" ? s.ext.toUpperCase() + " subtitles"
                  : "Direct file (" + s.ext.toUpperCase() + ")";
      html += itemHTML('data-si="' + i + '"', i, label, s.size ? humanBytes(s.size) : "");
    });
    setMenu(html);
    menu.querySelectorAll("[data-si]").forEach((row) =>
      row.addEventListener("click", () => pickSniffed(streams[+row.dataset.si])));
  }

  // pickSniffed hands a captured stream to D BOX WITH the context the browser
  // used to fetch it — the page it played on (Referer/Origin), the site's
  // cookies and the browser's User-Agent — so D BOX's request looks like the
  // player's own (what IDM and JDownloader do). Streams go to D BOX's New
  // Download window, which downloads HLS natively (best quality + separate
  // audio) and DASH via yt-dlp. Subtitles queue directly.
  async function pickSniffed(s) {
    setMenu('<div class="note">Opening…</div>');
    const res = await send({ type: "promptStream", payload: {
      url: s.url, kind: s.kind, ext: s.ext, title: pageTitle(),
      referer: s.referer || "", origin: s.origin || "", frameUrl: location.href,
    } });
    if (!menu) return;
    const ok = res && (res.native || res.ok);
    setMenu('<div class="note' + (ok ? "" : " err") + '">' +
      (res && res.native ? "Opening download window…"
        : ok ? "Sent to D BOX ✓"
        : ("Failed: " + esc((res && res.error) || "error"))) + "</div>");
    setTimeout(closeMenu, ok ? 1500 : 3000);
  }

  function humanBytes(n) {
    if (!n || n < 0) return "";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i && n < 10 ? 1 : 0) + " " + u[i];
  }
  function renderMenu(info) {
    const title = (info.title || pageTitle()).trim();
    if (!(info.options || []).length) {
      setMenu(headHTML(title) + '<div class="note">No downloadable formats found for this video.</div>');
      return;
    }
    let html = headHTML(title);
    info.options.forEach((o, i) => {
      const lbl = String(o.label || "").replace(/\s*\(~[^)]*\)\s*$/, ""); // size has its own column
      html += itemHTML('data-i="' + i + '"', i, lbl, humanBytes(o.size));
    });
    setMenu(html);
    menu.querySelectorAll("[data-i]").forEach((row) =>
      row.addEventListener("click", () => pick(info, +row.dataset.i, title)));
  }

  async function pick(info, i, title) {
    const o = info.options[i];
    setMenu('<div class="note">Opening…</div>');
    const res = await send({
      type: "promptVideo",
      payload: { url: curResolved || location.href, title, selector: o.selector, ext: o.ext, audio: !!o.audio, size: o.size || 0 }
    });
    if (!menu) return;
    const ok = res && (res.native || res.ok);
    setMenu('<div class="note' + (ok ? "" : " err") + '">' +
      (res && res.native ? "Opening download window…"
        : ok ? "Sent to D BOX ✓"
        : ("Failed: " + esc((res && res.error) || "error"))) + "</div>");
    setTimeout(closeMenu, ok ? 1500 : 3000);
  }

  async function tick() {
    const changed = location.href !== lastUrl;
    if (changed) { lastUrl = location.href; dismissed = false; closeMenu(); clearReady(); }
    const v = (dismissed || isFullscreen()) ? null : largestVideo(); // hide while a video is fullscreen
    if (!v || !(await dboxUp())) { hideAll(); curVideo = v; return; }
    ensureButton();
    btn.style.display = "inline-flex";
    curVideo = v;
    positionButton(v);
    // Let the URL settle one tick after a SPA navigation, then prefetch formats.
    if (!changed) warm(location.href);
  }
  setInterval(tick, 900);
  document.addEventListener("fullscreenchange", () => tick());
  document.addEventListener("webkitfullscreenchange", () => tick());
  addEventListener("scroll", (e) => {
    if (menu && inUI(e)) return; // scrolling the menu's own list
    if (btn && curVideo && btn.style.display !== "none") positionButton(curVideo);
  }, true);
  addEventListener("resize", () => { if (btn && curVideo) positionButton(curVideo); });
  addEventListener("click", (e) => { if (menu && !inUI(e)) closeMenu(); }, true);

  // ---- image hover download ------------------------------------------------
  let imgBtn = null, hovImg = null;
  function ensureImgBtn() {
    if (imgBtn) return imgBtn;
    imgBtn = document.createElement("div");
    imgBtn.className = "imgbtn";
    imgBtn.title = "Download image with D BOX";
    const ico = '<img src="' + chrome.runtime.getURL("icons/download.png") + '" alt="">';
    imgBtn.innerHTML = ico;
    imgBtn.addEventListener("click", async (e) => {
      e.stopPropagation(); e.preventDefault();
      if (!hovImg) return;
      const url = hovImg.currentSrc || hovImg.src;
      if (!url || /^data:|^blob:/.test(url)) return;
      imgBtn.textContent = "…";
      const name = ((url.split("/").pop() || "image").split("?")[0]) || "image";
      const res = await send({ type: "queueFile", payload: { url, fileName: name, category: "Images", referer: location.href } });
      imgBtn.textContent = res.ok ? "✓" : "✕";
      setTimeout(() => { if (imgBtn) imgBtn.innerHTML = ico; }, 1000);
    });
    ui().appendChild(imgBtn);
    return imgBtn;
  }
  function showImgBtn(img) {
    hovImg = img;
    ensureImgBtn();
    const r = img.getBoundingClientRect();
    imgBtn.style.display = "grid";
    imgBtn.style.top = (r.top + 6) + "px";
    imgBtn.style.left = (r.left + 6) + "px";
  }
  function hideImgBtn() { if (imgBtn) imgBtn.style.display = "none"; hovImg = null; }
  const ptIn = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  // Keep the "D BOX up?" flag warm so the hover check below is synchronous.
  // Image hover is a TOP-frame feature only.
  const refreshUp = () => send({ type: "status" }).then((r) => { upCache = { val: !!(r && r.ok), ts: Date.now() }; });
  if (isTop) { refreshUp(); setInterval(refreshUp, 5000); }

  // Track the cursor and find the image UNDER it via the element stack (works
  // through the overlay <div>s sites like Google Images stack on thumbnails).
  let lastMove = 0;
  if (isTop) document.addEventListener("mousemove", (e) => {
    const now = Date.now();
    if (now - lastMove < 60) return; // ~16fps
    lastMove = now;
    const x = e.clientX, y = e.clientY;
    if (hovImg) {
      if (ptIn(hovImg.getBoundingClientRect(), x, y)) return;
      if (imgBtn && ptIn(imgBtn.getBoundingClientRect(), x, y)) return;
      hideImgBtn();
    }
    if (!upCache.val) return;
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === host) return; // over our own overlay
      if (el instanceof HTMLImageElement) {
        const r = el.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 120 && el !== hovImg) showImgBtn(el);
        return;
      }
    }
  }, true);
  addEventListener("scroll", () => { if (hovImg) showImgBtn(hovImg); }, true);
})();
