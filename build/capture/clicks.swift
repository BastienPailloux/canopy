import AppKit
import ApplicationServices

// Reports global mouse clicks as JSON lines on stdout. Mouse events only: never subscribes to keyboard events.
// Usage: canopy-clicks --check accessibility|input-monitoring|none
var check = "none"
if let i = CommandLine.arguments.firstIndex(of: "--check"), i + 1 < CommandLine.arguments.count {
  check = CommandLine.arguments[i + 1]
}
let trusted: Bool
switch check {
case "accessibility": trusted = AXIsProcessTrusted()
case "input-monitoring": trusted = CGPreflightListenEventAccess()
default: trusted = true
}

setvbuf(stdout, nil, _IOLBF, 0)
print("{\"type\":\"ready\",\"trusted\":\(trusted)}")

// Top-left-origin global points: AppKit's origin is bottom-left of the primary screen.
let primaryHeight = NSScreen.screens[0].frame.height
NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { _ in
  let p = NSEvent.mouseLocation
  print("{\"type\":\"click\",\"t\":\(Int(Date().timeIntervalSince1970 * 1000)),\"x\":\(p.x),\"y\":\(primaryHeight - p.y)}")
}

// The parent closing our stdin means the recording is over: exit instead of lingering as an orphan.
Thread.detachNewThread {
  while FileHandle.standardInput.availableData.count > 0 {}
  exit(0)
}

NSApplication.shared.run()
