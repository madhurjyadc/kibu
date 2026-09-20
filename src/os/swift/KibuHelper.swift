// KibuHelper — macOS integration helper for Kibu.
//
// Speaks newline-delimited JSON on stdin/stdout. One request per line, one
// response per line, correlated by `id`. It is deliberately dumb: it exposes
// capabilities and reports failure honestly. All policy lives in TypeScript.

import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit
import UniformTypeIdentifiers

// MARK: - Wire types

struct Request: Decodable {
    let id: String
    let op: String
    let args: [String: AnyCodable]?
}

struct AnyCodable: Codable {
    let value: Any
    init(_ value: Any) { self.value = value }
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let v = try? c.decode(Bool.self) { value = v }
        else if let v = try? c.decode(Int.self) { value = v }
        else if let v = try? c.decode(Double.self) { value = v }
        else if let v = try? c.decode(String.self) { value = v }
        else if let v = try? c.decode([AnyCodable].self) { value = v.map { $0.value } }
        else if let v = try? c.decode([String: AnyCodable].self) { value = v.mapValues { $0.value } }
        else { value = NSNull() }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case let v as Bool: try c.encode(v)
        case let v as Int: try c.encode(v)
        case let v as Double: try c.encode(v)
        case let v as String: try c.encode(v)
        default: try c.encodeNil()
        }
    }
}

func respond(id: String, ok: Bool, value: Any?, error: String?) {
    var payload: [String: Any] = ["id": id, "ok": ok]
    if let value = value { payload["value"] = value }
    if let error = error { payload["error"] = error }
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
        FileHandle.standardOutput.write("{\"id\":\"\(id)\",\"ok\":false,\"error\":\"encode failed\"}\n".data(using: .utf8)!)
        return
    }
    var out = data
    out.append(0x0A)
    FileHandle.standardOutput.write(out)
}

struct HelperError: Error { let message: String }

// MARK: - Accessibility helpers

func axCopy(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var out: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attribute as CFString, &out)
    return err == .success ? out : nil
}

func axString(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let v = axCopy(element, attribute) else { return nil }
    if let s = v as? String { return s }
    if CFGetTypeID(v) == AXValueGetTypeID() { return nil }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
}

func axBool(_ element: AXUIElement, _ attribute: String) -> Bool {
    guard let v = axCopy(element, attribute) as? NSNumber else { return false }
    return v.boolValue
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    guard let v = axCopy(element, kAXChildrenAttribute as String) else { return [] }
    return (v as? [AXUIElement]) ?? []
}

func axFrame(_ element: AXUIElement) -> CGRect {
    var origin = CGPoint.zero
    var size = CGSize.zero
    if let p = axCopy(element, kAXPositionAttribute as String), CFGetTypeID(p) == AXValueGetTypeID() {
        AXValueGetValue((p as! AXValue), .cgPoint, &origin)
    }
    if let s = axCopy(element, kAXSizeAttribute as String), CFGetTypeID(s) == AXValueGetTypeID() {
        AXValueGetValue((s as! AXValue), .cgSize, &size)
    }
    return CGRect(origin: origin, size: size)
}

func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success,
          let list = names as? [String] else { return [] }
    return list
}

/// A human-usable label: AX exposes the same idea under several attributes.
func axLabel(_ element: AXUIElement) -> String {
    for attr in [kAXTitleAttribute as String,
                 kAXDescriptionAttribute as String,
                 "AXLabel",
                 kAXHelpAttribute as String,
                 kAXPlaceholderValueAttribute as String] {
        if let s = axString(element, attr), !s.isEmpty { return s }
    }
    if let v = axString(element, kAXValueAttribute as String), !v.isEmpty, v.count < 80 { return v }
    return ""
}

/// Roles whose subtrees are interactive and worth walking.
let interestingRoles: Set<String> = [
    "AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXLink", "AXSlider",
    "AXStaticText", "AXCell", "AXRow", "AXTabGroup", "AXToolbar", "AXMenuItem",
    "AXIncrementor", "AXDisclosureTriangle", "AXSearchField"
]

