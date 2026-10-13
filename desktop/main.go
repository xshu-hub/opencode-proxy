//go:build windows

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

//go:embed all:ui
var frontend embed.FS

type Desktop struct {
	ctx        context.Context
	token      string
	backend    *exec.Cmd
	ready      chan struct{}
	done       chan error
	mu         sync.Mutex
	adminURL   string
	startError string
	tray       *nativeTray
	trayError  string
	trayReady  chan struct{}
	quitting   atomic.Bool
}

func (d *Desktop) startup(ctx context.Context) {
	d.ctx = ctx
	tray, err := newNativeTray(d.ShowWindow, d.Quit)
	if err != nil {
		d.trayError = err.Error()
	} else {
		d.tray = tray
	}
	close(d.trayReady)
	go d.startBackend()
}

func (d *Desktop) ShowWindow() { runtime.WindowShow(d.ctx); runtime.WindowUnminimise(d.ctx) }
func (d *Desktop) HideToTray() error {
	<-d.trayReady
	if d.tray == nil {
		return fmt.Errorf("托盘不可用，无法隐藏窗口。")
	}
	runtime.WindowHide(d.ctx)
	return nil
}
func (d *Desktop) Quit() { d.quitting.Store(true); runtime.Quit(d.ctx) }
func (d *Desktop) DesktopInfo() map[string]interface{} {
	<-d.trayReady
	return map[string]interface{}{"trayAvailable": d.tray != nil, "trayError": d.trayError}
}
func (d *Desktop) beforeClose(context.Context) bool {
	<-d.trayReady
	if !d.quitting.Load() && d.tray != nil {
		runtime.WindowHide(d.ctx)
		return true
	}
	return false
}
func (d *Desktop) domReady(context.Context) {
	for _, arg := range os.Args[1:] {
		if arg == "--background" || arg == "tray" {
			_ = d.HideToTray()
			return
		}
	}
}

func (d *Desktop) secondInstance(data options.SecondInstanceData) {
	for _, arg := range data.Args {
		if arg == "--background" || arg == "tray" {
			return
		}
	}
	d.ShowWindow()
}

func (d *Desktop) startBackend() {
	defer close(d.ready)
	executable, err := os.Executable()
	if err != nil {
		d.startError = "无法定位程序目录。"
		return
	}
	root := filepath.Dir(executable)
	configRoot, err := os.UserConfigDir()
	if err != nil {
		d.startError = "无法定位用户配置目录。"
		return
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		configRoot = local
	}
	configFile := filepath.Join(configRoot, "OpenCodeProxy", "config.json")
	if file := os.Getenv("OPENCODE_PROXY_CONFIG"); file != "" {
		configFile = file
	}
	backend := exec.Command(filepath.Join(root, "opencode-proxy-server.exe"), "--config", configFile, "--admin-port", "0")
	backend.Dir = root
	backend.Env = append(os.Environ(), "OPENCODE_PROXY_ADMIN_KEY="+d.token, "OPENCODE_PROXY_DESKTOP_PID="+fmt.Sprint(os.Getpid()))
	backend.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	stdout, err := backend.StdoutPipe()
	if err != nil {
		d.startError = "无法初始化服务进程。"
		return
	}
	logFile := filepath.Join(filepath.Dir(configFile), "desktop.log")
	_ = os.MkdirAll(filepath.Dir(configFile), 0700)
	log, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		d.startError = "配置目录无法写入。"
		return
	}
	defer log.Close()
	backend.Stderr = log
	if err = backend.Start(); err != nil {
		d.startError = "无法启动反代服务，请完整解压客户端压缩包。"
		return
	}
	d.backend = backend
	go func() { d.done <- backend.Wait() }()
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 1<<20)
	timeout := time.AfterFunc(30*time.Second, func() { _ = backend.Process.Kill() })
	defer timeout.Stop()
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "OPENCODE_PROXY_READY ") {
			var ready struct {
				AdminURL string `json:"adminURL"`
			}
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "OPENCODE_PROXY_READY ")), &ready) == nil {
				parsed, e := url.Parse(ready.AdminURL)
				if e == nil && parsed.Scheme == "http" && parsed.Hostname() == "127.0.0.1" && parsed.Port() != "" {
					d.adminURL = ready.AdminURL
					// Continue draining stdout without a visible terminal.
					go func() { _, _ = io.Copy(io.Discard, stdout) }()
					return
				}
			}
		}
	}
	d.startError = "服务初始化失败，请查看配置目录中的 desktop.log。"
}

