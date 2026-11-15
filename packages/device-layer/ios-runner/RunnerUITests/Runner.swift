// 러너 계약(ios-backend 02, 호스트 runner-client.ts)의 기기 쪽: Bearer 토큰, GET /ping·/dump·/snapshot·/app/foreground, POST /action·/app.
// 좌표·크기는 모두 포인트(호스트가 배율로 픽셀과 바꾼다). 모든 XCUITest 호출은 메인 스레드에서(서버가 main.sync 로 넘긴다).
import Foundation
import UIKit
import XCTest

struct RunnerError: Error {
  let message: String
  init(_ message: String) { self.message = message }
}

final class Runner {
  static let version = "0.1.0"
  private let token: String
  /// XCTest 실패 기록을 요청 오류로 바꾸기 위한 고리(RunnerTests.record 가 채운다)
  private let takeIssue: () -> String?
  /// 앞 화면 앱 후보: 이 러너가 띄우거나 활성화한 앱(최근 것 먼저). 공개 API 로는 앞 화면 앱을 물을 수 없다
  private var known: [String] = []
  private let springboard = "com.apple.springboard"

  init(token: String, takeIssue: @escaping () -> String?) {
    self.token = token
    self.takeIssue = takeIssue
  }

  func handle(_ r: HttpRequest) -> HttpResponse {
    guard r.headers["authorization"] == "Bearer \(token)" else { return .json(["error": "unauthorized"], status: 401) }
    _ = takeIssue()
    do {
      let res = try route(r)
      if let issue = takeIssue() { return .json(["error": issue], status: 400) }
      return res
    } catch let e as RunnerError {
      return .json(["error": e.message], status: 400)
    } catch {
      return .json(["error": "\(error)"], status: 500)
    }
  }

  private func route(_ r: HttpRequest) throws -> HttpResponse {
    switch (r.method, r.path) {
    case ("GET", "/ping"): return .json(ping())
    case ("GET", "/dump"): return .json(["root": try tree(r.query["bundleId"].map(app) ?? foreground())])
    case ("GET", "/snapshot"):
      let t0 = Date()
      let fgId = foregroundId()
      let fg = app(fgId)
      let t1 = Date()
      let root = try tree(fg)
      let t2 = Date()
      let png = XCUIScreen.main.screenshot().pngRepresentation
      let t3 = Date()
      if t3.timeIntervalSince(t0) > 3 { NSLog("sinclair-runner: 느린 snapshot 앞화면판정 %.1fs 트리 %.1fs 스크린샷 %.1fs (%@)", t1.timeIntervalSince(t0), t2.timeIntervalSince(t1), t3.timeIntervalSince(t2), fgId) }
      return .json(["root": root, "screenshot": png.base64EncodedString()])
    case ("GET", "/app/foreground"):
      let id = foregroundId()
      return .json(["bundleId": id == springboard ? NSNull() : (id as Any)])
    // 후보(호스트가 devicectl 로 받은 설치 앱 목록) 중에서도 찾는다 — 사람이 연 앱. 앱 하나의 state 는 수 ms 라 목록 전체도 1초 안쪽
    case ("POST", "/app/foreground"):
      let b = try body(r)
      var id = foregroundId()
      if id == springboard, let candidates = b["candidates"] as? [String] {
        for c in candidates where c != springboard && !known.contains(c) && app(c).state == .runningForeground { remember(c); id = c; break }
      }
      return .json(["bundleId": id == springboard ? NSNull() : (id as Any)])
    case ("POST", "/action"): try action(try body(r)); return .json(["ok": true])
    case ("POST", "/app"): try appAction(try body(r)); return .json(["ok": true])
    default: return .json(["error": "모르는 경로: \(r.method) \(r.path)"], status: 404)
    }
  }

  // MARK: - 기기·앱