func serializeElement(_ element: AXUIElement, path: [Int], pid: pid_t, windowId: String,
                      depth: Int, maxDepth: Int, budget: inout Int) -> [String: Any]? {
    if budget <= 0 { return nil }
    budget -= 1
    let role = axString(element, kAXRoleAttribute as String) ?? "AXUnknown"
    let frame = axFrame(element)
    let label = axLabel(element)
    let actions = axActions(element)

    var node: [String: Any] = [
        "role": role,
        "title": label,
        "enabled": axBool(element, kAXEnabledAttribute as String),
        "focused": axBool(element, kAXFocusedAttribute as String),
        "frame": ["x": frame.origin.x, "y": frame.origin.y,
                  "width": frame.size.width, "height": frame.size.height],
        "actions": actions,
        "ref": [
            "id": "\(windowId):" + path.map(String.init).joined(separator: "."),
            "pid": Int(pid),
            "windowId": windowId,
            "path": path,
            "stamp": [
                "role": role,
                "title": label,
                "frame": ["x": frame.origin.x, "y": frame.origin.y,
                          "width": frame.size.width, "height": frame.size.height]
            ]
        ]
    ]
    if let sub = axString(element, kAXSubroleAttribute as String) { node["subrole"] = sub }
    if let value = axString(element, kAXValueAttribute as String), value.count < 2000 { node["value"] = value }

    if depth < maxDepth {
        var kids: [[String: Any]] = []
        for (i, child) in axChildren(element).enumerated() {
            if budget <= 0 { break }
            if let c = serializeElement(child, path: path + [i], pid: pid, windowId: windowId,
                                       depth: depth + 1, maxDepth: maxDepth, budget: &budget) {
                kids.append(c)
            }
        }
        if !kids.isEmpty { node["children"] = kids }
    }
    return node
}

func resolveElement(pid: pid_t, windowId: String, path: [Int]) throws -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    guard let windows = axCopy(app, kAXWindowsAttribute as String) as? [AXUIElement] else {
        throw HelperError(message: "application \(pid) exposes no windows")
    }
    let index = windowIndex(from: windowId)
    guard index < windows.count else {
        throw HelperError(message: "window \(windowId) no longer exists")
    }
    var current = windows[index]
    for step in path {
        let kids = axChildren(current)
        guard step < kids.count else {
            throw HelperError(message: "element path no longer resolves (index \(step) out of range)")
        }
        current = kids[step]
    }
    return current
}

func windowIndex(from windowId: String) -> Int {
    Int(windowId.replacingOccurrences(of: "w", with: "")) ?? 0
}

/// Confirms the element still looks like what was observed. Callers pass the
/// stamp recorded at observation time; a mismatch means "re-observe", not "act".
func validateStamp(_ element: AXUIElement, _ stamp: [String: Any]?) throws {
    guard let stamp = stamp else { return }
    let role = axString(element, kAXRoleAttribute as String) ?? "AXUnknown"
    if let expectedRole = stamp["role"] as? String, expectedRole != role {
        throw HelperError(message: "element changed: expected role \(expectedRole), found \(role)")
    }
    if let expectedTitle = stamp["title"] as? String, !expectedTitle.isEmpty {
        let actual = axLabel(element)
        if actual != expectedTitle {
            throw HelperError(message: "element changed: expected \"\(expectedTitle)\", found \"\(actual)\"")
        }
    }
}

// MARK: - Apps and windows

func runningApps() -> [[String: Any]] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .map { app in
            let pid = app.processIdentifier
            let ax = AXUIElementCreateApplication(pid)
            let windows = (axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
            return [
                "bundleId": app.bundleIdentifier ?? "",
                "name": app.localizedName ?? "",
                "pid": Int(pid),
                "active": app.isActive,
                "windowCount": windows.count
            ]
        }
}

