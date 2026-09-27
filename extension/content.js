// MyIDM grab overlay: a floating "Download this video" button (IDM-style) on
// pages with a video, whose dropdown lists qualities from MyIDM's yt-dlp probe;
// plus a hover "download" badge on large images. All network work is proxied
// through the background page (which holds the MyIDM host permission).
(function () {
  "use strict";
  const isTop = window.top === window;
  // Runs in ALL frames now (all_frames:true). An iframe-embedded player — a
  // uqload/streamtape/dood/etc. <video> that lives in its OWN frame, which IDM
  // catches via the network but a top-frame-only DOM scan never sees — now gets
  // the button too, and probes THIS frame's URL (the embed URL yt-dlp resolves).
  // Skip frames too small to hold a real player (ad/pixel iframes) to stay light.
  if (!isTop && innerWidth && innerHeight && (innerWidth < 320 || innerHeight < 180)) return;

  let btn = null, menu = null, curVideo = null, dismissed = false, lastUrl = location.href;
  let curResolved = location.href; // the URL the successful probe actually resolved (frame or top page)
  let upCache = { val: false, ts: 0 };
  // Prefetched probe results, keyed by URL. We warm this when a video's button
  // appears so clicking opens the quality menu instantly instead of waiting on
  // yt-dlp. Failures are retried after a short cooldown (not hammered).
  const probeCache = new Map(); // url -> { p, ts, ok, msg }

  function warm(url) {
    const e = probeCache.get(url);
    // Reuse while in flight (ok===undefined), on success, or during the cooldown.
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
    btn.title = "Formats ready — click to pick a quality";
  }
  function clearReady() { if (btn) btn.classList.remove("ready"); }

  function send(msg) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false })); }
      catch { resolve({ ok: false }); }
    });
  }
  async function myidmUp() {
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
  const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);

  // ---- video button -------------------------------------------------------
  // Many modern players (Reddit's shreddit-player, some site players) render
  // <video> inside SHADOW DOM, which a plain document.querySelectorAll can't
  // see. The light-DOM scan is tried first (cheap, covers most sites); when it
  // finds nothing, a one-level-deeper recursive shadow scan runs so the button
  // appears over shadow-hosted players too.
  function videosInShadow(root, out) {
    for (const el of root.querySelectorAll("*")) {
      const sr = el.shadowRoot;
      if (!sr) continue;
      for (const v of sr.querySelectorAll("video")) out.push(v);
      videosInShadow(sr, out); // nested shadow roots
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

  function ensureButton() {
    if (btn) return btn;
    btn = document.createElement("div");
    btn.className = "myidm-vbtn";
    btn.innerHTML =
      '<img class="play" src="' + chrome.runtime.getURL("icons/download.png") + '" alt="">' +
      '<span class="mini close" title="Hide">&#10005;</span>';
    btn.title = "Download this video — click to pick a quality";
    // The whole button is the click target (icon, label area, padding) — not just
    // the icon. The X stops propagation so it hides instead of opening the menu.
    btn.addEventListener("click", onOpen);
    btn.querySelector(".close").addEventListener("click", (e) => {
      e.stopPropagation(); dismissed = true; hideAll();
    });
    document.documentElement.appendChild(btn);
    return btn;
  }
  function positionButton(v) {
    const r = v.getBoundingClientRect();
    const w = btn.offsetWidth || 52; // icon + X is compact now; place it at the video's top-right
    btn.style.top = Math.max(6, r.top + 8) + "px";
    btn.style.left = Math.min(innerWidth - w - 8, r.right - w - 6) + "px";
  }
  function closeMenu() { if (menu) { menu.remove(); menu = null; } }
  function hideAll() { if (btn) btn.style.display = "none"; closeMenu(); }

  async function onOpen(e) {
    e.stopPropagation();
    if (menu) { closeMenu(); return; }
    menu = document.createElement("div");
    menu.className = "myidm-vmenu";
    const r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 4) + "px";
    menu.style.left = Math.min(innerWidth - 320, r.left) + "px";
    document.documentElement.appendChild(menu);

    // Prefetched? Render immediately — no "Probing…" flash.
    const cached = cachedMsg(location.href);
    if (cached) { renderMenu(cached.result); return; }

    menu.innerHTML = '<div class="msg">Probing formats…</div>';
    const res = await warm(location.href);
    if (!menu) return;
    if (!res || !res.ok) {
      const err = (res && res.error) || "";
      // IDM-style fallback: yt-dlp couldn't handle this URL (uqload, streamtape,
      // random custom players…) but the browser DID load the real media. Ask
      // the background what it sniffed off the network and offer THAT.
      const sn = await send({ type: "sniffed" });
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
        m = "Couldn’t read this video: try playing it once (D BOX watches the network), then click here again. " + err;
      }
      menu.innerHTML = '<div class="msg err">' + esc(m) + '</div>';
      return;
    }
    renderMenu(res.result);
  }

  // renderSniffed shows the direct media URLs the background captured off the
  // network — IDM's mechanism. HLS/DASH manifests get handed to yt-dlp (which
  // does handle raw manifests); direct .mp4/.mkv/.mp3/etc. queue as plain files;
  // subtitles queue as plain files too. Titled by the page for clarity.
  function renderSniffed(streams) {
    const title = (document.title || "video").replace(/\s+-\s+YouTube$/, "").trim();
    let html = '<div class="head">' + esc(title) + '</div>' +
               '<div class="msg" style="font-size:11px;opacity:.7">Streams captured from the page:</div>';
    streams.forEach((s, i) => {
      const label = s.kind === "hls" ? "Video stream (" + s.ext.toUpperCase() + ")"
                  : s.kind === "sub" ? s.ext.toUpperCase() + " subtitles"
                  : "Direct file (" + s.ext.toUpperCase() + ")";
      const sz = s.size ? humanBytes(s.size) : "";
      html += '<div class="row" data-si="' + i + '"><span class="n">' + (i + 1) +
        '.</span><span class="lbl">' + esc(label) + '</span>' +
        (sz ? '<span class="sz">' + sz + '</span>' : '') + '</div>';
    });
    menu.innerHTML = html;
    menu.querySelectorAll("[data-si]").forEach((row) =>
      row.addEventListener("click", () => pickSniffed(streams[+row.dataset.si], title)));
  }

  // pickSniffed downloads a captured stream. HLS gets fed to yt-dlp via the
  // video path (it handles manifests). Progressive files/subtitles are queued
  // directly through /api/tasks — no yt-dlp needed.
  async function pickSniffed(s, title) {
    menu.innerHTML = '<div class="msg">Opening…</div>';
    if (s.kind === "hls") {
      const res = await send({
        type: "promptVideo",
        payload: { url: s.url, title, selector: "b", ext: s.ext === "mpd" ? "mp4" : "mp4", audio: false }
      });
      const ok = res && (res.native || res.ok);
      menu.innerHTML = '<div class="msg' + (ok ? '' : ' err') + '">' +
        (res && res.native ? "Opening download window…"
          : ok ? "Sent to D BOX ✓"
          : ("Failed: " + esc((res && res.error) || "error"))) + '</div>';
      setTimeout(closeMenu, ok ? 1500 : 3000);
      return;
    }
    // Progressive file / subtitle: queue as a plain download.
    const name = ((s.url.split("?")[0].split("/").pop()) || (title + "." + s.ext)).replace(/[<>:"/\\|?*]+/g, "_");
    const cat = s.kind === "sub" ? "Documents" : (s.ext === "mp3" || s.ext === "m4a" ? "Music" : "Video");
    const res = await send({ type: "queueFile", payload: { url: s.url, fileName: name, category: cat } });
    const ok = res && res.ok;
    menu.innerHTML = '<div class="msg' + (ok ? '' : ' err') + '">' +
      (ok ? "Sent to D BOX ✓" : ("Failed: " + esc((res && res.error) || "error"))) + '</div>';
    setTimeout(closeMenu, ok ? 1500 : 3000);
  }

  function humanBytes(n) {
    if (!n || n < 0) return "";
    const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i && n < 10 ? 1 : 0) + " " + u[i];
  }
  function renderMenu(info) {
    const title = (info.title || document.title.replace(/\s*-\s*YouTube$/, "")).trim();
    let html = '<div class="head">' + esc(title) + '</div>';
    if (!(info.options || []).length) {
      menu.innerHTML = html + '<div class="msg">No downloadable formats found for this video.</div>';
      return;
    }
    (info.options || []).forEach((o, i) => {
      const lbl = esc(String(o.label || "").replace(/\s*\(~[^)]*\)\s*$/, "")); // size shown in its own column
      const sz = humanBytes(o.size);
      html += '<div class="row" data-i="' + i + '"><span class="n">' + (i + 1) +
        '.</span><span class="lbl">' + lbl + '</span>' +
        (sz ? '<span class="sz">' + sz + '</span>' : '') + '</div>';
    });
    menu.innerHTML = html;
    menu.querySelectorAll(".row").forEach((row) =>
      row.addEventListener("click", () => pick(info, +row.dataset.i, title)));
  }

  async function pick(info, i, title) {
    const o = info.options[i];
    menu.innerHTML = '<div class="msg">Opening…</div>';
    // Ask MyIDM to open its "New Download" window (pick folder, Start/Cancel);
    // if MyIDM is headless it falls back to queueing the download directly.
    const res = await send({
      type: "promptVideo",
      payload: { url: curResolved || location.href, title, selector: o.selector, ext: o.ext, audio: !!o.audio }
    });
    if (!menu) return;
    const ok = res && (res.native || res.ok);
    menu.innerHTML = '<div class="msg' + (ok ? '' : ' err') + '">' +
      (res && res.native ? "Opening download window…"
        : ok ? "Sent to MyIDM ✓"
        : ("Failed: " + esc((res && res.error) || "error"))) + '</div>';
    setTimeout(closeMenu, ok ? 1500 : 3000);
  }

  async function tick() {
    const changed = location.href !== lastUrl;
    if (changed) { lastUrl = location.href; dismissed = false; closeMenu(); clearReady(); }
    const v = (dismissed || isFullscreen()) ? null : largestVideo(); // hide while a video is fullscreen
    if (!v || !(await myidmUp())) { hideAll(); curVideo = v; return; }
    ensureButton();
    btn.style.display = "inline-flex";
    curVideo = v;
    positionButton(v);
    // Let the URL settle one tick after a SPA navigation, then prefetch formats
    // so the menu opens instantly when clicked. warm() dedups per URL.
    if (!changed) warm(location.href);
  }
  setInterval(tick, 900);
  // Hide on entering fullscreen video and restore on exit — instantly, not on the
  // next 900ms tick.
  document.addEventListener("fullscreenchange", () => tick());
  document.addEventListener("webkitfullscreenchange", () => tick());
  addEventListener("scroll", () => {
    if (btn && curVideo && btn.style.display !== "none") positionButton(curVideo);
  }, true);
  addEventListener("resize", () => { if (btn && curVideo) positionButton(curVideo); });
  addEventListener("click", (e) => {
    if (menu && (!btn || (!menu.contains(e.target) && !btn.contains(e.target)))) closeMenu();
  }, true);

  // ---- image hover download ----------------------------------------------
  let imgBtn = null, hovImg = null;
  function ensureImgBtn() {
    if (imgBtn) return imgBtn;
    imgBtn = document.createElement("div");
    imgBtn.className = "myidm-imgbtn";
    imgBtn.title = "Download image with MyIDM";
    const ico = '<img src="' + chrome.runtime.getURL("icons/download.png") + '" alt="">';
    imgBtn.innerHTML = ico;
    imgBtn.addEventListener("click", async (e) => {
      e.stopPropagation(); e.preventDefault();
      if (!hovImg) return;
      const url = hovImg.currentSrc || hovImg.src;
      if (!url || /^data:|^blob:/.test(url)) return;
      imgBtn.textContent = "…";
      const name = ((url.split("/").pop() || "image").split("?")[0]) || "image";
      const res = await send({ type: "queueFile", payload: { url, fileName: name, category: "Images" } });
      imgBtn.textContent = res.ok ? "✓" : "✕";
      setTimeout(() => { if (imgBtn) imgBtn.innerHTML = ico; }, 1000);
    });
    document.documentElement.appendChild(imgBtn);
    return imgBtn;
  }
  function showImgBtn(img) {
    hovImg = img;
    ensureImgBtn();
    const r = img.getBoundingClientRect();
    imgBtn.style.display = "grid";
    imgBtn.style.top = (scrollY + r.top + 6) + "px";
    imgBtn.style.left = (scrollX + r.left + 6) + "px";
  }
  function hideImgBtn() { if (imgBtn) imgBtn.style.display = "none"; hovImg = null; }
  const ptIn = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

  // Keep the "MyIDM up?" flag warm in the background so the hover check below is
  // synchronous — the old per-hover `await` raced and sometimes never showed.
  // Image hover is a TOP-frame feature only: no per-frame status pinging in the
  // dozens of sub-frames a page may have.
  const refreshUp = () => send({ type: "status" }).then((r) => { upCache = { val: !!(r && r.ok), ts: Date.now() }; });
  if (isTop) { refreshUp(); setInterval(refreshUp, 5000); }

  // Google Images stacks overlay <div>s on top of every thumbnail, which stole the
  // hover from the <img> and made the button flash in for a moment then vanish (or
  // never appear). So instead of mouseover/mouseout we track the cursor: find the
  // image UNDER it via the element stack (works through overlays), and hold the
  // button while the cursor stays within that image's box — or over the button.
  let lastMove = 0;
  if (isTop) document.addEventListener("mousemove", (e) => {
    const now = Date.now();
    if (now - lastMove < 60) return; // throttle to ~16fps
    lastMove = now;
    const x = e.clientX, y = e.clientY;
    if (hovImg) {
      if (ptIn(hovImg.getBoundingClientRect(), x, y)) return;           // still over the image
      if (imgBtn && ptIn(imgBtn.getBoundingClientRect(), x, y)) return; // still over the button
      hideImgBtn();
    }
    if (!upCache.val) return;
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === imgBtn || (imgBtn && imgBtn.contains(el))) return;     // over the button
      if (el instanceof HTMLImageElement) {
        const r = el.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 120 && el !== hovImg) showImgBtn(el);
        return; // the topmost image at the cursor decides
      }
    }
  }, true);
})();
