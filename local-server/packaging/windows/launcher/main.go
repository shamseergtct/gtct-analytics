// GTCT Restaurant Pilot launcher (Windows).
//
//   GTCTRestaurantPilot.exe --host
//     Headless always-on host: LAN HTTPS when possible, no browser UI.
//     Started at Windows logon via Scheduled Task.
//
//   GTCTRestaurantPilot.exe
//     Opens the app in the browser. If the host is already running, only
//     opens the browser. Otherwise starts --host in the background first.
//
// Operating mode remains TEST.
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
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
	appTitle      = "GTCT Restaurant Pilot (TEST)"
	defaultPort   = 8787
	productFolder = "GTCT\\RestaurantPilot"
	backupFolder  = "GTCT\\RestaurantPilot-Backups"
	runtimeJSON   = "pilot-runtime.json"
	hostMutexName = "Local\\GTCTRestaurantHostMutex"
	defaultLanHost = "gtct-pos"
)

type runtimePrefs struct {
	BackupDir   string `json:"backupDir"`
	Port        int    `json:"port"`
	LanEnabled  *bool  `json:"lanEnabled"`
	BindAddress string `json:"bindAddress"`
	LanHostname string `json:"lanHostname"`
	LastBaseURL string `json:"lastBaseUrl"`
}

func main() {
	hostMode := false
	for _, a := range os.Args[1:] {
		if a == "--host" || a == "-host" {
			hostMode = true
		}
	}
	if hostMode {
		runHost()
		return
	}
	runApp()
}

func runApp() {
	data := dataDir()
	_ = os.MkdirAll(data, 0o755)
	prefs := loadPrefs(data)
	port := prefs.PortOrDefault()

	if base, ok := discoverHealthyBase(prefs, port); ok {
		openApp(base)
		return
	}

	// Start headless host in the background, then open the browser.
	exe, err := os.Executable()
	if err != nil {
		fatal("Could not locate the application folder.")
	}
	cmd := exec.Command(exe, "--host")
	cmd.Dir = filepath.Dir(exe)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008 | 0x00000200 | 0x08000000, // DETACHED | NEW_GROUP | NO_WINDOW
	}
	if err := cmd.Start(); err != nil {
		fatal("Could not start the restaurant host:\n" + err.Error())
	}
	_ = cmd.Process.Release()

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		prefs = loadPrefs(data)
		if base, ok := discoverHealthyBase(prefs, port); ok {
			openApp(base)
			return
		}
		time.Sleep(400 * time.Millisecond)
	}
	fatal("The restaurant host did not become ready.\nCheck host.log under the data folder, then try again.")
}

func runHost() {
	if !claimHostMutex() {
		// Already running — success for Scheduled Task restarts.
		os.Exit(0)
	}
	// Long-lived host: if the LAN address changes (new router / Wi-Fi) or the
	// network comes back, hostCycle returns true and we start again on the
	// current address. Returns only when the node server itself exits.
	for {
		if !hostCycle() {
			return
		}
		time.Sleep(2 * time.Second)
	}
}

