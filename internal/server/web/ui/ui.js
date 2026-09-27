/* D BOX shared UI runtime, loaded in <head> of every window (main, New
   Download, status, completion):
   - applies the saved theme before first paint (no flash);
   - the inline SVG icon set (24×24, stroke-based) used everywhere instead of
     emoji, which render differently on every Windows build;
   - category artwork (icon + tone), and the app logo. */
(function () {
  "use strict";

  // ---- theme ---------------------------------------------------------------
  // Stored by the main window's Appearance panel. Old builds stored graphite /
  // ocean / forest; they all map to the default dark theme now.
  var THEMES = ["dark", "midnight", "light"];
  function themeId() {
    try {
      var t = localStorage.getItem("dbox.ui.theme") || "";
      return THEMES.indexOf(t) > 0 ? t : "dark";
    } catch (e) { return "dark"; }
  }
  function applyTheme(id) {
    if (THEMES.indexOf(id) <= 0) { id = "dark"; document.documentElement.removeAttribute("data-theme"); }
    else document.documentElement.setAttribute("data-theme", id);
    try { localStorage.setItem("dbox.ui.theme", id); } catch (e) {}
  }
  if (themeId() !== "dark") document.documentElement.setAttribute("data-theme", themeId());

  // ---- icons ---------------------------------------------------------------
  var F = ' fill="currentColor" stroke="none"';
  var P = {
    download: '<path d="M12 4v11M7 10.5l5 5 5-5"/><path d="M5 20h14"/>',
    arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    update: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v8M8.5 12.5l3.5 3.5 3.5-3.5"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    magnet: '<path d="M6 3.5h4v7a2 2 0 0 0 4 0v-7h4v7a6 6 0 0 1-12 0z"/><path d="M6 7.5h4M14 7.5h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    play: '<path' + F + ' d="M8 5.8v12.4a.9.9 0 0 0 1.4.8l9.8-6.2a.9.9 0 0 0 0-1.6L9.4 5A.9.9 0 0 0 8 5.8z"/>',
    pause: '<rect x="6.5" y="5" width="3.8" height="14" rx="1.2"' + F + '/><rect x="13.7" y="5" width="3.8" height="14" rx="1.2"' + F + '/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"' + F + '/>',
    stopAll: '<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1.2"' + F + '/>',
    startAll: '<path d="M3.5 6.6v10.8a.8.8 0 0 0 1.3.6L12 13.2v4.2a.8.8 0 0 0 1.3.6l7.4-5.4a.8.8 0 0 0 0-1.2l-7.4-5.4a.8.8 0 0 0-1.3.6v4.2L4.8 6a.8.8 0 0 0-1.3.6z"/>',
    skip: '<path d="M5.5 6.2v11.6a.8.8 0 0 0 1.3.6l8.2-5.8a.8.8 0 0 0 0-1.2L6.8 5.6a.8.8 0 0 0-1.3.6z"/><path d="M18.5 5v14"/>',
    retry: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5v5h-5"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4.5v5h-5"/>',
    trash: '<path d="M4 6.5h16"/><path d="M9 6.5V4h6v2.5"/><path d="M6 6.5l1 13.2a2 2 0 0 0 2 1.8h6a2 2 0 0 0 2-1.8l1-13.2"/><path d="M10 11v6M14 11v6"/>',
    broom: '<path d="M20 3l-7 7"/><path d="M10.5 8.5l5 5-2.3 6.5c-2.7-.6-6.9-3.3-8.7-6.7z"/><path d="M8 16.5l-1.8 1.8"/><path d="M10.5 18.5l-1 1"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="M8 12.3l2.7 2.7L16 9.5"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
    warn: '<path d="M10.3 4.3L2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4M12 17v.01"/>',
    xCircle: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    alarm: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.4 1.6M4.5 5.5l3-2.5M19.5 5.5l-3-2.5"/>',
    later: '<path d="M20 11.5V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h5.5"/><path d="M4 9.5h16M8 3v4M16 3v4"/><circle cx="17.5" cy="17.5" r="4"/><path d="M17.5 15.8v1.9l1.2.8"/>',
    hourglass: '<path d="M6.5 3h11M6.5 21h11"/><path d="M7.5 3v3.2a4.5 4.5 0 0 0 1.9 3.7L12 12l2.6-2.1a4.5 4.5 0 0 0 1.9-3.7V3M7.5 21v-3.2a4.5 4.5 0 0 1 1.9-3.7L12 12l2.6 2.1a4.5 4.5 0 0 1 1.9 3.7V21"/>',
    inbox: '<path d="M3.5 13.5l2.6-7.2A2 2 0 0 1 8 5h8a2 2 0 0 1 1.9 1.3l2.6 7.2"/><path d="M3.5 13.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4.5h-5l-1.5 2.5h-4l-1.5-2.5z"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
    folderOpen: '<path d="M3 17.5V7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h6.5A2.5 2.5 0 0 1 20 9.5V10"/><path d="M3 17.5l2.2-6A2 2 0 0 1 7.1 10H20a1.5 1.5 0 0 1 1.4 2l-2.1 6.2a2.5 2.5 0 0 1-2.3 1.8H5.5A2.5 2.5 0 0 1 3 17.5z"/>',
    move: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M9 13.5h6M12.5 11l2.5 2.5-2.5 2.5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    open: '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
    pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
    save: '<path d="M5 3.5h11l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3.5 19V5A1.5 1.5 0 0 1 5 3.5z"/><path d="M7.5 3.5v5h8v-5M7.5 20.5v-6h9v6"/>',
    eye: '<path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z"/><circle cx="12" cy="12" r="3"/>',
    palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"' + F + '/><circle cx="10" cy="7.3" r="1.2"' + F + '/><circle cx="14.5" cy="7.3" r="1.2"' + F + '/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
    power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3.6 3.2 14.4 0 18M12 3c-3.2 3.6-3.2 14.4 0 18"/>',
    bolt: '<path d="M13 2.5L4.5 14H11l-1 7.5L18.5 10H12z"/>',
    gauge: '<path d="M4 17.5a8.6 8.6 0 1 1 16 0"/><path d="M12 13.5l4.2-4.2"/><circle cx="12" cy="13.5" r="1.5"' + F + '/>',
    stream: '<circle cx="12" cy="12" r="2.2"' + F + '/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
    chart: '<path d="M4 19.5h16"/><path d="M7 16v-5M12 16V6.5M17 16v-8"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    chevronDown: '<path d="M6 9l6 6 6-6"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    more: '<circle cx="5" cy="12" r="1.3"' + F + '/><circle cx="12" cy="12" r="1.3"' + F + '/><circle cx="19" cy="12" r="1.3"' + F + '/>',
    puzzle: '<path d="M10 4a2 2 0 1 1 4 0v2h3a1 1 0 0 1 1 1v3h2a2 2 0 1 1 0 4h-2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 1 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 1 0 0-4H5V7a1 1 0 0 1 1-1h4z"/>',
    // categories
    archive: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    music: '<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.2v5.6l4.8-2.8z"' + F + '/>',
    app: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18"/><circle cx="6.3" cy="6.5" r=".7"' + F + '/><circle cx="8.8" cy="6.5" r=".7"' + F + '/><path d="M8 13.5h8M8 16.5h5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9.5 9"/>'
  };

  function icon(name, size, cls) {
    size = size || 18;
    return '<svg class="icon' + (cls ? " " + cls : "") + '" width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (P[name] || P.info) + "</svg>";
  }

  // ---- categories ----------------------------------------------------------
  var CATS = {
    General:    { icon: "folder",  tone: "#e8b84a" },
    Compressed: { icon: "archive", tone: "#f7931e" },
    Documents:  { icon: "doc",     tone: "#6aa6ff" },
    Music:      { icon: "music",   tone: "#ff6b9a" },
    Video:      { icon: "video",   tone: "#9085e9" },
    Programs:   { icon: "app",     tone: "#3fd06f" },
    Images:     { icon: "image",   tone: "#34c6b5" }
  };
  function cat(name) { return CATS[name] || { icon: "folder", tone: "#9a9a9a" }; }
  // A rounded, tinted tile holding the category's icon — the stand-in file icon
  // for rows whose file isn't on disk yet.
  function catTile(name, size, cls) {
    var c = cat(name); size = size || 32;
    return '<span class="ctile' + (cls ? " " + cls : "") + '" style="--tone:' + c.tone + ';width:' + size + 'px;height:' + size + 'px">' +
      icon(c.icon, Math.round(size * 0.58)) + "</span>";
  }
  function catIcon(name, size) {
    var c = cat(name);
    return '<span class="cicon" style="color:' + c.tone + '">' + icon(c.icon, size || 18) + "</span>";
  }

  // ---- logo ----------------------------------------------------------------
  var logoN = 0;
  function logo(size) {
    var id = "dbxg" + (++logoN);
    return '<svg class="logo" width="' + size + '" height="' + size + '" viewBox="0 0 256 256" aria-hidden="true">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4fe38a"/><stop offset="1" stop-color="#17a049"/></linearGradient></defs>' +
      '<rect width="256" height="256" rx="58" fill="url(#' + id + ')"/>' +
      '<path d="M40 132h176v58a30 30 0 0 1-30 30H70a30 30 0 0 1-30-30z" fill="#fff"/>' +
      '<path d="M128 30v84M92 82l36 36 36-36" fill="none" stroke="#fff" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  // Replace <i data-ic="name" data-sz="18"></i> placeholders in static markup.
  function hydrate(root) {
    var els = (root || document).querySelectorAll("i[data-ic]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i], span = document.createElement("span");
      span.className = "ic" + (el.className ? " " + el.className : "");
      span.innerHTML = el.dataset.ic === "logo" ? logo(+el.dataset.sz || 24) : icon(el.dataset.ic, +el.dataset.sz || 18);
      el.replaceWith(span);
    }
  }

  window.DBOX = { icon: icon, cat: cat, catTile: catTile, catIcon: catIcon, logo: logo, hydrate: hydrate,
    themeId: themeId, applyTheme: applyTheme, THEMES: THEMES };
})();
