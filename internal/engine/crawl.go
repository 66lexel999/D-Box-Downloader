package engine

// Page crawler — the JDownloader-style fallback for pages yt-dlp doesn't know.
//
// Most "random" video sites put the real stream in a player: an <iframe> to an
// embed host, a player config in inline JavaScript ({file:"…/master.m3u8"}),
// often packed with Dean Edwards' P.A.C.K.E.R. (`eval(function(p,a,c,k,e,d)…`)
// to hide it. yt-dlp answers "Unsupported URL" for such pages. The crawler
// fetches the page like a browser, unpacks packed scripts, collects media URLs
// (HLS, DASH, video/audio files) and player iframes, follows the iframes up to
// two levels (the embed page is where the stream usually is, and it must be
// requested with the embedding page as Referer), then checks candidates in
// order of likelihood until one actually answers like media.

import (
	"context"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"myidm/internal/ytdlp"
)

// foundMedia is what the crawler settled on.
type foundMedia struct {
	URL     string
	Referer string // the page the media was found on (what its server expects)
	Kind    string // kindHLS, kindFile, or "ytdlp" (an embed page / DASH yt-dlp can take)
	Title   string // the page's title, for naming
	Size    int64
	Video   *ytdlp.ProbeResult // formats, for Kind "ytdlp"
}

type mediaCand struct {
	url, kind, referer string // kind: kindHLS, kindDASH, kindFile, "audio", "embed"
	depth              int
}

var (
	crawlMediaRE = regexp.MustCompile(`(?i)(?:https?:)?//[^\s"'<>()\\]+?\.(m3u8|mpd|mp4|webm|mkv|m4v|mov|mp3|m4a)(?:\?[^\s"'<>\\]*)?`)
	crawlRelRE   = regexp.MustCompile(`(?i)["'](/[^"'\s<>]+?\.(m3u8|mpd|mp4|webm|mkv|m4v|mov|mp3|m4a)(?:\?[^"'\s<>]*)?)["']`)
	// Player iframes and the "server" lists sites use to switch players.
	crawlFrameRE = regexp.MustCompile(`(?is)<iframe\b[^>]*?\s(?:data-src|data-lazy-src|src)\s*=\s*["']([^"']+)["']`)
	crawlEmbedRE = regexp.MustCompile(`(?i)\sdata-(?:embed|url|link|src|video|server|player|frame)\s*=\s*["']((?:https?:)?//[^"']+)["']`)
	packerRE     = regexp.MustCompile(`\}\s*\(\s*'((?:[^'\\]|\\.)*)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\.split\(\s*'\|'\s*\)`)
	packerWordRE = regexp.MustCompile(`\b\w+\b`)
	ogTitleRE    = regexp.MustCompile(`(?is)<meta[^>]+property\s*=\s*["']og:title["'][^>]+content\s*=\s*["']([^"']+)["']`)
	titleRE      = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
)

// junkHosts are iframes that never hold the video (ads, analytics, widgets).
var junkHosts = []string{"doubleclick", "googlesyndication", "googletagmanager", "google-analytics",
	"facebook.com/plugins", "platform.twitter", "disqus", "recaptcha", "adsystem", "adservice",
	"popads", "propeller", "histats", "yandex.ru/metrika", "addthis", "sharethis", "cloudflareinsights"}

func junkURL(u string) bool {
	l := strings.ToLower(u)
	if !strings.HasPrefix(l, "http") {
		return true
	}
	for _, j := range junkHosts {
		if strings.Contains(l, j) {
			return true
		}
	}
	_, ext := splitExt(pathName(u))
	switch ext {
	case "js", "css", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "woff", "woff2":
		return true
	}
	return false
}

