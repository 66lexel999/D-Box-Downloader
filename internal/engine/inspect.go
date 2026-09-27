package engine

import "context"

// InspectResult is what the New Download dialog shows before a download starts:
// the real file name, size and kind, found by the same probe the download uses.
// (The dialog used to HEAD the URL from the page itself, which the browser's
// CORS rules block for nearly every site — hence "unknown" sizes and raw URL
// names like "videoplayback".)
type InspectResult struct {
	URL           string  `json:"url"`
	Kind          string  `json:"kind"` // file | hls | dash | page
	FileName      string  `json:"fileName"`
	Size          int64   `json:"size"` // -1 unknown
	SizeEstimated bool    `json:"sizeEstimated,omitempty"`
	ContentType   string  `json:"contentType,omitempty"`
	Resumable     bool    `json:"resumable"`
	Live          bool    `json:"live,omitempty"`
	Duration      float64 `json:"duration,omitempty"` // seconds (streams)
}

// Inspect probes rawURL without creating a task.
func (e *Engine) Inspect(ctx context.Context, rawURL, referer string, headers map[string]string, title string) (InspectResult, error) {
	u, err := parseDownloadURL(rawURL)
	if err != nil {
		return InspectResult{}, err
	}
	ri := reqInfo{Referer: cleanReferer(referer), Headers: CleanHeaders(headers)}
	pr, err := e.probe(ctx, u.String(), ri, title)
	if err != nil {
		return InspectResult{}, err
	}
	res := InspectResult{URL: u.String(), Kind: pr.Kind, FileName: pr.FileName, Size: pr.Size,
		ContentType: pr.ContentType, Resumable: pr.Ranged}
	if pr.Kind != kindHLS {
		return res, nil
	}

	// A stream: name it from the page/title, and estimate its size from the
	// best variant's bitrate × duration (one or two small playlist fetches).
	res.FileName = streamBaseName(title, u.String(), ri.Referer) + ".mp4"
	res.Size, res.Resumable = -1, true
	ri.Referer = pr.Referer
	top, _, err := e.fetchPlaylist(ctx, u.String(), ri)
	if err != nil {
		return res, nil // still a stream; details unknown
	}
	media, bandwidth := top, int64(0)
	if top.Master {
		v, ok := pickVariant(top.Variants)
		if !ok {
			return res, nil
		}
		bandwidth = v.Bandwidth
		if media, _, err = e.fetchPlaylist(ctx, v.URI, ri); err != nil {
			return res, nil
		}
	}
	res.Live = media.live()
	res.Duration = media.duration()
	if res.Live {
		res.Resumable = false
		return res, nil
	}
	var known int64
	allKnown := len(media.Segments) > 0
	for _, s := range media.Segments {
		if s.Len < 0 {
			allKnown = false
			break
		}
		known += s.Len
	}
	switch {
	case allKnown:
		res.Size, res.SizeEstimated = known, true
	case bandwidth > 0 && res.Duration > 0:
		res.Size, res.SizeEstimated = int64(float64(bandwidth)/8*res.Duration), true
	}
	for _, s := range media.Segments {
		if s.Key != nil && s.Key.Method != "AES-128" {
			res.Kind = "drm"
			break
		}
	}
	return res, nil
}

// PageMedia is what the page crawler found for the New Download window.
type PageMedia struct {
	URL   string `json:"url"`
	Kind  string `json:"kind"` // hls | file | ytdlp
	Title string `json:"title,omitempty"`
	Size  int64  `json:"size"`
}

// FindOnPage runs the page crawler (the fallback for pages yt-dlp doesn't
// know) and reports what it would download, or nil.
func (e *Engine) FindOnPage(ctx context.Context, rawURL, referer string, headers map[string]string) *PageMedia {
	u, err := parseDownloadURL(rawURL)
	if err != nil {
		return nil
	}
	fm := e.findMedia(ctx, u.String(), reqInfo{Referer: cleanReferer(referer), Headers: CleanHeaders(headers)})
	if fm == nil {
		return nil
	}
	pm := &PageMedia{URL: fm.URL, Kind: fm.Kind, Title: cleanTitle(fm.Title), Size: fm.Size}
	if fm.Video != nil && len(fm.Video.Options) > 0 && fm.Video.Options[0].Size > 0 {
		pm.Size = fm.Video.Options[0].Size
	}
	return pm
}