func (d *Desktop) Request(method, path, body string) (string, error) {
	select {
	case <-d.ready:
	case <-time.After(35 * time.Second):
		return "", fmt.Errorf("服务启动超时。")
	}
	if d.startError != "" {
		return "", fmt.Errorf("%s", d.startError)
	}
	if !strings.HasPrefix(path, "/admin/") || strings.Contains(path, "..") || (method != "GET" && method != "POST") {
		return "", fmt.Errorf("管理请求无效。")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, d.adminURL+path, strings.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+d.token)
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("管理服务连接失败。")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 12<<20))
	if err != nil {
		return "", err
	}
	var raw json.RawMessage = data
	result, err := json.Marshal(struct {
		Status int             `json:"status"`
		Data   json.RawMessage `json:"data"`
	}{response.StatusCode, raw})
	return string(result), err
}
func (d *Desktop) SelectDirectory() (string, error) {
	return runtime.OpenDirectoryDialog(d.ctx, runtime.OpenDialogOptions{Title: "选择 OpenCode 工作目录"})
}
func (d *Desktop) SelectExecutable() (string, error) {
	return runtime.OpenFileDialog(d.ctx, runtime.OpenDialogOptions{Title: "选择 OpenCode 可执行程序", Filters: []runtime.FileFilter{{DisplayName: "OpenCode 程序", Pattern: "*.exe;*.cmd;*.ps1"}, {DisplayName: "所有文件", Pattern: "*"}}})
}
func (d *Desktop) CopyText(text string) error { return runtime.ClipboardSetText(d.ctx, text) }

func (d *Desktop) shutdown(context.Context) {
	<-d.trayReady
	d.tray.close()
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.backend == nil || d.backend.Process == nil {
		return
	}
	if d.adminURL != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "POST", d.adminURL+"/admin/shutdown", bytes.NewBufferString("{}"))
		req.Header.Set("Authorization", "Bearer "+d.token)
		if response, err := http.DefaultClient.Do(req); err == nil {
			response.Body.Close()
		}
		cancel()
	}
	select {
	case <-d.done:
	case <-time.After(5 * time.Second):
		_ = d.backend.Process.Kill()
	}
}

func main() {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		panic(err)
	}
	app := &Desktop{token: hex.EncodeToString(secret), ready: make(chan struct{}), done: make(chan error, 1), trayReady: make(chan struct{})}
	assets, _ := fs.Sub(frontend, "ui")
	err := wails.Run(&options.App{Title: "OpenCode Proxy", Width: 1240, Height: 840, MinWidth: 800, MinHeight: 600, BackgroundColour: options.NewRGB(244, 244, 246), AssetServer: &assetserver.Options{Assets: assets}, OnStartup: app.startup, OnDomReady: app.domReady, OnBeforeClose: app.beforeClose, OnShutdown: app.shutdown, Bind: []interface{}{app}, Windows: &windows.Options{WebviewUserDataPath: filepath.Join(os.TempDir(), "OpenCodeProxyWebView"), Theme: windows.SystemDefault}, SingleInstanceLock: &options.SingleInstanceLock{UniqueId: "bdd44f35-e7ee-4b82-b49c-427b098e4e3d", OnSecondInstanceLaunch: app.secondInstance}})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
	}
}