// findMedia crawls pageURL and returns the first candidate that answers like
// downloadable media, or nil.
func (e *Engine) findMedia(ctx context.Context, pageURL string, ri reqInfo) *foundMedia {
	cctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	cands, title := e.crawl(cctx, pageURL, ri, 0, map[string]bool{})
	// Likelihood order: streams, video files, player embeds (yt-dlp), audio last
	// (a page's ringtone/music player must not win over its video).
	rank := map[string]int{kindHLS: 0, kindDASH: 1, kindFile: 2, "embed": 3, "audio": 4}
	sortStable(cands, func(a, b mediaCand) bool { return rank[a.kind] < rank[b.kind] })
	tried := 0
	for _, c := range cands {
		if cctx.Err() != nil || tried >= 16 {
			break
		}
		tried++
		cri := reqInfo{Referer: c.referer, Headers: portableHeaders(ri.Headers, pageURL, c.url)}
		switch c.kind {
		case kindHLS:
			if _, _, err := e.fetchPlaylist(cctx, c.url, cri); err == nil {
				return &foundMedia{URL: c.url, Referer: c.referer, Kind: kindHLS, Title: title, Size: -1}
			}
		case kindDASH:
			if ytdlp.Available() {
				return &foundMedia{URL: c.url, Referer: c.referer, Kind: "ytdlp", Title: title, Size: -1}
			}
		case kindFile, "audio":
			pr, err := e.probe(cctx, c.url, cri, title)
			if err != nil {
				continue
			}
			switch {
			case pr.Kind == kindHLS:
				return &foundMedia{URL: c.url, Referer: pr.Referer, Kind: kindHLS, Title: title, Size: -1}
			case pr.Kind == kindFile && (pr.Size < 0 || pr.Size > 256<<10):
				return &foundMedia{URL: c.url, Referer: pr.Referer, Kind: kindFile, Title: title, Size: pr.Size}
			}
		case "embed":
			if !ytdlp.Available() || tried > 10 {
				continue
			}
			res, err := ytdlp.Probe(cctx, c.url, ytdlp.Opts{UserAgent: e.userAgent(), Referer: c.referer})
			if err == nil && res != nil && len(res.Options) > 0 {
				t := title
				if tt := cleanTitle(res.Title); tt != "" {
					t = tt
				}
				return &foundMedia{URL: c.url, Referer: c.referer, Kind: "ytdlp", Title: t, Size: -1, Video: res}
			}
		}
	}
	return nil
}

// crawl collects media candidates from a page and, up to two levels deep, from
// its player iframes. Returns candidates in discovery order and the page title.
func (e *Engine) crawl(ctx context.Context, pageURL string, ri reqInfo, depth int, seen map[string]bool) ([]mediaCand, string) {
	if depth > 2 || seen[pageURL] || len(seen) > 12 {
		return nil, ""
	}
	seen[pageURL] = true
	body, final, err := e.fetchText(ctx, pageURL, ri, 4<<20)
	if err != nil {
		return nil, ""
	}
	base, _ := url.Parse(final)
	title := pageTitleOf(body)

	text := body + "\n" + unpackAll(body)
	text = strings.NewReplacer(`\/`, `/`, `/`, `/`, `/`, `/`, `&`, `&`, `&amp;`, `&`).Replace(text)

	var out []mediaCand
	have := map[string]bool{}
	add := func(raw, kind string) {
		u := absURL(base, strings.TrimSpace(html.UnescapeString(raw)))
		if u == "" || have[u] || u == final {
			return
		}
		have[u] = true
		out = append(out, mediaCand{url: u, kind: kind, referer: final, depth: depth})
	}
	mediaKind := func(ext string) string {
		switch strings.ToLower(ext) {
		case "m3u8":
			return kindHLS
		case "mpd":
			return kindDASH
		case "mp3", "m4a":
			return "audio"
		}
		return kindFile
	}
	for _, m := range crawlMediaRE.FindAllStringSubmatch(text, 200) {
		add(m[0], mediaKind(m[1]))
	}
	for _, m := range crawlRelRE.FindAllStringSubmatch(text, 200) {
		add(m[1], mediaKind(m[2]))
	}
	var embeds []string
	for _, re := range []*regexp.Regexp{crawlFrameRE, crawlEmbedRE} {
		for _, m := range re.FindAllStringSubmatch(body, 40) {
			u := absURL(base, strings.TrimSpace(html.UnescapeString(m[1])))
			if u == "" || junkURL(u) || have[u] || u == final {
				continue
			}
			if k := mediaKind(extOfURL(u)); streamLike(u) {
				add(u, k) // a data-url pointing straight at media
				continue
			}
			add(u, "embed")
			embeds = append(embeds, u)
		}
	}
	// The player page is where the stream lives; it expects THIS page as Referer.
	for i, u := range embeds {
		if i >= 6 || ctx.Err() != nil {
			break
		}
		sub, _ := e.crawl(ctx, u, reqInfo{Referer: final, Headers: portableHeaders(ri.Headers, pageURL, u)}, depth+1, seen)
		for _, c := range sub {
			if !have[c.url] {
				have[c.url] = true
				out = append(out, c)
			}
		}
	}
	return out, title
}

