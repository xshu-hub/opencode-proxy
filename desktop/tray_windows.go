//go:build windows

package main

import (
	"encoding/binary"
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

// A separate Win32 message loop keeps the notification icon alive while Wails'
// window is hidden. No helper process or visible console is needed.
var trayUser = syscall.NewLazyDLL("user32.dll")
var trayShell = syscall.NewLazyDLL("shell32.dll")
var trayKernel = syscall.NewLazyDLL("kernel32.dll")
var trayDef = trayUser.NewProc("DefWindowProcW")
var trayPost = trayUser.NewProc("PostMessageW")
var trayNotify = trayShell.NewProc("Shell_NotifyIconW")

type trayClass struct {
	Size, Style                        uint32
	Proc                               uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	Menu, Name                         *uint16
	SmallIcon                          uintptr
}
type trayPoint struct{ X, Y int32 }
type trayMessage struct {
	Window         uintptr
	Message        uint32
	WParam, LParam uintptr
	Time           uint32
	Point          trayPoint
	Private        uint32
}
type trayData struct {
	Size                uint32
	Window              uintptr
	ID, Flags, Callback uint32
	Icon                uintptr
	Tip                 [128]uint16
	State, StateMask    uint32
	Info                [256]uint16
	Version             uint32
	InfoTitle           [64]uint16
	InfoFlags           uint32
	GUID                [16]byte
	Balloon             uintptr
}
type nativeTray struct {
	window uintptr
	done   chan struct{}
	once   sync.Once
}

const trayCallback = 0x8001
const trayStop = 0x8002

func trayString(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }
func trayIconPixels() []byte {
	const n = 32
	data := make([]byte, 40+n*n*4+n*4)
	binary.LittleEndian.PutUint32(data[0:], 40)
	binary.LittleEndian.PutUint32(data[4:], n)
	binary.LittleEndian.PutUint32(data[8:], n*2)
	binary.LittleEndian.PutUint16(data[12:], 1)
	binary.LittleEndian.PutUint16(data[14:], 32)
	for y := 0; y < n; y++ {
		for x := 0; x < n; x++ {
			i := 40 + ((n-1-y)*n+x)*4
			data[i], data[i+1], data[i+2], data[i+3] = 216, 73, 86, 255
			if (x >= 6 && x < 26 && ((y >= 5 && y < 9) || (y >= 23 && y < 27))) || (y >= 5 && y < 27 && ((x >= 6 && x < 10) || (x >= 22 && x < 26))) || (x >= 13 && x < 19 && y >= 11 && y < 21) {
				data[i], data[i+1], data[i+2] = 255, 255, 255
			}
		}
	}
	return data
}

func newNativeTray(show, quit func()) (*nativeTray, error) {
	t := &nativeTray{done: make(chan struct{})}
	started := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(t.done)
		instance, _, _ := trayKernel.NewProc("GetModuleHandleW").Call(0)
		restarted, _, _ := trayUser.NewProc("RegisterWindowMessageW").Call(uintptr(unsafe.Pointer(trayString("TaskbarCreated"))))
		pixels := trayIconPixels()
		icon, _, err := trayUser.NewProc("CreateIconFromResourceEx").Call(uintptr(unsafe.Pointer(&pixels[0])), uintptr(len(pixels)), 1, 0x30000, 32, 32, 0)
		if icon == 0 {
			started <- fmt.Errorf("tray icon: %w", err)
			return
		}
		defer trayUser.NewProc("DestroyIcon").Call(icon)
		data := trayData{ID: 1, Flags: 1 | 2 | 4, Callback: trayCallback, Icon: icon}
		data.Size = uint32(unsafe.Sizeof(data))
		copy(data.Tip[:], syscall.StringToUTF16("OpenCode Proxy · 关闭窗口后继续运行"))
		add := func() bool { r, _, _ := trayNotify.Call(0, uintptr(unsafe.Pointer(&data))); return r != 0 }
		proc := syscall.NewCallback(func(hwnd uintptr, msg uint32, wp, lp uintptr) uintptr {
			if msg == uint32(restarted) {
				add()
				return 0
			}
			switch msg {
			case trayCallback:
				switch uint32(lp) {
				case 0x202, 0x203, 0x400, 0x401:
					go show()
				case 0x205, 0x7b:
					menu, _, _ := trayUser.NewProc("CreatePopupMenu").Call()
					if menu == 0 {
						return 0
					}
					defer trayUser.NewProc("DestroyMenu").Call(menu)
					trayUser.NewProc("AppendMenuW").Call(menu, 0, 1, uintptr(unsafe.Pointer(trayString("打开 OpenCode Proxy"))))
					trayUser.NewProc("AppendMenuW").Call(menu, 0x800, 0, 0)
					trayUser.NewProc("AppendMenuW").Call(menu, 0, 2, uintptr(unsafe.Pointer(trayString("退出并停止服务"))))
					var point trayPoint
					trayUser.NewProc("GetCursorPos").Call(uintptr(unsafe.Pointer(&point)))
					trayUser.NewProc("SetForegroundWindow").Call(hwnd)
					selected, _, _ := trayUser.NewProc("TrackPopupMenu").Call(menu, 0x100|0x2, uintptr(point.X), uintptr(point.Y), 0, hwnd, 0)
					trayPost.Call(hwnd, 0, 0, 0)
					if selected == 1 {
						go show()
					} else if selected == 2 {
						go quit()
					}
				}
				return 0
			case trayStop:
				trayUser.NewProc("DestroyWindow").Call(hwnd)
				return 0
			case 0x2:
				trayNotify.Call(2, uintptr(unsafe.Pointer(&data)))
				trayUser.NewProc("PostQuitMessage").Call(0)
				return 0
			}
			r, _, _ := trayDef.Call(hwnd, uintptr(msg), wp, lp)
			return r
		})
		class := trayClass{Proc: proc, Instance: instance, Name: trayString("OpenCodeProxyNotification")}
		class.Size = uint32(unsafe.Sizeof(class))
		atom, _, err := trayUser.NewProc("RegisterClassExW").Call(uintptr(unsafe.Pointer(&class)))
		if atom == 0 {
			started <- fmt.Errorf("tray class: %w", err)
			return
		}
		defer trayUser.NewProc("UnregisterClassW").Call(uintptr(unsafe.Pointer(class.Name)), instance)
		window, _, err := trayUser.NewProc("CreateWindowExW").Call(0, uintptr(unsafe.Pointer(class.Name)), uintptr(unsafe.Pointer(trayString("OpenCode Proxy notification"))), 0, 0, 0, 0, 0, 0, 0, instance, 0)
		if window == 0 {
			started <- fmt.Errorf("tray window: %w", err)
			return
		}
		t.window = window
		data.Window = window
		if !add() {
			trayUser.NewProc("DestroyWindow").Call(window)
			started <- fmt.Errorf("无法添加 Windows 托盘图标")
			return
		}
		started <- nil
		var msg trayMessage
		for {
			r, _, _ := trayUser.NewProc("GetMessageW").Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
			if int32(r) <= 0 {
				break
			}
			trayUser.NewProc("TranslateMessage").Call(uintptr(unsafe.Pointer(&msg)))
			trayUser.NewProc("DispatchMessageW").Call(uintptr(unsafe.Pointer(&msg)))
		}
	}()
	if err := <-started; err != nil {
		return nil, err
	}
	return t, nil
}
func (t *nativeTray) close() {
	if t == nil {
		return
	}
	t.once.Do(func() { trayPost.Call(t.window, trayStop, 0, 0) })
	<-t.done
}