func snapshotWindow(pid: pid_t, windowId: String?, maxDepth: Int, maxNodes: Int) throws -> [String: Any] {
    guard let app = NSRunningApplication(processIdentifier: pid) else {
        throw HelperError(message: "no running application with pid \(pid)")
    }
    let ax = AXUIElementCreateApplication(pid)
    guard let windows = axCopy(ax, kAXWindowsAttribute as String) as? [AXUIElement], !windows.isEmpty else {
        throw HelperError(message: "\(app.localizedName ?? "app") has no accessible windows (is Accessibility permission granted?)")
    }
    let index = windowId.map(windowIndex(from:)) ?? 0
    guard index < windows.count else { throw HelperError(message: "window index \(index) out of range") }
    let window = windows[index]
    let wid = "w\(index)"
    let frame = axFrame(window)
    var budget = maxNodes
    let root = serializeElement(window, path: [], pid: pid, windowId: wid,
                                depth: 0, maxDepth: maxDepth, budget: &budget)

    let screen = NSScreen.screens.first { $0.frame.intersects(frame) } ?? NSScreen.main
    let displayId = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0

    return [
        "app": [
            "bundleId": app.bundleIdentifier ?? "",
            "name": app.localizedName ?? "",
            "pid": Int(pid),
            "active": app.isActive,
            "windowCount": windows.count
        ],
        "windowId": wid,
        "title": axString(window, kAXTitleAttribute as String) ?? "",
        "frame": ["x": frame.origin.x, "y": frame.origin.y,
                  "width": frame.size.width, "height": frame.size.height],
        "displayId": displayId,
        "elements": root.flatMap { [$0] } ?? [],
        "observedAt": Date().timeIntervalSince1970 * 1000,
        "truncated": budget <= 0
    ]
}

// MARK: - Synthetic input

let keyCodeMap: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47,
    "tab": 48, "space": 49, "`": 50, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117
]

func parseShortcut(_ spec: String) throws -> (CGKeyCode, CGEventFlags) {
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    for rawPart in spec.lowercased().split(separator: "+") {
        let part = rawPart.trimmingCharacters(in: .whitespaces)
        switch part {
        case "cmd", "command", "meta": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option", "opt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn", "function": flags.insert(.maskSecondaryFn)
        default:
            guard let code = keyCodeMap[part] else {
                throw HelperError(message: "unknown key \"\(part)\" in shortcut \"\(spec)\"")
            }
            key = code
        }
    }
    guard let key = key else { throw HelperError(message: "shortcut \"\(spec)\" names no key") }
    return (key, flags)
}

func postShortcut(_ spec: String) throws {
    let (key, flags) = try parseShortcut(spec)
    let source = CGEventSource(stateID: .combinedSessionState)
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false) else {
        throw HelperError(message: "could not create key events (Accessibility permission required)")
    }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    usleep(12_000)
    up.post(tap: .cghidEventTap)
}

/// Types literal text. Uses unicode payloads so layout and diacritics behave.
func postText(_ text: String) throws {
    let source = CGEventSource(stateID: .combinedSessionState)
    for chunk in text.chunked(into: 16) {
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw HelperError(message: "could not create key events (Accessibility permission required)")
        }
        var utf16 = Array(chunk.utf16)
        down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        down.post(tap: .cghidEventTap)
        usleep(4_000)
        up.post(tap: .cghidEventTap)
        usleep(6_000)
    }
}

extension String {
    func chunked(into size: Int) -> [String] {
        guard count > size else { return [self] }
        var result: [String] = []
        var current = ""
        for ch in self {
            current.append(ch)
            if current.count >= size { result.append(current); current = "" }
        }
        if !current.isEmpty { result.append(current) }
        return result
    }
}

