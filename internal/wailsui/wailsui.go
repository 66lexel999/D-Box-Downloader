//go:build windows

// Package wailsui hosts MyIDM's window with Wails v2. Instead of embedding a
// separate frontend, it serves the existing HTTP handler (the IDM-skinned HTML
// UI + JSON API) straight through Wails' AssetServer — so the whole proven web
// UI is reused unchanged, and because it renders in WebView2 there is no native
// ListView to flicker (the problem that plagued the lxn/walk front end).
package wailsui

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"myidm/internal/gui"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	wruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// the live window context, captured at startup so Activate can reach the runtime.
var (
	ctxMu      sync.Mutex
	winCtx     context.Context
	reallyQuit bool // set by Quit() so OnBeforeClose lets the window actually close
)

// Run opens the window and blocks on the Wails event loop until it closes.
// handler serves both the UI (GET /) and the JSON API (/api/*). onClose runs on
// shutdown (engine + server teardown). startHidden (the Windows sign-in launch)
// keeps the window hidden — D BOX waits in the tray until it's opened.
func Run(handler http.Handler, log *slog.Logger, onClose func(), startHidden bool) error {
	return wails.Run(&options.App{
		Title:     "D BOX — Download Manager",
		Width:     763, // default (your current size ÷ 1.39 DPI); overridden by the remembered size
		Height:    343,
		MinWidth:  500,
		MinHeight: 280,
		// Assets nil + Handler set => every request (GET UI + POST/DELETE API)
		// is served by our existing mux.
		AssetServer:      &assetserver.Options{Handler: handler},
		BackgroundColour: &options.RGBA{R: 0x12, G: 0x12, B: 0x12, A: 255}, // --bg, avoids a white flash
		StartHidden:      startHidden,
		OnStartup: func(ctx context.Context) {
			ctxMu.Lock()
			winCtx = ctx
			ctxMu.Unlock()
			if w, h, ok := gui.LoadWinSize("main"); ok {
				wruntime.WindowSetSize(ctx, w, h) // restore the user's last window size
			}
			wruntime.WindowCenter(ctx) // center at the restored (or default) size
			// IDM-style tray: closing the window then hides to the notification area
			// instead of quitting (see OnBeforeClose). Left-click / "Open D BOX"
			// restores it; "Exit" really quits.
			ready := make(chan bool, 1)
			go gui.RunTray("D BOX — Download Manager", Activate, Quit, ready)
			if ok := <-ready; !ok && startHidden {
				// Started hidden but there's no tray icon to open it from: show it
				// minimized on the taskbar so D BOX is still reachable.
				log.Warn("tray icon unavailable at startup; showing the window minimized")
				wruntime.WindowShow(ctx)
				wruntime.WindowMinimise(ctx)
			}
		},
		// Wails doesn't set a window icon, so the title bar shows the generic
		// program icon — put our own there once the window/DOM exists.
		OnDomReady: func(_ context.Context) {
			go applyWindowIcon()
		},
		// Close (the X) hides to tray and keeps downloading in the background,
		// rather than quitting — only a real Exit (tray menu / File → Exit) closes.
		OnBeforeClose: func(ctx context.Context) bool {
			if w, h := wruntime.WindowGetSize(ctx); w > 0 && h > 0 {
				gui.SaveWinSize("main", w, h) // remember size on every close (hide-to-tray and real exit)
			}
			ctxMu.Lock()
			rq := reallyQuit
			ctxMu.Unlock()
			if rq {
				return false // allow the close
			}
			if gui.TrayActive() {
				wruntime.WindowHide(ctx) // hide to tray (taskbar button gone, like IDM)
			} else {
				wruntime.WindowMinimise(ctx) // no tray: keep running, restorable from taskbar
			}
			return true // prevent the close
		},
		OnShutdown: func(_ context.Context) {
			gui.RemoveTray()
			if onClose != nil {
				onClose()
			}
		},
		Windows: &windows.Options{
			Theme:                windows.Dark, // dark title bar / frame
			WebviewIsTransparent: false,
		},
	})
}

// Quit requests a real application exit (the tray's "Exit", or File → Exit in the
// UI via POST /api/quit). It removes the tray icon and tells Wails to close;
// OnBeforeClose then lets the window through because reallyQuit is set.
func Quit() {
	ctxMu.Lock()
	reallyQuit = true
	ctx := winCtx
	ctxMu.Unlock()
	gui.RemoveTray()
	if ctx != nil {
		wruntime.Quit(ctx)
	}
}

// Quitting reports that a real exit is under way (the window is going away).
func Quitting() bool {
	ctxMu.Lock()
	defer ctxMu.Unlock()
	return reallyQuit
}

// Activate brings the window to the foreground. Called when the browser
// extension captures a download (POST /api/prompt) so the in-page New Download
// dialog surfaces over the browser instead of only flashing in the taskbar.
// Syncs Wails' own state, then uses the Win32 AttachThreadInput trick to win the
// foreground from a background thread (Wails' WindowShow alone loses the race).
func Activate() {
	ctxMu.Lock()
	ctx := winCtx
	ctxMu.Unlock()
	if ctx != nil {
		wruntime.WindowUnminimise(ctx)
		wruntime.WindowShow(ctx)
		wruntime.WindowCenter(ctx) // re-center every time it reappears (e.g. from the tray)
	}
	// WindowShow is queued to the UI thread: wait (briefly) until the window is
	// really up before raising it, or a window that started hidden is missed.
	for i := 0; i < 40 && ourWindow() == 0; i++ {
		time.Sleep(25 * time.Millisecond)
	}
	forceForeground()
	if !iconApplied.Load() {
		applyWindowIcon() // a window that started hidden had nothing to put it on
	}
}
