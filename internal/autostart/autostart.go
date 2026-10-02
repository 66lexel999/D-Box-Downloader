// Package autostart starts D BOX when the user signs in to Windows.
//
// It uses the per-user Run key (HKCU\Software\Microsoft\Windows\CurrentVersion\Run),
// so no admin rights are needed and only this Windows account is affected. The
// entry launches the exe with -autostart, which makes the app open quietly in
// the tray instead of popping its window up at every sign-in. The entry also
// shows up in Task Manager → Startup apps; switching it off there is respected.
package autostart

import (
	"os"
	"path/filepath"
	"strings"
)

// Flag is the switch the sign-in launch carries: start hidden in the tray.
const Flag = "-autostart"

// ValueName names D BOX's entry in the Run key and in Task Manager.
const ValueName = "D BOX"

// Command is the Run-key command line that starts exe at sign-in.
func Command(exe string) string { return `"` + exe + `" ` + Flag }

// IsFlag reports whether a command-line argument is the -autostart switch, in
// any spelling the flag package accepts (-autostart, --autostart, -autostart=true).
func IsFlag(arg string) bool {
	a := strings.TrimLeft(arg, "-")
	if a == arg || len(arg)-len(a) > 2 { // no dash, or more than two
		return false
	}
	name, _, _ := strings.Cut(a, "=")
	return name == strings.TrimPrefix(Flag, "-")
}

// State is D BOX's sign-in entry as Windows sees it.
type State struct {
	Registered     bool   // the Run entry exists
	Command        string // its command line
	DisabledByUser bool   // switched off in Task Manager → Startup apps
}

// On reports whether Windows will start D BOX at the next sign-in.
func (s State) On() bool { return s.Registered && !s.DisabledByUser }

// PointsTo reports whether the entry starts exe the way Enable writes it.
func (s State) PointsTo(exe string) bool {
	return s.Registered && strings.EqualFold(s.Command, Command(exe))
}

// Manageable reports whether exe is a real install worth registering — not a
// throwaway `go run` build in the temp folder, which would be gone by the next
// sign-in.
func Manageable(exe string) bool {
	if exe == "" {
		return false
	}
	tmp := filepath.Clean(os.TempDir())
	rel, err := filepath.Rel(tmp, filepath.Clean(exe))
	return err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// backend is where the sign-in entry lives: the Windows registry, or a fake in tests.
type backend interface {
	Status() (State, error)
	Enable(exe string) error
	Disable() error
}

// sync makes the sign-in entry match the saved choice (pref; nil = never chosen,
// which means on) for exe, and returns the choice to save from now on. The
// entry is rewritten when it's missing or starts another copy of D BOX (the
// exe moved, or another copy ran last), so the copy the user runs is the one
// that starts. An entry switched off in Task Manager is the user's choice too:
// it's left alone and the saved choice becomes "off".
func sync(r backend, pref *bool, exe string) (bool, error) {
	want := pref == nil || *pref
	st, err := r.Status()
	if err != nil {
		return want, err
	}
	switch {
	case want && st.Registered && st.DisabledByUser:
		return false, nil
	case want && !st.PointsTo(exe):
		return true, r.Enable(exe)
	case !want && st.Registered:
		return false, r.Disable()
	}
	return want, nil
}

// Sync applies the saved choice (nil = never chosen = on) to Windows for exe
// and returns the choice to save. Call it once at startup.
func Sync(pref *bool, exe string) (bool, error) { return sync(system, pref, exe) }

// Status reads D BOX's sign-in entry.
func Status() (State, error) { return system.Status() }

// Enable makes Windows start exe (hidden in the tray) at sign-in, clearing a
// "disabled" mark Task Manager may have left.
func Enable(exe string) error { return system.Enable(exe) }

// Disable removes the sign-in entry.
func Disable() error { return system.Disable() }
