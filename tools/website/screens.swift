// Makes the website and README screenshots from the running app (macOS, swiftc only).
// Start the vite preview on port 1433, then: tools/website/screens.sh
// Usage: screens <js-file> <out-dir> <lang> <url> [scene ...]
import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 5 else { print("usage: screens <js> <out> <lang> <url> [scene ...]"); exit(1) }
let js = try! String(contentsOfFile: args[1], encoding: .utf8)
let outDir = args[2], lang = args[3], url = URL(string: args[4])!
let allScenes = ["design", "simulation", "laser", "plasma", "wiring", "max", "external", "engrave", "material", "tools", "beds"]
let scenes = args.count > 5 ? Array(args[5...]) : allScenes
let size = NSSize(width: 1800, height: 1125)

final class Runner: NSObject, WKNavigationDelegate {
  var index = 0
  var web: WKWebView?
  var window: NSWindow?

  func next() {
    guard index < scenes.count else { NSApp.terminate(nil); return }
    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .nonPersistent()
    if #available(macOS 14.0, *) { cfg.preferences.inactiveSchedulingPolicy = .none }
    let seed = "localStorage.setItem('cnc_craft_language','\(lang)');localStorage.setItem('cnc_craft_first_start_done','1');"
    cfg.userContentController.addUserScript(WKUserScript(source: seed, injectionTime: .atDocumentStart, forMainFrameOnly: true))
    let w = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: cfg)
    w.navigationDelegate = self
    let win = NSWindow(contentRect: NSRect(x: 0, y: 0, width: size.width, height: size.height), styleMask: [.borderless], backing: .buffered, defer: false)
    win.contentView = w
    win.alphaValue = 0.02 // has to count as visible, otherwise the drawing area is not painted
    win.orderFrontRegardless()
    web = w; window = win
    w.load(URLRequest(url: url))
  }

  func webView(_ w: WKWebView, didFinish navigation: WKNavigation!) {
    let name = scenes[index]
    let body = js + "\nreturn await __scene(\(String(reflecting: name)));"
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
      w.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
        if case .failure(let e) = result { print("scene \(name) failed: \(e)") }
        else if case .success(let v) = result { print("scene \(name): \(v)") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
          let c = WKSnapshotConfiguration()
          c.snapshotWidth = NSNumber(value: Double(size.width))
          w.takeSnapshot(with: c) { image, err in
            if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let png = rep.representation(using: .png, properties: [:]) {
              try? png.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
            } else { print("snapshot \(name) failed: \(String(describing: err))") }
            self.window?.close()
            self.index += 1
            self.next()
          }
        }
      }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let runner = Runner()
DispatchQueue.main.async { runner.next() }
app.run()
