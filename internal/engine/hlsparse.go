package engine

// HLS playlist parsing (RFC 8216): master playlists (variants + alternate audio
// renditions) and media playlists (segments with durations, byte ranges,
// encryption keys and fMP4 init sections).

import (
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

type hlsVariant struct {
	URI        string
	Bandwidth  int64
	Width      int
	Height     int
	Codecs     string
	AudioGroup string
}

type hlsRendition struct {
	Type     string // AUDIO, SUBTITLES, …
	GroupID  string
	URI      string
	Name     string
	Language string
	Default  bool
}

type hlsKey struct {
	Method    string // NONE, AES-128, SAMPLE-AES, …
	URI       string
	IV        []byte // nil = derived from the media sequence number
	KeyFormat string
}

type hlsMap struct {
	URI      string
	Off, Len int64 // Len < 0 = the whole resource
	Key      *hlsKey
}

type hlsSegment struct {
	URI      string
	Duration float64
	Seq      int64
	Off, Len int64 // Len < 0 = the whole resource
	Key      *hlsKey
	Map      *hlsMap
}

type hlsPlaylist struct {
	Master     bool
	Variants   []hlsVariant
	Renditions []hlsRendition

	Segments       []hlsSegment
	TargetDuration float64
	MediaSequence  int64
	EndList        bool
	PlaylistType   string // VOD, EVENT or ""
}

// live reports whether the media playlist is still growing.
func (p *hlsPlaylist) live() bool {
	return !p.EndList && !strings.EqualFold(p.PlaylistType, "VOD")
}

// duration is the total playing time of the listed segments.
func (p *hlsPlaylist) duration() float64 {
	var d float64
	for _, s := range p.Segments {
		d += s.Duration
	}
	return d
}

// parseHLS parses a playlist; relative URIs resolve against base.
func parseHLS(body string, base *url.URL) (*hlsPlaylist, error) {
	body = strings.TrimPrefix(body, "\uFEFF")
	if !strings.HasPrefix(strings.TrimSpace(body), "#EXTM3U") {
		return nil, fmt.Errorf("not an HLS playlist")
	}
	resolve := func(ref string) string {
		ref = strings.TrimSpace(ref)
		if base == nil {
			return ref
		}
		u, err := base.Parse(ref)
		if err != nil {
			return ref
		}
		return u.String()
	}

	pl := &hlsPlaylist{}
	var (
		pendingInf    *hlsVariant
		pendingDur    float64
		haveDur       bool
		pendingOff    int64
		pendingLen    int64 = -1
		nextOff             = map[string]int64{} // byte-range continuation per URI
		curKey        *hlsKey
		curMap        *hlsMap
		mediaSeqSet   bool
		segIndex      int64
		sawSegmentTag bool
	)
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "#") {
			if pendingInf != nil { // URI line after EXT-X-STREAM-INF
				pendingInf.URI = resolve(line)
				pl.Variants = append(pl.Variants, *pendingInf)
				pendingInf = nil
				continue
			}
			if !haveDur && !sawSegmentTag {
				continue // stray line in a master playlist
			}
			uri := resolve(line)
			seg := hlsSegment{URI: uri, Duration: pendingDur, Seq: pl.MediaSequence + segIndex,
				Off: 0, Len: -1, Key: curKey, Map: curMap}
			if pendingLen >= 0 {
				off := pendingOff
				if off < 0 {
					off = nextOff[uri]
				}
				seg.Off, seg.Len = off, pendingLen
				nextOff[uri] = off + pendingLen
			}
			pl.Segments = append(pl.Segments, seg)
			segIndex++
			pendingDur, haveDur = 0, false
			pendingLen, pendingOff = -1, 0
			continue
		}

		tag, val, _ := strings.Cut(line, ":")
		switch strings.ToUpper(tag) {
		case "#EXT-X-STREAM-INF":
			a := parseAttrs(val)
			v := &hlsVariant{Codecs: a["CODECS"], AudioGroup: a["AUDIO"]}
			v.Bandwidth, _ = strconv.ParseInt(a["BANDWIDTH"], 10, 64)
			if v.Bandwidth == 0 {
				v.Bandwidth, _ = strconv.ParseInt(a["AVERAGE-BANDWIDTH"], 10, 64)
			}
			if w, h, ok := strings.Cut(a["RESOLUTION"], "x"); ok {
				v.Width, _ = strconv.Atoi(w)
				v.Height, _ = strconv.Atoi(h)
			}
			pendingInf = v
			pl.Master = true
		case "#EXT-X-MEDIA":
			a := parseAttrs(val)
			r := hlsRendition{Type: strings.ToUpper(a["TYPE"]), GroupID: a["GROUP-ID"], Name: a["NAME"],
				Language: a["LANGUAGE"], Default: strings.EqualFold(a["DEFAULT"], "YES")}
			if a["URI"] != "" {
				r.URI = resolve(a["URI"])
			}
			pl.Renditions = append(pl.Renditions, r)
			pl.Master = true
		case "#EXT-X-TARGETDURATION":
			pl.TargetDuration, _ = strconv.ParseFloat(val, 64)
		case "#EXT-X-MEDIA-SEQUENCE":
			if !mediaSeqSet {
				pl.MediaSequence, _ = strconv.ParseInt(val, 10, 64)
				mediaSeqSet = true
			}
		case "#EXT-X-ENDLIST":
			pl.EndList = true
		case "#EXT-X-PLAYLIST-TYPE":
			pl.PlaylistType = strings.ToUpper(val)
		case "#EXTINF":
			d, _, _ := strings.Cut(val, ",")
			pendingDur, _ = strconv.ParseFloat(strings.TrimSpace(d), 64)
			haveDur = true
			sawSegmentTag = true
		case "#EXT-X-BYTERANGE":
			n, o, hasOff := strings.Cut(val, "@")
			pendingLen, _ = strconv.ParseInt(strings.TrimSpace(n), 10, 64)
			pendingOff = -1
			if hasOff {
				pendingOff, _ = strconv.ParseInt(strings.TrimSpace(o), 10, 64)
			}
			sawSegmentTag = true
		case "#EXT-X-KEY":
			a := parseAttrs(val)
			method := strings.ToUpper(a["METHOD"])
			if method == "" || method == "NONE" {
				curKey = nil
				continue
			}
			k := &hlsKey{Method: method, KeyFormat: a["KEYFORMAT"]}
			if a["URI"] != "" {
				k.URI = resolve(a["URI"])
				if strings.HasPrefix(a["URI"], "data:") || strings.HasPrefix(a["URI"], "skd:") {
					k.URI = a["URI"] // keep non-HTTP key URIs verbatim
				}
			}
			if iv := strings.TrimPrefix(strings.TrimPrefix(a["IV"], "0x"), "0X"); iv != "" {
				if b, err := hex.DecodeString(padHex(iv)); err == nil {
					k.IV = b
				}
			}
			curKey = k
		case "#EXT-X-MAP":
			a := parseAttrs(val)
			m := &hlsMap{URI: resolve(a["URI"]), Len: -1, Key: curKey}
			if br := a["BYTERANGE"]; br != "" {
				n, o, _ := strings.Cut(br, "@")
				m.Len, _ = strconv.ParseInt(n, 10, 64)
				m.Off, _ = strconv.ParseInt(o, 10, 64)
			}
			curMap = m
			sawSegmentTag = true
		}
	}
	if !pl.Master && len(pl.Segments) == 0 && !pl.EndList && pl.TargetDuration == 0 {
		return nil, fmt.Errorf("playlist lists no media")
	}
	return pl, nil
}