  private func ping() -> [String: Any] {
    // UIScreen.main.bounds 는 런치 스크린이 없는 테스트 러너 앱의 호환 모드 크기(320x480)라 쓰지 않는다 — springboard 는 늘 전체 화면
    var b = app(springboard).frame
    if b.width <= 0 { b = UIScreen.main.nativeBounds.applying(CGAffineTransform(scaleX: 1 / UIScreen.main.nativeScale, y: 1 / UIScreen.main.nativeScale)) }
    return ["ok": true, "version": Runner.version, "iosVersion": UIDevice.current.systemVersion, "model": Runner.model(),
            "screen": ["width": b.width, "height": b.height], "scale": UIScreen.main.scale]
  }

  static func model() -> String {
    if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
    var u = utsname()
    uname(&u)
    return withUnsafeBytes(of: &u.machine) { raw in String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self) }
  }

  private func app(_ id: String) -> XCUIApplication { XCUIApplication(bundleIdentifier: id) }

  private func foregroundId() -> String {
    for id in known where app(id).state == .runningForeground { return id }
    return springboard
  }
  private func foreground() -> XCUIApplication { app(foregroundId()) }

  private func remember(_ id: String) {
    known.removeAll { $0 == id }
    known.insert(id, at: 0)
  }

  private func appAction(_ b: [String: Any]) throws {
    guard let id = b["bundleId"] as? String, !id.isEmpty else { throw RunnerError("bundleId 가 없음") }
    let a = app(id)
    switch b["action"] as? String {
    // launch 는 떠 있으면 그대로 앞으로(Android am start 와 같음). 종료 후 실행은 호스트가 terminate → launch
    // 설치되지 않은 앱의 activate 는 XCUITest 가 1분 넘게 붙잡아 그동안 모든 요청이 밀린다. 기기 안에서는 설치 여부를 알 수 없어(샌드박스)
    // 호스트가 devicectl 로 먼저 거른다(ios-backend.ts appInstalled)
    case "launch", "activate": a.activate(); remember(id)
    // 백그라운드로 간 앱은 화면 상태를 저장해 두었다가 다음 실행에 복원한다(실기 iOS 17 설정 앱). 앞 화면에서 종료하면 복원하지 않는다 —
    // 앞이 아니면 먼저 앞으로 가져와(저장된 상태를 여기서 써 버린다) 앞 화면인 채로 종료한다. 그래야 terminate → launch 가 처음 화면이다
    case "terminate":
      if a.state != .runningForeground { a.activate() }
      a.terminate(); known.removeAll { $0 == id }
    default: throw RunnerError("모르는 app action: \(b["action"] ?? "")")
    }
  }

  // MARK: - 입력

  private func point(_ b: [String: Any], _ kx: String = "x", _ ky: String = "y") throws -> XCUICoordinate {
    guard let x = (b[kx] as? NSNumber)?.doubleValue, let y = (b[ky] as? NSNumber)?.doubleValue else { throw RunnerError("좌표가 없음(\(kx), \(ky))") }
    // 화면 왼쪽 위 기준 절대 좌표(포인트). springboard 는 늘 전체 화면이다
    return app(springboard).coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0)).withOffset(CGVector(dx: x, dy: y))
  }

  private static let keys: [String: String] = [
    "return": "\n", "delete": XCUIKeyboardKey.delete.rawValue, "forwardDelete": XCUIKeyboardKey.forwardDelete.rawValue,
    "tab": "\t", "escape": XCUIKeyboardKey.escape.rawValue, "space": " ",
  ]

  private func action(_ b: [String: Any]) throws {
    let ms = ((b["durationMs"] as? NSNumber)?.doubleValue ?? 0) / 1000
    switch b["action"] as? String {
    case "tap": try point(b).tap()
    case "long_press": try point(b).press(forDuration: max(ms, 0.5))
    case "swipe":
      let from = try point(b, "fromX", "fromY"), to = try point(b, "toX", "toY")
      let dist = hypot(to.screenPoint.x - from.screenPoint.x, to.screenPoint.y - from.screenPoint.y)
      let v = dist / max(ms, 0.05)
      from.press(forDuration: 0.05, thenDragTo: to, withVelocity: XCUIGestureVelocity(rawValue: v), thenHoldForDuration: 0)
    case "type":
      guard let text = b["text"] as? String else { throw RunnerError("text 가 없음") }
      foreground().typeText(text)
    case "key":
      guard let k = b["key"] as? String, let s = Runner.keys[k] else { throw RunnerError("지원하지 않는 키: \(b["key"] ?? "")") }
      foreground().typeText(s)
    case "button":
      switch b["button"] as? String {
      // 홈 직후(앱이 닫히는 애니메이션 중) springboard 스냅샷이 20초 넘게 붙잡히는 일이 있어(실기 iOS 17) 애니메이션이 끝날 만큼 기다린다
      case "home": XCUIDevice.shared.press(.home); _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 1.0))
      #if !targetEnvironment(simulator)
      case "volume_up": XCUIDevice.shared.press(.volumeUp)
      case "volume_down": XCUIDevice.shared.press(.volumeDown)
      #endif
      default: throw RunnerError("지원하지 않는 버튼: \(b["button"] ?? "")")
      }
    default: throw RunnerError("모르는 action: \(b["action"] ?? "")")
    }
  }

  private func body(_ r: HttpRequest) throws -> [String: Any] {
    guard let obj = try? JSONSerialization.jsonObject(with: r.body), let d = obj as? [String: Any] else { throw RunnerError("본문이 JSON 객체가 아님") }
    return d
  }

  // MARK: - 화면 트리

  private func tree(_ a: XCUIApplication) throws -> [String: Any] {
    do { return encode(try a.snapshot(), depth: 0) } catch { throw RunnerError("화면 트리를 읽지 못함: \(error.localizedDescription)") }
  }

  private func encode(_ s: XCUIElementSnapshot, depth: Int) -> [String: Any] {
    let f = s.frame
    var d: [String: Any] = [
      "type": Runner.typeName(s.elementType),
      "frame": ["x": f.origin.x, "y": f.origin.y, "width": f.size.width, "height": f.size.height],
      "enabled": s.isEnabled, "selected": s.isSelected,
      "children": depth < 80 ? s.children.map { encode($0, depth: depth + 1) } : [],
    ]
    if !s.identifier.isEmpty { d["identifier"] = s.identifier }
    if !s.label.isEmpty { d["label"] = s.label }
    if let v = s.value { if let str = v as? String { if !str.isEmpty { d["value"] = str } } else if let n = v as? NSNumber { d["value"] = n.stringValue } }
    if let p = s.placeholderValue, !p.isEmpty { d["placeholderValue"] = p }
    if s.hasFocus { d["hasFocus"] = true }
    return d
  }

  /// 호스트 ios-tree.ts 의 ROLE 표와 같은 이름
  static func typeName(_ t: XCUIElement.ElementType) -> String {
    switch t {
    case .application: return "Application"
    case .window: return "Window"
    case .group: return "Group"
    case .navigationBar: return "NavigationBar"
    case .tabBar: return "TabBar"
    case .toolbar: return "Toolbar"
    case .alert: return "Alert"
    case .sheet: return "Sheet"
    case .keyboard: return "Keyboard"
    case .cell: return "Cell"
    case .segmentedControl: return "SegmentedControl"
    case .button: return "Button"
    case .key: return "Key"
    case .link: return "Link"
    case .menuItem: return "MenuItem"
    case .icon: return "Icon"
    case .staticText: return "StaticText"
    case .textField: return "TextField"
    case .searchField: return "SearchField"
    case .textView: return "TextView"
    case .secureTextField: return "SecureTextField"
    case .switch: return "Switch"
    case .toggle: return "Toggle"
    case .checkBox: return "CheckBox"
    case .radioButton: return "RadioButton"
    case .slider: return "Slider"
    case .pickerWheel: return "PickerWheel"
    case .picker: return "Picker"
    case .image: return "Image"
    case .table: return "Table"
    case .collectionView: return "CollectionView"
    case .scrollView: return "ScrollView"
    case .webView: return "WebView"
    case .tab: return "Tab"
    case .other: return "Other"
    default: return "Other"
    }
  }
}