func postClick(x: Double, y: Double, button: String, count: Int) throws {
    let source = CGEventSource(stateID: .combinedSessionState)
    let point = CGPoint(x: x, y: y)
    let (downType, upType, mouseButton): (CGEventType, CGEventType, CGMouseButton) =
        button == "right" ? (.rightMouseDown, .rightMouseUp, .right)
                          : (.leftMouseDown, .leftMouseUp, .left)
    if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                          mouseCursorPosition: point, mouseButton: mouseButton) {
        move.post(tap: .cghidEventTap)
        usleep(15_000)
    }
    for click in 1...max(1, count) {
        guard let down = CGEvent(mouseEventSource: source, mouseType: downType,
                                 mouseCursorPosition: point, mouseButton: mouseButton),
              let up = CGEvent(mouseEventSource: source, mouseType: upType,
                               mouseCursorPosition: point, mouseButton: mouseButton) else {
            throw HelperError(message: "could not create mouse events (Accessibility permission required)")
        }
        down.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        up.setIntegerValueField(.mouseEventClickState, value: Int64(click))
        down.post(tap: .cghidEventTap)
        usleep(20_000)
        up.post(tap: .cghidEventTap)
        usleep(40_000)
    }
}

func postScroll(x: Double, y: Double, dx: Int, dy: Int) throws {
    let source = CGEventSource(stateID: .combinedSessionState)
    if let move = CGEvent(mouseEventSource: source, mouseType: .mouseMoved,
                          mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) {
        move.post(tap: .cghidEventTap)
        usleep(10_000)
    }
    guard let scroll = CGEvent(scrollWheelEvent2Source: source, units: .pixel,
                               wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else {
        throw HelperError(message: "could not create scroll event")
    }
    scroll.post(tap: .cghidEventTap)
}

// MARK: - Capture (ScreenCaptureKit)

func captureWindow(pid: pid_t, windowId: String?, outputPath: String) throws -> [String: Any] {
    let semaphore = DispatchSemaphore(value: 0)
    var result: [String: Any]?
    var failure: String?

    Task {
        defer { semaphore.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let candidates = content.windows
                .filter { $0.owningApplication?.processID == pid && $0.isOnScreen }
                .sorted { ($0.frame.width * $0.frame.height) > ($1.frame.width * $1.frame.height) }
            let index = windowId.map(windowIndex(from:)) ?? 0
            guard let window = candidates.indices.contains(index) ? candidates[index] : candidates.first else {
                failure = "no capturable on-screen window for pid \(pid)"
                return
            }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            let scale = NSScreen.main?.backingScaleFactor ?? 2.0
            config.width = Int(window.frame.width * scale)
            config.height = Int(window.frame.height * scale)
            config.showsCursor = false
            config.captureResolution = .best

            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            let url = URL(fileURLWithPath: outputPath)
            guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
                failure = "could not open \(outputPath) for writing"
                return
            }
            CGImageDestinationAddImage(dest, image, nil)
            guard CGImageDestinationFinalize(dest) else {
                failure = "could not encode PNG"
                return
            }
            result = [
                "path": outputPath,
                "width": image.width,
                "height": image.height,
                "scaleFactor": Double(scale),
                "logicalFrame": ["x": window.frame.origin.x, "y": window.frame.origin.y,
                                 "width": window.frame.width, "height": window.frame.height]
            ]
        } catch {
            failure = "capture failed: \(error.localizedDescription)"
        }
    }

    if semaphore.wait(timeout: .now() + 15) == .timedOut {
        throw HelperError(message: "capture timed out")
    }
    if let failure = failure { throw HelperError(message: failure) }
    guard let result = result else { throw HelperError(message: "capture produced no image") }
    return result
}

