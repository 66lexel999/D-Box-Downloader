package engine

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// probeResult describes what the server told us about the resource.
type probeResult struct {
	Size         int64 // -1 unknown
	Ranged       bool
	FileName     string // best file name for a plain file download
	ETag         string
	LastModified string
	ContentType  string
	Kind         string // kindFile / kindHLS / kindDASH / kindPage
	FinalURL     string // after redirects
	Referer      string // the Referer that got the server to answer
}

// sniffLen is how many leading bytes the probe asks for: enough for every magic
// signature and to recognize an HLS/DASH manifest or an HTML page, small
// enough to cost nothing.
const sniffLen = 4096

// probeStatusError is a non-success HTTP answer to the probe.
type probeStatusError struct {
	code      int
	status    string
	challenge bool // Cloudflare answered with a bot check ("cf-mitigated: challenge")
}

func (p *probeStatusError) Error() string {
	msg := "server returned " + p.status
	if p.challenge {
		return msg + " — the site's Cloudflare bot check blocked the request"
	}
	switch p.code {
	case http.StatusUnauthorized, http.StatusForbidden:
		msg += " — the link may have expired, need a login, or only work from the page it came from"
	case http.StatusNotFound, http.StatusGone:
		msg += " — the file is no longer at this address"
	case http.StatusTooManyRequests:
		msg += " — the server is rate-limiting; try again later"
	}
	return msg
}

// probe asks for the first sniffLen bytes and inspects the answer:
//   - 206 -> server honors ranges; total size from Content-Range.
//   - 200 -> no range support; size from Content-Length (may be -1/chunked).
//
// A small ranged GET is more truthful than HEAD: many servers answer HEAD with
// Accept-Ranges they don't honor, or omit Content-Length. When a server turns
// the request away (403/401/404/416/405…) it retries without the Range header
// and with alternative Referers, since hotlink protection and picky range
// handling are the usual causes. Size still unknown? A HEAD may know it.
func (e *Engine) probe(ctx context.Context, rawURL string, ri reqInfo, title string) (probeResult, error) {
	var lastErr error
	for _, ref := range refererCandidates(rawURL, ri.Referer) {
		try := reqInfo{Referer: ref, Headers: ri.Headers}
		for _, ranged := range []bool{true, false} {
			pr, sniff, err := e.probeOnce(ctx, rawURL, try, ranged)
			if err != nil {
				if ctx.Err() != nil {
					return probeResult{}, ctx.Err()
				}
				var se *probeStatusError
				if !errors.As(err, &se) {
					return probeResult{}, err // network error — no point cycling headers
				}
				// Report the first real refusal (from the caller's own headers), not a
				// 416 from our range probe or whatever a fallback Referer got.
				var prev *probeStatusError
				if lastErr == nil || (errors.As(lastErr, &prev) && prev.code == http.StatusRequestedRangeNotSatisfiable &&
					se.code != http.StatusRequestedRangeNotSatisfiable) {
					lastErr = err
				}
				continue
			}
			pr.Referer = ref
			if pr.Size < 0 {
				if n := e.headSize(ctx, rawURL, try); n > 0 {
					pr.Size = n
				}
			}
			pr.Kind = classify(pr.FinalURL, pr.ContentType, sniff)
			pr.FileName = resolveFileName(nameHints{
				Disposition: pr.FileName, // probeOnce stashes the raw header here
				OrigURL:     rawURL,
				FinalURL:    pr.FinalURL,
				ContentType: pr.ContentType,
				Sniff:       sniff,
				Title:       title,
				Referer:     ri.Referer,
			})
			return pr, nil
		}
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("server did not answer")
	}
	return probeResult{}, lastErr
}