// hostCycle runs one server lifetime. It returns true when the host should be
// restarted because the network address changed.
func hostCycle() bool {
	installRoot, err := os.Executable()
	if err != nil {
		hostFatal("Could not locate the application folder.")
	}
	installRoot = filepath.Dir(installRoot)
	appRoot := filepath.Join(installRoot, "app")
	entry := filepath.Join(appRoot, "src", "index.js")
	nodeExe := filepath.Join(installRoot, "runtime", nodeArchDir(), "node.exe")

	if _, err := os.Stat(nodeExe); err != nil {
		hostFatal("Bundled Node.js runtime is missing for this PC architecture (" + runtime.GOARCH + ").")
	}
	if _, err := os.Stat(entry); err != nil {
		hostFatal("Application files are missing. Please reinstall GTCT Restaurant Pilot.")
	}

	data := dataDir()
	backup := filepath.Join(localAppData(), backupFolder)
	prefs := loadPrefs(data)
	if prefs.BackupDir != "" {
		backup = prefs.BackupDir
	}
	_ = os.MkdirAll(data, 0o755)
	_ = os.MkdirAll(backup, 0o755)
	_ = os.MkdirAll(filepath.Join(data, "tls"), 0o755)
	_ = os.MkdirAll(filepath.Join(data, "logs"), 0o755)

	logFile := openHostLog(data)
	defer logFile.Close()
	logf := func(format string, args ...any) {
		line := fmt.Sprintf(time.Now().Format("2006-01-02 15:04:05")+" "+format+"\n", args...)
		_, _ = io.WriteString(logFile, line)
	}

	port := prefs.PortOrDefault()
	lanHostname := strings.TrimSpace(prefs.LanHostname)
	if lanHostname == "" {
		lanHostname = defaultLanHost
	}
	lanEnabled := prefs.LanOn()

	// The saved address is only a hint: it must be a private LAN address that
	// still exists on this PC. Otherwise (router/Wi-Fi changed, no network)
	// detect the current one. With no LAN address the host stays on loopback.
	bindIP := strings.TrimSpace(prefs.BindAddress)
	if bindIP != "" && !(isPrivateLanIPv4(bindIP) && ipOnThisPC(bindIP)) {
		if isPrivateLanIPv4(bindIP) {
			logf("Saved LAN address %s is not on this PC any more; detecting the current one", bindIP)
		}
		bindIP = ""
	}
	if bindIP == "" {
		bindIP = detectPrivateIPv4()
	}

	useLAN := lanEnabled && isPrivateLanIPv4(bindIP)
	var certFile, keyFile string
	host := "127.0.0.1"
	baseScheme := "http"

	if useLAN {
		var cerr error
		certFile, keyFile, cerr = ensureLanCert(filepath.Join(data, "tls"), lanHostname, bindIP)
		if cerr != nil {
			logf("TLS cert failed (%v); falling back to loopback HTTP", cerr)
			useLAN = false
		} else {
			host = bindIP
			baseScheme = "https"
			ensureFirewallRule(port, logf)
		}
	} else {
		logf("LAN disabled or no private IPv4; binding loopback only")
	}

	baseProbe := fmt.Sprintf("%s://%s:%d", baseScheme, host, port)
	if waitHealthy(baseProbe+"/health", 2*time.Second) {
		savePrefs(data, prefsWithURL(prefs, baseProbe, host, lanHostname, lanEnabled))
		_ = os.WriteFile(filepath.Join(data, "current-url.txt"), []byte(baseProbe+"\n"), 0o644)
		logf("Server already healthy at %s — host exiting (single instance)", baseProbe)
		os.Exit(0)
	}
	if err := tryListen(host, port); err != nil {
		hostFatal(fmt.Sprintf("Cannot listen on %s:%d.\n%v", host, port, err))
	}

	env := os.Environ()
	env = setEnv(env, "GTCT_OPERATING_MODE", "TEST")
	env = setEnv(env, "GTCT_LOCAL_PORT", strconv.Itoa(port))
	env = setEnv(env, "GTCT_LOCAL_DATA_DIR", data)
	env = setEnv(env, "GTCT_TEST_BACKUP_DIR", backup)
	env = setEnv(env, "GTCT_ALLOW_DEV_TOKEN", "false")

	if useLAN {
		env = setEnv(env, "GTCT_LOCAL_HOST", host)
		env = setEnv(env, "GTCT_LAN_BIND_ADDRESS", host)
		env = setEnv(env, "GTCT_ALLOW_LAN_BIND", "true")
		env = setEnv(env, "GTCT_ENABLE_LAN_LISTENER", "true")
		env = setEnv(env, "GTCT_LAN_HOSTNAME", lanHostname)
		env = setEnv(env, "GTCT_TLS_CERT_FILE", certFile)
		env = setEnv(env, "GTCT_TLS_KEY_FILE", keyFile)
	} else {
		env = setEnv(env, "GTCT_LOCAL_HOST", "127.0.0.1")
		env = setEnv(env, "GTCT_ALLOW_LAN_BIND", "false")
		env = setEnv(env, "GTCT_ENABLE_LAN_LISTENER", "false")
	}

	cmd := exec.Command(nodeExe, entry)
	cmd.Dir = appRoot
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		hostFatal("Could not start the restaurant server:\n" + err.Error())
	}
	logf("Started node pid=%d host=%s port=%d lan=%v", cmd.Process.Pid, host, port, useLAN)

	base := fmt.Sprintf("%s://%s:%d", baseScheme, host, port)
	if useLAN {
		// Also expose loopback-friendly URL for local browser when possible.
		// Health is on the LAN bind address.
	}
	if !waitHealthy(base+"/health", 60*time.Second) {
		_ = cmd.Process.Kill()
		hostFatal("The restaurant server did not become ready. See host.log.")
	}

	prefs = prefsWithURL(prefs, base, host, lanHostname, lanEnabled)
	savePrefs(data, prefs)
	_ = os.WriteFile(filepath.Join(data, "current-url.txt"), []byte(base+"\n"), 0o644)
	logf("Healthy at %s  pair=%s/pair.html", base, base)

	done := make(chan struct{})
	go func() {
		_, _ = cmd.Process.Wait()
		close(done)
	}()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			logf("Node process exited")
			return false
		case <-ticker.C:
			if useLAN && !ipOnThisPC(host) {
				logf("LAN address %s is gone; restarting on the current address", host)
				_ = cmd.Process.Kill()
				<-done
				return true
			}
			if !useLAN && lanEnabled && detectPrivateIPv4() != "" {
				logf("Network is available again; restarting with LAN")
				_ = cmd.Process.Kill()
				<-done
				return true
			}
		}
	}
}