// fetchText GETs a page (up to limit bytes) as the browser would.
func (e *Engine) fetchText(ctx context.Context, rawURL string, ri reqInfo, limit int64) (string, string, error) {
	req, err := e.newRequest(ctx, http.MethodGet, rawURL, ri)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	resp, err := e.client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", "", &httpStatusError{code: resp.StatusCode, status: resp.Status, challenge: isChallenge(resp)}
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit))
	if err != nil {
		return "", "", err
	}
	final := rawURL
	if resp.Request != nil && resp.Request.URL != nil {
		final = resp.Request.URL.String()
	}
	return string(b), final, nil
}

// unpackAll decodes every P.A.C.K.E.R.-packed script in a page.
func unpackAll(body string) string {
	var sb strings.Builder
	for _, m := range packerRE.FindAllStringSubmatch(body, 20) {
		sb.WriteString(unpack(m[1], m[2], m[3], m[4]))
		sb.WriteByte('\n')
	}
	return sb.String()
}

const packerDigits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

// unpack reverses Dean Edwards' packer: every word token in the payload is a
// base-radix index into the keyword list.
func unpack(payload, radixS, countS, keywords string) string {
	radix := atoiDefault(radixS, 36)
	if radix < 2 || radix > 62 {
		return ""
	}
	keys := strings.Split(unescapeJS(keywords), "|")
	payload = unescapeJS(payload)
	return packerWordRE.ReplaceAllStringFunc(payload, func(w string) string {
		n := 0
		for _, ch := range w {
			d := strings.IndexRune(packerDigits, ch)
			if d < 0 || d >= radix {
				return w
			}
			n = n*radix + d
		}
		if n < len(keys) && keys[n] != "" {
			return keys[n]
		}
		return w
	})
}

func unescapeJS(s string) string {
	return strings.NewReplacer(`\\`, `\`, `\'`, `'`, `\"`, `"`).Replace(s)
}

func atoiDefault(s string, def int) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return def
		}
		n = n*10 + int(c-'0')
	}
	if s == "" {
		return def
	}
	return n
}

// pageTitleOf returns a page's og:title or <title>.
func pageTitleOf(body string) string {
	for _, re := range []*regexp.Regexp{ogTitleRE, titleRE} {
		if m := re.FindStringSubmatch(body); m != nil {
			if t := strings.TrimSpace(html.UnescapeString(m[1])); t != "" {
				return strings.Join(strings.Fields(t), " ")
			}
		}
	}
	return ""
}

// absURL resolves ref against base (protocol-relative "//cdn/…" included).
func absURL(base *url.URL, ref string) string {
	if ref == "" || strings.HasPrefix(ref, "data:") || strings.HasPrefix(ref, "blob:") ||
		strings.HasPrefix(ref, "javascript:") || strings.HasPrefix(ref, "about:") {
		return ""
	}
	if base == nil {
		return ref
	}
	u, err := base.Parse(ref)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return ""
	}
	u.Fragment = ""
	return u.String()
}

func extOfURL(u string) string {
	_, ext := splitExt(pathName(u))
	return ext
}

// portableHeaders drops the headers that belong to the original site (its
// cookies and Origin) when a request goes to a different site.
func portableHeaders(h map[string]string, fromURL, toURL string) map[string]string {
	if len(h) == 0 || ytdlp.RegistrableDomain(fromURL) == ytdlp.RegistrableDomain(toURL) {
		return h
	}
	out := map[string]string{}
	for k, v := range h {
		if !strings.EqualFold(k, "Cookie") && !strings.EqualFold(k, "Origin") {
			out[k] = v
		}
	}
	return out
}

// sortStable is a tiny stable insertion sort (candidate lists are short).
func sortStable(c []mediaCand, less func(a, b mediaCand) bool) {
	for i := 1; i < len(c); i++ {
		for j := i; j > 0 && less(c[j], c[j-1]); j-- {
			c[j], c[j-1] = c[j-1], c[j]
		}
	}
}
