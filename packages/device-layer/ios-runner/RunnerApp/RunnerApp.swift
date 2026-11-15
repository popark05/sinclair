// UI 테스트 번들의 호스트 앱. 하는 일은 없다 — 러너는 RunnerUITests 의 testRun 안에서 돈다.
import SwiftUI

@main
struct RunnerApp: App {
  var body: some Scene {
    WindowGroup { Text("Sinclair Runner") }
  }
}