func openApp(base string) {
	path := base + "/"
	if needsSetup(base + "/v1/setup/status") {
		path = base + "/setup.html"
	}
	_ = openBrowser(path)
}

func prefsWithURL(p runtimePrefs, base, bind, hostname string, lanEnabled bool) runtimePrefs {
	on := lanEnabled
	p.LanEnabled = &on
	p.BindAddress = bind
	p.LanHostname = hostname
	p.LastBaseURL = base
	if p.Port == 0 {
		p.Port = defaultPort
	}
	return p
}

func (p runtimePrefs) PortOrDefault() int {
	if p.Port >= 1 && p.Port <= 65535 {
		return p.Port
	}
	return defaultPort
}

func (p runtimePrefs) LanOn() bool {
	if p.LanEnabled == nil {
		return true // default on for new always-on host
	}
	return *p.LanEnabled
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

func savePrefs(data string, prefs runtimePrefs) {
	raw, err := json.MarshalIndent(prefs, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(data, runtimeJSON), raw, 0o644)
}

func openHostLog(data string) *os.File {
	path := filepath.Join(data, "logs", "host.log")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		f, err = os.OpenFile(filepath.Join(data, "host.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	}
	if err != nil {
		return os.Stderr
	}
	return f
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

func insecureHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 2 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // local self-signed TEST cert
		},
	}
}

func discoverHealthyBase(prefs runtimePrefs, port int) (string, bool) {
	candidates := []string{}
	if prefs.LastBaseURL != "" {
		candidates = append(candidates, strings.TrimRight(prefs.LastBaseURL, "/"))
	}
	if bind := strings.TrimSpace(prefs.BindAddress); isPrivateLanIPv4(bind) {
		candidates = append(candidates, fmt.Sprintf("https://%s:%d", bind, port))
	}
	if ip := detectPrivateIPv4(); ip != "" {
		candidates = append(candidates, fmt.Sprintf("https://%s:%d", ip, port))
	}
	candidates = append(candidates,
		fmt.Sprintf("http://127.0.0.1:%d", port),
		fmt.Sprintf("https://127.0.0.1:%d", port),
	)
	seen := map[string]bool{}
	for _, base := range candidates {
		if base == "" || seen[base] {
			continue
		}
		seen[base] = true
		if waitHealthy(base+"/health", 1500*time.Millisecond) {
			return base, true
		}
	}
	return "", false
}

func tryListen(host string, port int) error {
	ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
	if err != nil {
		return err
	}
	_ = ln.Close()
	return nil
}

// ipOnThisPC reports whether ip is currently assigned to an up interface.
func ipOnThisPC(ip string) bool {
	want := net.ParseIP(strings.TrimSpace(ip))
	if want == nil {
		return false
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		return false
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			switch v := addr.(type) {
			case *net.IPNet:
				if v.IP.Equal(want) {
					return true
				}
			case *net.IPAddr:
				if v.IP.Equal(want) {
					return true
				}
			}
		}
	}
	return false
}

func waitHealthy(url string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	client := insecureHTTPClient()
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
	client := insecureHTTPClient()
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

func detectPrivateIPv4() string {
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	var fallback string
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			var ip net.IP
			switch v := addr.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil {
				continue
			}
			ip = ip.To4()
			if ip == nil || !isPrivateLanIPv4(ip.String()) {
				continue
			}
			name := strings.ToLower(iface.Name)
			if strings.Contains(name, "wi-fi") || strings.Contains(name, "wifi") ||
				strings.Contains(name, "ethernet") || strings.Contains(name, "wlan") ||
				strings.Contains(name, "eth") {
				return ip.String()
			}
			if fallback == "" {
				fallback = ip.String()
			}
		}
	}
	return fallback
}

