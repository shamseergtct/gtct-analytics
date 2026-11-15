// GTCT Restaurant Pilot launcher (Windows).
// Bundled-Node host: starts the existing local-server, opens the browser,
// and stops cleanly when the operator closes the status dialog.
//
// Operating mode remains TEST. Physical printing stays off unless the
// operator later enables it inside the installed app configuration.
package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	appTitle       = "GTCT Restaurant Pilot (TEST)"
	defaultPort    = 8787
	productFolder  = "GTCT\\RestaurantPilot"
	backupFolder   = "GTCT\\RestaurantPilot-Backups"
	runtimeJSON    = "pilot-runtime.json"
	mutexName      = "Local\\GTCTRestaurantPilotMutex"
)

type runtimePrefs struct {
	BackupDir string `json:"backupDir"`
	Port      int    `json:"port"`
}

func main() {
	if !claimSingleInstance() {
		_ = messageBox(appTitle, "GTCT Restaurant Pilot is already running.\nOpening the application in your browser.", 0x40)
		prefs := loadPrefs(dataDir())
		openBrowser(fmt.Sprintf("http://127.0.0.1:%d/", prefs.PortOrDefault()))
		return
	}

	installRoot, err := os.Executable()
	if err != nil {
		fatal("Could not locate the application folder.")
	}
	installRoot = filepath.Dir(installRoot)
	appRoot := filepath.Join(installRoot, "app")
	entry := filepath.Join(appRoot, "src", "index.js")
	nodeExe := filepath.Join(installRoot, "runtime", nodeArchDir(), "node.exe")

	if _, err := os.Stat(nodeExe); err != nil {
		fatal("Bundled Node.js runtime is missing for this PC architecture (" + runtime.GOARCH + ").\nReinstall using the matching Windows installer.")
	}
	if _, err := os.Stat(entry); err != nil {
		fatal("Application files are missing. Please reinstall GTCT Restaurant Pilot.")
	}

	data := dataDir()
	backup := filepath.Join(localAppData(), backupFolder)
	prefs := loadPrefs(data)
	if prefs.BackupDir != "" {
		backup = prefs.BackupDir
	}
	_ = os.MkdirAll(data, 0o755)
	_ = os.MkdirAll(backup, 0o755)

	port := prefs.PortOrDefault()
	if !portFree(port) {
		alt, ok := findFreePort(port+1, port+30)
		if !ok {
			fatal(fmt.Sprintf("Port %d is already in use and no free fallback port was found.\nStop the other program, then try again.", port))
		}
		_ = messageBox(appTitle, fmt.Sprintf("Port %d is busy.\nUsing port %d for this session.", port, alt), 0x30)
		port = alt
	}

	env := os.Environ()
	env = setEnv(env, "GTCT_OPERATING_MODE", "TEST")
	env = setEnv(env, "GTCT_LOCAL_HOST", "127.0.0.1")
	env = setEnv(env, "GTCT_LOCAL_PORT", strconv.Itoa(port))
	env = setEnv(env, "GTCT_LOCAL_DATA_DIR", data)
	env = setEnv(env, "GTCT_TEST_BACKUP_DIR", backup)
	// Do not force GTCT_ENABLE_PHYSICAL_PRINT. Persistent Printer Settings control
	// automatic physical printing; unset env defers to that shop setting.
	// Operators may still set GTCT_ENABLE_PHYSICAL_PRINT=false as a kill switch.
	env = setEnv(env, "GTCT_ALLOW_DEV_TOKEN", "false")
	env = setEnv(env, "GTCT_ALLOW_LAN_BIND", "false")
	env = setEnv(env, "GTCT_ENABLE_LAN_LISTENER", "false")

	cmd := exec.Command(nodeExe, entry)
	cmd.Dir = appRoot
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		fatal("Could not start the restaurant server:\n" + err.Error())
	}

	url := fmt.Sprintf("http://127.0.0.1:%d", port)
	if !waitHealthy(url+"/health", 45*time.Second) {
		_ = cmd.Process.Kill()
		fatal("The restaurant server did not become ready.\nCheck that the installation is complete and try again.")
	}

	openPath := url + "/"
	if needsSetup(url + "/v1/setup/status") {
		openPath = url + "/setup.html"
	}
	_ = openBrowser(openPath)

	_ = messageBox(appTitle,
		"GTCT Restaurant Pilot (TEST) is running.\n\n"+
			"Application: "+url+"/\n"+
			"Data folder: "+data+"\n\n"+
			"Automatic physical printing follows Printer Settings.\n"+
			"DISPATCHED means the socket write finished — not confirmed paper.\n"+
			"Click OK to stop the server and close the pilot.",
		0x40)

	stopProcess(cmd)
}