// padHex left-pads a hex IV to 32 digits (16 bytes).
func padHex(s string) string {
	if len(s)%2 == 1 {
		s = "0" + s
	}
	for len(s) < 32 {
		s = "00" + s
	}
	return s
}

// parseAttrs parses an HLS attribute list: KEY=VALUE,KEY="quoted, value".
func parseAttrs(s string) map[string]string {
	out := map[string]string{}
	for len(s) > 0 {
		s = strings.TrimLeft(s, " ,")
		eq := strings.IndexByte(s, '=')
		if eq < 0 {
			break
		}
		key := strings.ToUpper(strings.TrimSpace(s[:eq]))
		s = s[eq+1:]
		var val string
		if strings.HasPrefix(s, `"`) {
			end := strings.IndexByte(s[1:], '"')
			if end < 0 {
				val, s = s[1:], ""
			} else {
				val, s = s[1:end+1], s[end+2:]
			}
		} else {
			end := strings.IndexByte(s, ',')
			if end < 0 {
				val, s = s, ""
			} else {
				val, s = s[:end], s[end:]
			}
		}
		out[key] = strings.TrimSpace(val)
	}
	return out
}

// pickVariant chooses the best-quality variant: highest resolution, then
// bandwidth. Audio-only variants lose to any video variant.
func pickVariant(vs []hlsVariant) (hlsVariant, bool) {
	best, ok := hlsVariant{}, false
	for _, v := range vs {
		if v.URI == "" {
			continue
		}
		if !ok || v.Height > best.Height || (v.Height == best.Height && v.Bandwidth > best.Bandwidth) {
			best, ok = v, true
		}
	}
	return best, ok
}

// pickAudio finds the separate audio playlist a variant needs, if any: the
// DEFAULT rendition of its audio group, else the first with a URI. Renditions
// without a URI mean the audio is already muxed into the variant.
func pickAudio(pl *hlsPlaylist, v hlsVariant) (hlsRendition, bool) {
	if v.AudioGroup == "" {
		return hlsRendition{}, false
	}
	var first hlsRendition
	found := false
	for _, r := range pl.Renditions {
		if r.Type != "AUDIO" || r.GroupID != v.AudioGroup || r.URI == "" {
			continue
		}
		if r.Default {
			return r, true
		}
		if !found {
			first, found = r, true
		}
	}
	return first, found
}
