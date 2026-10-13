//go:build windows

package main

import (
	"testing"
	"unsafe"
)

func TestNativeTrayLifecycle(t *testing.T) {
	if unsafe.Sizeof(trayData{}) != 976 || unsafe.Sizeof(trayClass{}) != 80 || unsafe.Sizeof(trayMessage{}) != 48 {
		t.Fatal("Win64 notification ABI mismatch")
	}
	if window, _, _ := trayUser.NewProc("FindWindowW").Call(uintptr(unsafe.Pointer(trayString("Shell_TrayWnd"))), 0); window == 0 {
		t.Skip("Windows taskbar not present in this session")
	}
	tray, err := newNativeTray(func() {}, func() {})
	if err != nil {
		t.Fatal(err)
	}
	if tray.window == 0 {
		t.Fatal("No notification window")
	}
	tray.close()
	tray.close()
	// Reopening after closing must release the class and thread correctly.
	tray, err = newNativeTray(func() {}, func() {})
	if err != nil {
		t.Fatal(err)
	}
	tray.close()
}