func isPrivateLanIPv4(s string) bool {
	ip := net.ParseIP(strings.TrimSpace(s))
	if ip == nil {
		return false
	}
	ip4 := ip.To4()
	if ip4 == nil {
		return false
	}
	if ip4[0] == 10 {
		return true
	}
	if ip4[0] == 192 && ip4[1] == 168 {
		return true
	}
	if ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31 {
		return true
	}
	return false
}

func ensureLanCert(tlsDir, hostname, lanIP string) (certPath, keyPath string, err error) {
	_ = os.MkdirAll(tlsDir, 0o755)
	certPath = filepath.Join(tlsDir, hostname+".crt")
	keyPath = filepath.Join(tlsDir, hostname+".key")
	metaPath := filepath.Join(tlsDir, hostname+".ip")

	needNew := true
	if raw, rerr := os.ReadFile(metaPath); rerr == nil && strings.TrimSpace(string(raw)) == lanIP {
		if _, e1 := os.Stat(certPath); e1 == nil {
			if _, e2 := os.Stat(keyPath); e2 == nil {
				needNew = false
			}
		}
	}
	if !needNew {
		return certPath, keyPath, nil
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return "", "", err
	}
	serial, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		return "", "", err
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   hostname,
			Organization: []string{"GTCT Restaurant TEST"},
			OrganizationalUnit: []string{"Local Terminal LAN"},
		},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(825 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{hostname},
		IPAddresses:           []net.IP{net.ParseIP(lanIP)},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return "", "", err
	}
	certOut, err := os.Create(certPath)
	if err != nil {
		return "", "", err
	}
	if err := pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		_ = certOut.Close()
		return "", "", err
	}
	_ = certOut.Close()

	keyOut, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", "", err
	}
	if err := pem.Encode(keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}); err != nil {
		_ = keyOut.Close()
		return "", "", err
	}
	_ = keyOut.Close()
	_ = os.WriteFile(metaPath, []byte(lanIP+"\n"), 0o644)
	return certPath, keyPath, nil
}

func ensureFirewallRule(port int, logf func(string, ...any)) {
	name := "GTCT Restaurant Pilot HTTPS"
	// Delete old rule (ignore errors), then allow inbound on all profiles.
	// Scope: private/domain networks and the local subnet only (never Public Wi-Fi or the internet).
	del := exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+name)
	del.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	_ = del.Run()
	add := exec.Command(
		"netsh", "advfirewall", "firewall", "add", "rule",
		"name="+name,
		"dir=in",
		"action=allow",
		"protocol=TCP",
		fmt.Sprintf("localport=%d", port),
		"profile=private,domain",
		"remoteip=localsubnet",
	)
	add.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	if out, err := add.CombinedOutput(); err != nil {
		logf("Firewall rule failed (may need admin once): %v %s", err, strings.TrimSpace(string(out)))
	} else {
		logf("Firewall rule OK for TCP %d (private/domain, local subnet)", port)
	}

	// Best-effort: if pilot locked firewall-off (GPO machines), keep it off.
	for _, override := range []string{
		filepath.Join(os.Getenv("ProgramData"), "GTCT", "RestaurantPilot", "force-firewall-off.txt"),
		filepath.Join(os.Getenv("ProgramData"), "GTCT", "RestaurantPilot", "firewall-disabled-by-pilot.txt"),
		filepath.Join(dataDir(), "firewall-disabled-by-pilot.txt"),
	} {
		if _, err := os.Stat(override); err != nil {
			continue
		}
		off := exec.Command("netsh", "advfirewall", "set", "allprofiles", "state", "off")
		off.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
		if out, err := off.CombinedOutput(); err != nil {
			logf("Pilot firewall-off reapply failed: %v %s", err, strings.TrimSpace(string(out)))
		} else {
			logf("Pilot LAN: Windows Firewall kept OFF (%s)", override)
		}
		break
	}
}

func fatal(msg string) {
	_ = messageBox(appTitle, msg, 0x10)
	os.Exit(1)
}

func hostFatal(msg string) {
	// Prefer log; MessageBox only if interactive session.
	data := dataDir()
	_ = os.MkdirAll(filepath.Join(data, "logs"), 0o755)
	if f := openHostLog(data); f != nil {
		_, _ = io.WriteString(f, time.Now().Format("2006-01-02 15:04:05")+" FATAL "+msg+"\n")
		_ = f.Close()
	}
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

func claimHostMutex() bool {
	name, err := syscall.UTF16PtrFromString(hostMutexName)
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