// probeOnce performs one probe request. On success FileName temporarily holds
// the raw Content-Disposition header (probe resolves the real name).
func (e *Engine) probeOnce(ctx context.Context, rawURL string, ri reqInfo, ranged bool) (probeResult, []byte, error) {
	for attempt := 0; ; attempt++ {
		req, err := e.newRequest(ctx, http.MethodGet, rawURL, ri)
		if err != nil {
			return probeResult{}, nil, err
		}
		if ranged {
			req.Header.Set("Range", fmt.Sprintf("bytes=0-%d", sniffLen-1))
		}
		resp, err := e.client.Do(req)
		if err != nil {
			if attempt < 2 && ctx.Err() == nil {
				if sleepCtx(ctx, time.Duration(attempt+1)*time.Second) != nil {
					return probeResult{}, nil, ctx.Err()
				}
				continue
			}
			return probeResult{}, nil, err
		}
		// Busy server: honor a short Retry-After once or twice before giving up.
		if (resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable ||
			resp.StatusCode == http.StatusBadGateway || resp.StatusCode == http.StatusGatewayTimeout) && attempt < 2 {
			wait := retryAfter(resp.Header.Get("Retry-After"), time.Duration(attempt+1)*2*time.Second)
			resp.Body.Close()
			if sleepCtx(ctx, wait) != nil {
				return probeResult{}, nil, ctx.Err()
			}
			continue
		}

		pr := probeResult{
			Size:         -1,
			ETag:         resp.Header.Get("ETag"),
			LastModified: resp.Header.Get("Last-Modified"),
			ContentType:  resp.Header.Get("Content-Type"),
			FileName:     resp.Header.Get("Content-Disposition"),
			FinalURL:     rawURL,
		}
		if resp.Request != nil && resp.Request.URL != nil {
			pr.FinalURL = resp.Request.URL.String()
		}
		encoded := !isIdentityEncoding(resp.Header.Get("Content-Encoding"))
		switch {
		case resp.StatusCode == http.StatusPartialContent:
			pr.Ranged = !encoded
			if total, ok := parseContentRangeTotal(resp.Header.Get("Content-Range")); ok {
				pr.Size = total
			}
		case resp.StatusCode >= 200 && resp.StatusCode < 300:
			pr.Ranged = false
			if resp.ContentLength >= 0 && !encoded {
				pr.Size = resp.ContentLength
			}
		default:
			resp.Body.Close()
			return probeResult{}, nil, &probeStatusError{code: resp.StatusCode, status: resp.Status,
				challenge: isChallenge(resp)}
		}
		sniff := make([]byte, sniffLen)
		n, _ := io.ReadFull(resp.Body, sniff)
		resp.Body.Close()
		return pr, sniff[:n], nil
	}
}

// headSize asks HEAD for a Content-Length the GET didn't give (chunked replies,
// "Content-Range: bytes 0-0/*"). 0 when HEAD fails or doesn't know either.
func (e *Engine) headSize(ctx context.Context, rawURL string, ri reqInfo) int64 {
	hctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := e.newRequest(hctx, http.MethodHead, rawURL, ri)
	if err != nil {
		return 0
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return 0
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !isIdentityEncoding(resp.Header.Get("Content-Encoding")) {
		return 0
	}
	return resp.ContentLength
}

// isChallenge reports a Cloudflare bot-check answer.
func isChallenge(resp *http.Response) bool {
	return strings.EqualFold(resp.Header.Get("Cf-Mitigated"), "challenge")
}

func isIdentityEncoding(ce string) bool {
	ce = strings.ToLower(strings.TrimSpace(ce))
	return ce == "" || ce == "identity" || ce == "none"
}

// retryAfter parses a Retry-After header (seconds form), capped at 10s.
func retryAfter(h string, def time.Duration) time.Duration {
	if s, err := strconv.Atoi(strings.TrimSpace(h)); err == nil && s >= 0 {
		d := time.Duration(s) * time.Second
		if d > 10*time.Second {
			d = 10 * time.Second
		}
		return d
	}
	return def
}

// sleepCtx waits d or until ctx is done (returning ctx.Err()).
func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// parseContentRangeTotal extracts N from "bytes 0-0/N".
func parseContentRangeTotal(h string) (int64, bool) {
	idx := strings.LastIndexByte(h, '/')
	if idx < 0 {
		return 0, false
	}
	totalStr := strings.TrimSpace(h[idx+1:])
	if totalStr == "*" {
		return 0, false
	}
	total, err := strconv.ParseInt(totalStr, 10, 64)
	if err != nil || total < 0 {
		return 0, false
	}
	return total, true
}
