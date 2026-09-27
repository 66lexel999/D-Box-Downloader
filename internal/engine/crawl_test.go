package engine

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// packJS packs a script the way Dean Edwards' P.A.C.K.E.R. does (base-62 word
// indexes + keyword list) — the obfuscation embed players hide streams behind.
func packJS(src string) string {
	var words []string
	idx := map[string]int{}
	enc := func(n int) string {
		if n == 0 {
			return "0"
		}
		s := ""
		for n > 0 {
			s = string(packerDigits[n%62]) + s
			n /= 62
		}
		return s
	}
	payload := packerWordRE.ReplaceAllStringFunc(src, func(w string) string {
		i, ok := idx[w]
		if !ok {
			i = len(words)
			idx[w] = i
			words = append(words, w)
		}
		return enc(i)
	})
	return fmt.Sprintf(`eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(new RegExp('\\b'+e(c)+'\\b','g'),k[c]);return p}('%s',62,%d,'%s'.split('|'),0,{}))`,
		strings.ReplaceAll(payload, "'", `\'`), len(words), strings.Join(words, "|"))
}

func TestUnpackPacker(t *testing.T) {
	src := `var player=jwplayer("vplayer");player.setup({sources:[{file:"https://cdn.example/hls/abc/master.m3u8?t=1"}],image:'/p.jpg'});`
	got := unpackAll("<script>" + packJS(src) + "</script>")
	if !strings.Contains(got, "https://cdn.example/hls/abc/master.m3u8?t=1") || !strings.Contains(got, "image:'/p.jpg'") {
		t.Fatalf("unpacked = %q", got)
	}
}

// TestCrawlerFindsStreamInPlayerIframe: the page has a ringtone MP3 and a
// player iframe on another site; the iframe's page hides the HLS URL in a
// packed script; every hop insists on the right Referer. D BOX must find and
// download the VIDEO — not the ringtone.
func TestCrawlerFindsStreamInPlayerIframe(t *testing.T) {
	var site, embed *httptest.Server
	needRef := func(w http.ResponseWriter, r *http.Request, prefix string) bool {
		if !strings.HasPrefix(r.Header.Get("Referer"), prefix) {
			http.Error(w, "hotlink", http.StatusForbidden)
			return false
		}
		return true
	}
	embedMux := http.NewServeMux()
	embedMux.HandleFunc("/e/xyz", func(w http.ResponseWriter, r *http.Request) {
		if !needRef(w, r, site.URL+"/watch/") {
			return
		}
		js := packJS(`var p=jwplayer("vplayer");p.setup({sources:[{file:"` + embed.URL + `/hls/master.m3u8"}]});`)
		fmt.Fprintf(w, "<!DOCTYPE html><html><head><title>Player</title></head><body><div id=vplayer></div><script>%s</script></body></html>", js)
	})
	embedMux.HandleFunc("/hls/master.m3u8", func(w http.ResponseWriter, r *http.Request) {
		if !needRef(w, r, embed.URL+"/e/") {
			return
		}
		fmt.Fprint(w, "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nseg2.ts\n#EXT-X-ENDLIST\n")
	})
	embedMux.HandleFunc("/hls/", func(w http.ResponseWriter, r *http.Request) {
		if !needRef(w, r, embed.URL+"/e/") {
			return
		}
		var i int
		fmt.Sscanf(strings.TrimPrefix(r.URL.Path, "/hls/seg"), "%d", &i)
		w.Write(tsSegment(i, 10))
	})
	embed = httptest.NewServer(embedMux)
	defer embed.Close()

	siteMux := http.NewServeMux()
	siteMux.HandleFunc("/watch/avatar-1", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!DOCTYPE html><html><head><title>Avatar Episode 1 - Toons</title></head><body>
<div class="ringtone"><audio src="/media/ringtone.mp3"></audio></div>
<ul class="servers"><li data-embed="%s/e/xyz">Server 1</li></ul>
<iframe src="%s/e/xyz" allowfullscreen></iframe>
<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe>
</body></html>`, embed.URL, embed.URL)
	})
	siteMux.HandleFunc("/media/ringtone.mp3", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "audio/mpeg")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(append([]byte("ID3\x04"), make([]byte, 400<<10)...)))
	})
	site = httptest.NewServer(siteMux)
	defer site.Close()

	e := newRunningEngine(t)
	v, err := e.AddWithOptions(site.URL+"/watch/avatar-1", AddOptions{})
	if err != nil {
		t.Fatal(err)
	}
	v = mustComplete(t, e, v.ID)
	want := append(append(tsSegment(0, 10), tsSegment(1, 10)...), tsSegment(2, 10)...)
	if got := readFile(t, v.FilePath); !bytes.Equal(got, want) {
		t.Fatalf("downloaded %d bytes, want the %d-byte video stream", len(got), len(want))
	}
	if base := filepath.Base(v.FilePath); base != "Avatar Episode 1 - Toons.ts" {
		t.Errorf("name = %q (want the page title)", base)
	}
}

// TestYtdlpUnsupportedURLFallsBackToCrawler: yt-dlp answers "Unsupported URL"
// for a page (the moviz-time case); the crawler finds the page's video file.
func TestYtdlpUnsupportedURLFallsBackToCrawler(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script stand-in needs a POSIX shell")
	}
	bin := t.TempDir()
	os.WriteFile(filepath.Join(bin, "yt-dlp"), []byte("#!/bin/sh\necho \"ERROR: Unsupported URL: $(for a; do :; done; echo $a)\" >&2\nexit 1\n"), 0o755)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	movie := append([]byte("\x00\x00\x00\x18ftypmp42"), bytes.Repeat([]byte{7}, 600<<10)...)
	mux := http.NewServeMux()
	mux.HandleFunc("/film/avatar", func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `<!DOCTYPE html><html><head><meta property="og:title" content="Avatar: The Movie"></head>
<body><video controls><source src="/media/v/4f9a.mp4?token=abc" type="video/mp4"></video></body></html>`)
	})
	mux.HandleFunc("/media/v/4f9a.mp4", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(movie))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	e := newRunningEngine(t)
	v, err := e.AddVideoWithOptions(srv.URL+"/film/avatar", VideoOptions{Title: "Avatar"})
	if err != nil {
		t.Fatal(err)
	}
	v = mustComplete(t, e, v.ID)
	if !bytes.Equal(readFile(t, v.FilePath), movie) {
		t.Fatal("wrong content")
	}
	if base := filepath.Base(v.FilePath); base != "Avatar.mp4" {
		t.Errorf("name = %q", base)
	}
}
