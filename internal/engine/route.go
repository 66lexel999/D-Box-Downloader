package engine

// Routing: the probe can discover that a "file" link is really something else.
// A web page (someone pasted the page, not the video) or a DASH manifest is
// handed to yt-dlp, which knows how to pull the media out; an HLS playlist is
// downloaded by the native HLS engine (hls.go). Either way the task keeps its
// id, folder and queue slot — only its Kind changes.

import (
	"context"
	"fmt"
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
