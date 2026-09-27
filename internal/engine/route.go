package engine

// Routing: the probe can discover that a "file" link is really something else.
// A web page (someone pasted the page, not the video) or a DASH manifest is
// handed to yt-dlp, which knows how to pull the media out; an HLS playlist is
// downloaded by the native HLS engine (hls.go). Either way the task keeps its
// id, folder and queue slot — only its Kind changes.

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"myidm/internal/ytdlp"
)

const needTools = `install D BOX with the "Video download tools" option, or put yt-dlp.exe next to DBox.exe`

// convertToVideo turns a probed page/DASH task into a yt-dlp task, asking
// yt-dlp for the real title and an estimated size so the row shows both before
// the transfer starts.
func (e *Engine) convertToVideo(ctx context.Context, t *Task, pr probeResult) error {
	if !ytdlp.Available() {
		if pr.Kind == kindDASH {
			return fmt.Errorf("this is a DASH (.mpd) video stream, which needs yt-dlp — %s", needTools)
		}
		return fmt.Errorf("this link opens a web page, not a file — to grab the video on it D BOX needs yt-dlp (%s)", needTools)
	}
	e.setNote(t, "Finding the video…")
	pctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	res, err := ytdlp.Probe(pctx, t.URL, e.ytdlpOpts(t))
	cancel()
	e.setNote(t, "")
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if pr.Kind == kindPage {
			return fmt.Errorf("no downloadable video found on this page (%v)", err)
		}
		return fmt.Errorf("yt-dlp: %v", err)
	}
	best := ytdlp.DownOption{Selector: "bv*+ba/b", Ext: "mp4"}
	if len(res.Options) > 0 {
		best = res.Options[0]
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	title := ""
	if t.FileName != "" { // the user named it in the New Download box
		if stem, _ := splitExt(t.FileName); !isGenericStem(stem) {
			title = stem
		}
	}
	if title == "" {
		title = cleanTitle(res.Title)
	}
	if title == "" {
		title = streamBaseName(t.Title, t.URL, t.Referer)
	}
	t.Kind = "ytdlp"
	t.Selector = best.Selector
	t.Audio = best.Audio
	t.Title = title
	t.FileName = SanitizeFileName(title) + "." + best.Ext
	t.Probed = true
	t.Size, t.SizeEstimated = -1, false
	t.Segments = []*Segment{{Start: 0, End: -1}}
	if best.Size > 0 {
		t.Size, t.SizeEstimated = best.Size, true
		t.Segments[0].End = best.Size - 1
	}
	e.saveLocked()
	return nil
}

// adoptStream turns a probed task into a native HLS task, naming it from the
// user's choice, the caller's title hint, or the page it came from — never the
// playlist's own "index.m3u8".
func (e *Engine) adoptStream(t *Task, pr probeResult) {
	e.mu.Lock()
	defer e.mu.Unlock()
	stem := ""
	if s, _ := splitExt(t.FileName); t.FileName != "" && !isGenericStem(s) {
		stem = s
	}
	if stem == "" {
		stem = streamBaseName(t.Title, t.URL, t.Referer) // the caller's referer, before it's replaced below
	}
	t.Kind = "hls"
	t.Referer = pr.Referer
	t.ContentType = pr.ContentType
	t.FileName = SanitizeFileName(stem) + ".mp4"
	t.Probed = true
	t.Size, t.SizeEstimated = -1, false
	t.Segments = []*Segment{{Start: 0, End: -1}}
	e.saveLocked()
}

// refused reports an HTTP refusal (auth, forbidden, rate limit, bot check)
// that yt-dlp — with browser impersonation — may get past.
func refused(err error) bool {
	var pe *probeStatusError
	if errors.As(err, &pe) {
		return pe.challenge || pe.code == http.StatusUnauthorized || pe.code == http.StatusForbidden || pe.code == http.StatusTooManyRequests
	}
	var he *httpStatusError
	if errors.As(err, &he) {
		return he.challenge || he.code == http.StatusUnauthorized || he.code == http.StatusForbidden || he.code == http.StatusTooManyRequests
	}
	return false
}

// streamLike reports URLs yt-dlp's generic extractor can take on directly:
// stream manifests and media files.
func streamLike(rawURL string) bool {
	_, ext := splitExt(pathName(rawURL))
	return mediaExts[ext] || ext == "m3u8" || ext == "mpd"
}

// handToYtdlp re-routes a stream/media task that the server refused to D BOX's
// own requests (typically a Cloudflare bot check) to yt-dlp, which retries as a
// real browser. Returns true when it took the task over (and drove it to a
// terminal state).
func (e *Engine) handToYtdlp(ctx context.Context, t *Task, cause error) bool {
	if !refused(cause) || !streamLike(t.URL) || !ytdlp.Available() {
		return false
	}
	e.mu.Lock()
	title := ""
	if s, _ := splitExt(t.FileName); t.FileName != "" && !isGenericStem(s) {
		title = s
	}
	if title == "" {
		title = streamBaseName(t.Title, t.URL, t.Referer)
	}
	t.Kind = "ytdlp"
	t.Selector = "bv*+ba/b"
	t.Audio = false
	t.Title = title
	t.FileName = SanitizeFileName(title) + ".mp4"
	t.Probed = true
	t.Live = false
	t.Size, t.SizeEstimated = -1, false
	t.Segments = []*Segment{{Start: 0, End: -1}}
	e.saveLocked()
	e.mu.Unlock()
	e.log.Info("server refused D BOX's requests; handing the stream to yt-dlp", "id", t.ID, "err", cause)
	e.runYtdlp(ctx, t)
	return true
}