func (p runtimePrefs) PortOrDefault() int {
	if p.Port >= 1 && p.Port <= 65535 {
		return p.Port
	}
	return defaultPort
}

func nodeArchDir() string {
	switch runtime.GOARCH {
	case "amd64":
		return "win-x64"
	case "arm64":
		return "win-arm64"
	default:
		return "win-" + runtime.GOARCH
	}
}

func localAppData() string {
	if v := strings.TrimSpace(os.Getenv("LOCALAPPDATA")); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "AppData", "Local")
}

func dataDir() string {
	return filepath.Join(localAppData(), productFolder)
}

func loadPrefs(data string) runtimePrefs {
	raw, err := os.ReadFile(filepath.Join(data, runtimeJSON))
	if err != nil {
		return runtimePrefs{}
	}
	var prefs runtimePrefs
	if json.Unmarshal(raw, &prefs) != nil {
		return runtimePrefs{}
	}
	return prefs
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	found := false
	for _, item := range env {
		if strings.HasPrefix(strings.ToUpper(item), strings.ToUpper(prefix)) {
			out = append(out, prefix+value)
			found = true
			continue
		}
		out = append(out, item)
	}
	if !found {
		out = append(out, prefix+value)
	}
	return out
}

func portFree(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = ln.Close()
	return true
}

func findFreePort(from, to int) (int, bool) {
	for p := from; p <= to; p++ {
		if portFree(p) {
			return p, true
		}
	}
	return 0, false
}

func waitHealthy(url string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	client := &http.Client{Timeout: 2 * time.Second}
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				return true
			}
		}
		time.Sleep(250 * time.Millisecond)
	}
	return false
}

func needsSetup(url string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	var body struct {
		NeedsSetup bool `json:"needsSetup"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil {
		return false
	}
	return body.NeedsSetup
}

func openBrowser(url string) error {
	cmd := exec.Command("cmd", "/c", "start", "", url)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return cmd.Start()
}

func stopProcess(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
	_, _ = cmd.Process.Wait()
}

func fatal(msg string) {
	_ = messageBox(appTitle, msg, 0x10)
	os.Exit(1)
}

var (
	modKernel32        = syscall.NewLazyDLL("kernel32.dll")
	modUser32          = syscall.NewLazyDLL("user32.dll")
	procCreateMutexW   = modKernel32.NewProc("CreateMutexW")
	procMessageBoxW    = modUser32.NewProc("MessageBoxW")
	procGetLastError   = modKernel32.NewProc("GetLastError")
	errorAlreadyExists = uintptr(183)
	mutexHandle        uintptr
)

func claimSingleInstance() bool {
	name, err := syscall.UTF16PtrFromString(mutexName)
	if err != nil {
		return true
	}
	handle, _, _ := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if handle == 0 {
		return true
	}
	errno, _, _ := procGetLastError.Call()
	if errno == errorAlreadyExists {
		return false
	}
	// Keep the mutex handle for the process lifetime (intentionally not closed).
	mutexHandle = handle
	return true
}

func messageBox(title, text string, flags uint) error {
	t, err := syscall.UTF16PtrFromString(title)
	if err != nil {
		return err
	}
	b, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		return err
	}
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(b)), uintptr(unsafe.Pointer(t)), uintptr(flags))
	return nil
}
