D BOX 1.2.0

• A brand-new look: every window was redesigned — a sidebar with Downloads and
  Categories sections, a big paste-a-link bar, a clean list with progress bars
  and one-click actions (pause, resume, retry, show in folder), a live progress
  ring with speed and time left, and search. Dark (default), Midnight and Light
  themes under Menu → Appearance.
• New icons everywhere: a new D BOX app icon and a crisp icon set for the
  toolbar, menus, categories and dialogs (no more emoji that looked different
  on every PC).
• The New Download, download status and Download complete windows were
  redesigned to match, and the completion window shows the file's real icon.
• Browser extension 3.3.0: the video Download button, its quality menu, the
  toolbar popup and the settings page have the new look too.

D BOX 1.1.1

• Sites yt-dlp doesn't know ("Unsupported URL") now download: D BOX searches
  the page itself — player iframes, player scripts (even packed/obfuscated
  ones) and direct stream links — like JDownloader.
• Fixed videos in embedded players downloading the wrong thing (only audio, or
  "Unsupported URL"): the browser extension now downloads the player it
  actually found, with the page as Referer. Update the extension to 3.2.1.
• The extension's video menu now also lists the streams the page played, so
  the real stream is always one click away.

D BOX 1.1.0

• Downloads almost anything: video streams (HLS / .m3u8) are now downloaded as
  real videos — best quality, with sound, encrypted (AES-128) streams included —
  instead of a tiny playlist file. Live streams are recorded; press Pause to
  stop and save the recording.
• Paste a web page and D BOX finds the video on it (via yt-dlp), with its real
  title and size. DASH (.mpd) streams work the same way.
• Proper file names: no more "videoplayback", "index.m3u8", "download.php" or
  random hash names — D BOX reads the server's name, the original link, signed
  cloud links, the page title and the file's contents, and adds the missing
  extension.
• Sizes: the New Download window now shows the real size (it used to say
  "unknown" for most sites), streams show an estimate (~), and files whose size
  the server hides show how much has arrived.
• Files that "couldn't be downloaded": fixed hotlink-protected files (the page's
  Referer and cookies are now sent), servers with weak ETags (downloads failed
  on the second connection), servers that refuse range requests, and files
  that changed on the server (now restart instead of failing forever).
• ffmpeg is fetched automatically the first time a video needs merging or
  converting (one-time download, ~190 MB). Without it, videos are no longer
  saved without sound.
• Fixed: download rows could show the icon of a previously downloaded program
  at the same path, and the New Download / status / complete windows had no
  D BOX icon.