// routePage handles a URL the probe found to be a web page or DASH manifest:
// yt-dlp first (it knows ~1800 sites), then D BOX's own page crawler for
// everything yt-dlp calls "Unsupported URL". Drives the task to a terminal state.
func (e *Engine) routePage(ctx context.Context, t *Task, pr probeResult) {
	err := e.convertToVideo(ctx, t, pr)
	if err == nil {
		e.log.Info("probed: handing to yt-dlp", "id", t.ID, "kind", pr.Kind, "file", t.FileName)
		e.runYtdlp(ctx, t)
		return
	}
	if ctx.Err() != nil {
		e.finishInterrupted(t)
		return
	}
	if pr.Kind == kindPage && e.crawlAndAdopt(ctx, t) {
		return
	}
	if ctx.Err() != nil {
		e.finishInterrupted(t)
		return
	}
	e.finishTask(t, err)
}

// pageExtractionFailed reports yt-dlp errors that mean "this page isn't a site
// I know / I found no video in it" — the cases the crawler can still solve.
func pageExtractionFailed(msg string) bool {
	m := strings.ToLower(msg)
	for _, s := range []string{"unsupported url", "no video formats", "unable to extract", "unable to find",
		"no media found", "no video could be found", "requested format is not available"} {
		if strings.Contains(m, s) {
			return true
		}
	}
	return false
}

// crawlAndAdopt searches the task's page for its video and, when it finds one,
// re-points the task at it and runs it. Returns true when it took the task
// over (the task has reached a terminal state).
func (e *Engine) crawlAndAdopt(ctx context.Context, t *Task) bool {
	e.mu.Lock()
	if t.crawled {
		e.mu.Unlock()
		return false
	}
	t.crawled = true
	page, ri := t.URL, t.reqInfo()
	e.mu.Unlock()

	e.setNote(t, "Searching the page for the video…")
	fm := e.findMedia(ctx, page, ri)
	e.setNote(t, "")
	if fm == nil {
		return false
	}
	e.adoptFound(ctx, t, page, fm)
	return true
}

// adoptFound re-points a task at media the crawler found and runs it.
func (e *Engine) adoptFound(ctx context.Context, t *Task, page string, fm *foundMedia) {
	e.mu.Lock()
	title := ""
	if s, _ := splitExt(t.FileName); t.FileName != "" && !isGenericStem(s) && t.Kind == "" {
		title = s // named by the user in the New Download window
	}
	if title == "" {
		title = cleanTitle(t.Title) // the title the user / extension gave the download
	}
	if title == "" {
		title = cleanTitle(fm.Title) // the page's own title
	}
	if title == "" {
		title = streamBaseName("", page, t.Referer)
	}
	t.Headers = portableHeaders(t.Headers, page, fm.URL)
	t.URL = fm.URL
	t.Referer = fm.Referer
	t.Title = title
	t.Live = false
	t.Size, t.SizeEstimated = -1, false
	t.Segments = []*Segment{{Start: 0, End: -1}}
	switch fm.Kind {
	case kindHLS:
		t.Kind = "hls"
		t.FileName = SanitizeFileName(title) + ".mp4"
		t.Probed = true
	case kindFile:
		// Media URLs found in players are rarely named ("4f9a.mp4?token=…"): name
		// it after the title; runHTTP's probe adds the real extension.
		t.Kind = ""
		t.FileName = SanitizeFileName(title)
		t.Probed = false
	default: // "ytdlp": an embed page or DASH manifest yt-dlp can take
		best := ytdlp.DownOption{Selector: "bv*+ba/b", Ext: "mp4"}
		if fm.Video != nil && len(fm.Video.Options) > 0 {
			best = fm.Video.Options[0]
		}
		t.Kind = "ytdlp"
		t.Selector = best.Selector
		t.Audio = best.Audio
		t.FileName = SanitizeFileName(title) + "." + best.Ext
		t.Probed = true
		if best.Size > 0 {
			t.Size, t.SizeEstimated = best.Size, true
			t.Segments[0].End = best.Size - 1
		}
	}
	e.saveLocked()
	e.mu.Unlock()
	e.log.Info("page crawler found the media", "id", t.ID, "page", page, "media", fm.URL, "kind", fm.Kind)

	switch t.Kind {
	case "hls":
		e.runHLS(ctx, t)
	case "ytdlp":
		e.runYtdlp(ctx, t)
	default:
		e.runHTTP(ctx, t)
	}
}
