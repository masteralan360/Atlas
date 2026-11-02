"""Send a timed keyboard-wedge scan to the focused Atlas window on Windows.

No Python packages or scanner hardware are required. Example:
  py scripts/postal-auto-scan-simulator.py --qr "atlas:postal:v1:<shipment-qr-uuid>" --delay 5
"""

import argparse
import ctypes
import math
import os
import sys
import time
from ctypes import wintypes


if os.name != "nt":
    raise SystemExit("This keyboard-wedge simulator requires Windows.")


ULONG_PTR = ctypes.c_size_t
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
VK_RETURN = 0x0D
VK_SHIFT = 0x10


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class INPUTUNION(ctypes.Union):
    # INPUT must be the same size as the native Windows union, even when this
    # script only sends keyboard events. SendInput rejects an undersized INPUT.
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("union",)
    _fields_ = [("type", wintypes.DWORD), ("union", INPUTUNION)]


user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.SendInput.argtypes = [wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
user32.SendInput.restype = wintypes.UINT
user32.VkKeyScanExW.argtypes = [wintypes.WCHAR, wintypes.HANDLE]
user32.VkKeyScanExW.restype = ctypes.c_short
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetKeyboardLayout.argtypes = [wintypes.DWORD]
user32.GetKeyboardLayout.restype = wintypes.HANDLE


def send_key(vk: int, key_up: bool = False) -> None:
    event = INPUT()
    event.type = INPUT_KEYBOARD
    event.ki = KEYBDINPUT(
        wVk=vk,
        wScan=0,
        dwFlags=KEYEVENTF_KEYUP if key_up else 0,
        time=0,
        dwExtraInfo=0,
    )
    if user32.SendInput(1, ctypes.byref(event), ctypes.sizeof(INPUT)) != 1:
        raise ctypes.WinError(ctypes.get_last_error())


def foreground_info() -> tuple[str, int]:
    window = user32.GetForegroundWindow()
    if not window:
        return "", 0
    length = user32.GetWindowTextLengthW(window)
    title = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(window, title, len(title))
    thread_id = user32.GetWindowThreadProcessId(window, None)
    return title.value, user32.GetKeyboardLayout(thread_id)


def send_scanner_text(value: str, keyboard_layout: int) -> None:
    for character in value:
        key = user32.VkKeyScanExW(character, keyboard_layout)
        if key == -1:
            raise ValueError(
                f"Character {character!r} is not available on the active Windows keyboard layout."
            )
        virtual_key = key & 0xFF
        modifiers = (key >> 8) & 0xFF
        if modifiers & ~1:
            raise ValueError(f"Character {character!r} needs unsupported keyboard modifiers.")

        if modifiers & 1:
            send_key(VK_SHIFT)
        send_key(virtual_key)
        send_key(virtual_key, key_up=True)
        if modifiers & 1:
            send_key(VK_SHIFT, key_up=True)
        # Scanner-like pacing: fast enough for Auto Scan's timing threshold.
        time.sleep(0.002)

    send_key(VK_RETURN)
    send_key(VK_RETURN, key_up=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Type a custom QR payload into Atlas like a USB HID keyboard-wedge scanner."
    )
    parser.add_argument(
        "--qr",
        help="Exact QR text to scan, e.g. atlas:postal:v1:<shipment-qr-uuid>.",
    )
    parser.add_argument("--delay", type=float, default=5, help="Seconds to wait before typing (default: 5).")
    parser.add_argument("--repeat", type=int, default=1, help="Number of scans to send (default: 1).")
    parser.add_argument(
        "--interval",
        type=float,
        default=2,
        help="Seconds between repeated scans (default: 2).",
    )
    args = parser.parse_args()

    qr_value = (args.qr if args.qr is not None else input("QR text: ")).strip()
    if not qr_value:
        parser.error("QR text cannot be empty.")
    if "\r" in qr_value or "\n" in qr_value or "\t" in qr_value:
        parser.error("QR text cannot contain Enter, newline, or tab characters.")
    if args.delay < 0 or args.interval < 0 or args.repeat < 1:
        parser.error("Delay and interval must be non-negative, and repeat must be at least 1.")

    print("Focus the Atlas Post Service window, enable Auto Scan, and keep text fields unfocused.", flush=True)
    print(f"Sending {args.repeat} scan(s) in {args.delay:g} second(s).", flush=True)
    deadline = time.monotonic() + args.delay
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        print(f"  {math.ceil(remaining)}…", flush=True)
        time.sleep(min(1, remaining))

    title, keyboard_layout = foreground_info()
    if "atlas" not in title.casefold():
        print(f"Stopped safely: the foreground window is {title!r}, not Atlas.", file=sys.stderr)
        return 2

    for index in range(args.repeat):
        if index:
            time.sleep(args.interval)
        try:
            send_scanner_text(qr_value, keyboard_layout)
        except (OSError, ValueError) as error:
            print(f"Could not send scan: {error}", file=sys.stderr)
            return 1
        print(f"Scan {index + 1}/{args.repeat} sent to {title!r}.", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
