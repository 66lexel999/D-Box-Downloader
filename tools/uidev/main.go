// Command uidev runs D BOX's engine and web UI on any OS with sample downloads,
// for working on the interface in a normal browser:
//
//	go run ./tools/uidev            then open http://127.0.0.1:8081
//
// It seeds a few finished / paused / failed / scheduled entries and starts two
// live downloads from a built-in slow file server, so every row state shows.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"myidm/internal/config"
	"myidm/internal/engine"
	"myidm/internal/server"
	"myidm/internal/store"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8081", "UI address")
	flag.Parse()

	root, _ := os.MkdirTemp("", "dbox-uidev-")
	cfg := config.Default()
	cfg.DataDir = filepath.Join(root, "data")
	cfg.DownloadDir = filepath.Join(root, "Downloads")
	cfg.Categories = config.DefaultCategories(cfg.DownloadDir)
	cfg.MaxConcurrent = 3
	cfg.GUI = false
	for _, d := range cfg.Categories {
		os.MkdirAll(d, 0o755)
	}
	os.MkdirAll(cfg.DataDir, 0o755)
	seed(cfg)

	// A slow origin so live downloads stay "downloading" while you look.
	go http.ListenAndServe("127.0.0.1:9100", http.HandlerFunc(slowFile))

	st, _ := store.New(cfg.DataDir)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	eng := engine.New(cfg, st, log)
	if err := eng.Start(context.Background()); err != nil {
		panic(err)
	}
	eng.AddWithOptions("http://127.0.0.1:9100/files/ubuntu-24.04-desktop-amd64.iso?size=4800000000", engine.AddOptions{Segments: 8})
	eng.AddWithOptions("http://127.0.0.1:9100/files/Project%20Assets%20(final).zip?size=900000000", engine.AddOptions{Segments: 4})
	fmt.Println("D BOX UI dev server: http://" + *listen + "   (data in " + root + ")")
	srv := server.New(eng, log)
	srv.SetUpdateSource("1.2.0", "", nil) // shows the version; no manifest → updates off
	panic(http.ListenAndServe(*listen, srv.Handler()))
}

// slowFile serves ?size= bytes of zeros at ~3 MB/s per connection, with ranges.
func slowFile(w http.ResponseWriter, r *http.Request) {
	size, _ := strconv.ParseInt(r.URL.Query().Get("size"), 10, 64)
	if size <= 0 {
		size = 100 << 20
	}
	start, end := int64(0), size-1
	if rg := r.Header.Get("Range"); rg != "" {
		fmt.Sscanf(rg, "bytes=%d-%d", &start, &end)
		if end <= 0 || end >= size {
			end = size - 1
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
		w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	buf := make([]byte, 64<<10)
	for left := end - start + 1; left > 0; {
		n := int64(len(buf))
		if n > left {
			n = left
		}
		if _, err := w.Write(buf[:n]); err != nil {
			return
		}
		left -= n
		time.Sleep(20 * time.Millisecond)
	}
}

// seed writes sample history: finished files in several categories, plus
// paused / failed / scheduled / later entries.
func seed(cfg *config.Config) {
	now := time.Now()
	type seg struct {
		Start int64 `json:"start"`
		End   int64 `json:"end"`
		Done  int64 `json:"done"`
	}
	type task struct {
		ID           string     `json:"id"`
		URL          string     `json:"url"`
		FileName     string     `json:"fileName"`
		Dir          string     `json:"dir"`
		Size         int64      `json:"size"`
		Ranged       bool       `json:"ranged"`
		Probed       bool       `json:"probed"`
		Status       string     `json:"status"`
		Error        string     `json:"error,omitempty"`
		Segments     []seg      `json:"segments"`
		WantSegments int        `json:"wantSegments"`
		CreatedAt    time.Time  `json:"createdAt"`
		CompletedAt  *time.Time `json:"completedAt,omitempty"`
		ScheduledAt  *time.Time `json:"scheduledAt,omitempty"`
		Later        bool       `json:"later,omitempty"`
		FinalPath    string     `json:"finalPath,omitempty"`
		Kind         string     `json:"kind,omitempty"`
		Description  string     `json:"description,omitempty"`
	}
	cat := cfg.Categories
	done := func(id, name, dir, u string, size int64, ago time.Duration) task {
		p := filepath.Join(dir, name)
		os.WriteFile(p, []byte("x"), 0o644)
		at := now.Add(-ago)
		return task{ID: id, URL: u, FileName: name, Dir: dir, Size: size, Ranged: true, Probed: true, Status: "completed",
			Segments: []seg{{0, size - 1, size}}, WantSegments: 8, CreatedAt: at.Add(-time.Minute), CompletedAt: &at, FinalPath: p}
	}
	later := now.Add(3 * time.Hour)
	tasks := []task{
		done("a1", "Avatar The Last Airbender S01E01.mp4", cat["Video"], "https://cdn.example.com/v/ep1.mp4", 367_001_600, 20*time.Hour),
		done("a2", "Lofi Beats – Rainy Night.mp3", cat["Music"], "https://music.example.com/t/99.mp3", 8_650_000, 18*time.Hour),
		done("a3", "VSCodeUserSetup-x64-1.104.exe", cat["Programs"], "https://update.code.visualstudio.com/latest", 98_300_000, 9*time.Hour),
		done("a4", "Annual Report 2025.pdf", cat["Documents"], "https://files.example.org/r/2025.pdf", 4_210_000, 7*time.Hour),
		done("a5", "wallpapers-4k.zip", cat["Compressed"], "https://images.example.net/pack.zip", 612_000_000, 5*time.Hour),
		done("a6", "sunset-over-baghdad.jpg", cat["Images"], "https://photos.example.com/sunset.jpg", 3_400_000, 3*time.Hour),
		{ID: "p1", URL: "https://mirror.example.com/Fedora-Workstation-41.iso", FileName: "Fedora-Workstation-41.iso", Dir: cat["Compressed"],
			Size: 2_300_000_000, Ranged: true, Probed: true, Status: "paused", WantSegments: 8, CreatedAt: now.Add(-2 * time.Hour),
			Segments: []seg{{0, 1_149_999_999, 800_000_000}, {1_150_000_000, 2_299_999_999, 310_000_000}}},
		{ID: "f1", URL: "https://moviz-time.example/film/avatar", FileName: "Avatar (2009).mp4", Dir: cat["Video"], Size: -1,
			Probed: true, Status: "failed", Kind: "ytdlp", Error: "yt-dlp: ERROR: Unsupported URL", WantSegments: 8,
			CreatedAt: now.Add(-90 * time.Minute), Segments: []seg{{0, -1, 0}}},
		{ID: "s1", URL: "https://releases.example.com/tool-2.0-setup.msi", FileName: "tool-2.0-setup.msi", Dir: cat["Programs"],
			Size: -1, Status: "scheduled", ScheduledAt: &later, WantSegments: 8, CreatedAt: now.Add(-30 * time.Minute)},
		{ID: "l1", URL: "https://videos.example.com/lecture-4.mp4", FileName: "Lecture 4 – Networks.mp4", Dir: cat["Video"],
			Size: -1, Status: "paused", Later: true, WantSegments: 8, CreatedAt: now.Add(-10 * time.Minute), Description: "for the weekend"},
	}
	b, _ := json.MarshalIndent(tasks, "", "  ")
	os.WriteFile(filepath.Join(cfg.DataDir, "tasks.json"), b, 0o644)
}