/// Reports displays in the SAME coordinate space the rest of this helper uses:
/// global points with the origin at the top-left of the primary display, y
/// increasing downwards. That is what Accessibility frames and CGEvent mouse
/// positions use. NSScreen is bottom-left origin, so it is converted here once
/// rather than being a trap at every call site.
func listDisplays() -> [[String: Any]] {
    guard let primary = NSScreen.screens.first else { return [] }
    let primaryHeight = primary.frame.height
    return NSScreen.screens.map { screen in
        let id = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.intValue ?? 0
        let topLeftY = primaryHeight - (screen.frame.origin.y + screen.frame.height)
        return [
            "id": id,
            "bounds": ["x": screen.frame.origin.x, "y": topLeftY,
                       "width": screen.frame.width, "height": screen.frame.height],
            "scaleFactor": Double(screen.backingScaleFactor),
            "primary": screen == NSScreen.screens.first
        ]
    }
}

// MARK: - Dispatch

func handle(_ req: Request) {
    let args = req.args ?? [:]
    func str(_ k: String) -> String? { args[k]?.value as? String }
    func num(_ k: String) -> Double? {
        if let d = args[k]?.value as? Double { return d }
        if let i = args[k]?.value as? Int { return Double(i) }
        return nil
    }
    func intArg(_ k: String) -> Int? { num(k).map { Int($0) } }
    func intArray(_ k: String) -> [Int] {
        guard let raw = args[k]?.value as? [Any] else { return [] }
        return raw.compactMap { ($0 as? Int) ?? ($0 as? Double).map(Int.init) }
    }

    do {
        switch req.op {
        case "ping":
            respond(id: req.id, ok: true, value: ["pong": true, "version": 1], error: nil)

        case "permissions":
            // Checking must not prompt: the `false` prompt flag matters here.
            let ax = AXIsProcessTrustedWithOptions([
                kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false
            ] as CFDictionary)
            let screen = CGPreflightScreenCaptureAccess()
            respond(id: req.id, ok: true, value: [
                "accessibility": ax,
                "screenRecording": screen
            ], error: nil)

        case "requestPermission":
            let which = str("permission") ?? "accessibility"
            if which == "accessibility" {
                let granted = AXIsProcessTrustedWithOptions([
                    kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
                ] as CFDictionary)
                if !granted {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
                }
                respond(id: req.id, ok: true, value: ["granted": granted], error: nil)
            } else if which == "screen-recording" {
                let granted = CGRequestScreenCaptureAccess()
                if !granted {
                    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
                }
                respond(id: req.id, ok: true, value: ["granted": granted], error: nil)
            } else {
                respond(id: req.id, ok: false, value: nil, error: "unknown permission \(which)")
            }

        case "listApps":
            respond(id: req.id, ok: true, value: runningApps(), error: nil)

        case "frontmostWindow":
            guard let app = NSWorkspace.shared.frontmostApplication else {
                respond(id: req.id, ok: true, value: NSNull(), error: nil); return
            }
            let snap = try snapshotWindow(pid: app.processIdentifier, windowId: nil,
                                          maxDepth: intArg("maxDepth") ?? 12,
                                          maxNodes: intArg("maxNodes") ?? 400)
            respond(id: req.id, ok: true, value: snap, error: nil)

        case "inspectWindow":
            guard let pid = intArg("pid") else { throw HelperError(message: "pid required") }
            let snap = try snapshotWindow(pid: pid_t(pid), windowId: str("windowId"),
                                          maxDepth: intArg("maxDepth") ?? 12,
                                          maxNodes: intArg("maxNodes") ?? 400)
            respond(id: req.id, ok: true, value: snap, error: nil)

        case "focusWindow":
            guard let pid = intArg("pid"), let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
                throw HelperError(message: "no application with that pid")
            }
            app.activate(options: [.activateAllWindows])
            if let wid = str("windowId") {
                let element = try resolveElement(pid: pid_t(pid), windowId: wid, path: [])
                AXUIElementPerformAction(element, kAXRaiseAction as CFString)
            }
            usleep(150_000)
            respond(id: req.id, ok: true, value: ["activated": true], error: nil)

        case "pressElement":
            guard let pid = intArg("pid"), let wid = str("windowId") else {
                throw HelperError(message: "pid and windowId required")
            }
            let element = try resolveElement(pid: pid_t(pid), windowId: wid, path: intArray("path"))
            try validateStamp(element, args["stamp"]?.value as? [String: Any])
            let action = str("action") ?? (kAXPressAction as String)
            let available = axActions(element)
            guard available.contains(action) else {
                throw HelperError(message: "element does not support \(action); it supports [\(available.joined(separator: ", "))]")
            }
            let err = AXUIElementPerformAction(element, action as CFString)
            guard err == .success else { throw HelperError(message: "action \(action) failed with AX error \(err.rawValue)") }
            respond(id: req.id, ok: true, value: ["performed": action], error: nil)

        case "setElementValue":
            guard let pid = intArg("pid"), let wid = str("windowId"), let value = str("value") else {
                throw HelperError(message: "pid, windowId and value required")
            }
            let element = try resolveElement(pid: pid_t(pid), windowId: wid, path: intArray("path"))
            try validateStamp(element, args["stamp"]?.value as? [String: Any])
            var settable: DarwinBoolean = false
            AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
            guard settable.boolValue else { throw HelperError(message: "element value is not settable") }
            let err = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFTypeRef)
            guard err == .success else { throw HelperError(message: "setting value failed with AX error \(err.rawValue)") }
            // Read back: AX writes can silently no-op in some apps.
            let readBack = axString(element, kAXValueAttribute as String) ?? ""
            respond(id: req.id, ok: true, value: ["value": readBack, "matches": readBack == value], error: nil)

        case "click":
            guard let x = num("x"), let y = num("y") else { throw HelperError(message: "x and y required") }
            try postClick(x: x, y: y, button: str("button") ?? "left", count: intArg("count") ?? 1)
            respond(id: req.id, ok: true, value: ["clicked": ["x": x, "y": y]], error: nil)

        case "type":
            guard let text = str("text") else { throw HelperError(message: "text required") }
            try postText(text)
            respond(id: req.id, ok: true, value: ["typed": text.count], error: nil)

        case "shortcut":
            guard let keys = str("keys") else { throw HelperError(message: "keys required") }
            try postShortcut(keys)
            respond(id: req.id, ok: true, value: ["sent": keys], error: nil)

        case "scroll":
            guard let x = num("x"), let y = num("y") else { throw HelperError(message: "x and y required") }
            try postScroll(x: x, y: y, dx: intArg("dx") ?? 0, dy: intArg("dy") ?? 0)
            respond(id: req.id, ok: true, value: ["scrolled": true], error: nil)

        case "captureWindow":
            guard let pid = intArg("pid"), let out = str("outputPath") else {
                throw HelperError(message: "pid and outputPath required")
            }
            let value = try captureWindow(pid: pid_t(pid), windowId: str("windowId"), outputPath: out)
            respond(id: req.id, ok: true, value: value, error: nil)

        case "listDisplays":
            respond(id: req.id, ok: true, value: listDisplays(), error: nil)

        default:
            respond(id: req.id, ok: false, value: nil, error: "unknown op \(req.op)")
        }
    } catch let e as HelperError {
        respond(id: req.id, ok: false, value: nil, error: e.message)
    } catch {
        respond(id: req.id, ok: false, value: nil, error: "\(error)")
    }
}

// MARK: - Main loop

setbuf(stdout, nil)
let decoder = JSONDecoder()

// Requests are handled on a background queue; AppKit/ScreenCaptureKit work is
// hopped back to the main run loop, which stays alive for the process lifetime.
DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        guard let data = line.data(using: .utf8),
              let req = try? decoder.decode(Request.self, from: data) else {
            respond(id: "unknown", ok: false, value: nil, error: "malformed request")
            continue
        }
        if req.op == "shutdown" {
            respond(id: req.id, ok: true, value: ["bye": true], error: nil)
            exit(0)
        }
        DispatchQueue.main.sync { handle(req) }
    }
    exit(0)
}

RunLoop.main.run()
