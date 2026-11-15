// 러너 진입점: 이 테스트 하나가 끝나지 않고 돌며 HTTP 서버로 호스트의 요청을 받는다(호스트가 xcodebuild 를 끝내면 멈춘다).
// 토큰·포트는 호스트가 TEST_RUNNER_SINCLAIR_TOKEN·TEST_RUNNER_SINCLAIR_PORT 로 주고, xcodebuild 가 접두를 떼고 넘긴다.
import XCTest

final class RunnerTests: XCTestCase {
  private var serving = false
  private var lastIssue: String?

  /// 요청 처리 중의 XCTest 실패(예: 키보드 포커스 없음에서 typeText)는 테스트를 끝내지 않고 그 요청의 오류로 돌려준다
  override func record(_ issue: XCTIssue) {
    if serving { lastIssue = issue.compactDescription; return }
    super.record(issue)
  }

  func testRun() throws {
    continueAfterFailure = true
    let env = ProcessInfo.processInfo.environment
    guard let token = env["SINCLAIR_TOKEN"], !token.isEmpty else {
      XCTFail("SINCLAIR_TOKEN 이 없음 — 호스트가 TEST_RUNNER_SINCLAIR_TOKEN 으로 줘야 한다")
      return
    }
    let port = UInt16(env["SINCLAIR_PORT"] ?? "") ?? 22087
    let runner = Runner(token: token) { [unowned self] in
      defer { self.lastIssue = nil }
      return self.lastIssue
    }
    let server = try HttpServer(port: port) { req in DispatchQueue.main.sync { runner.handle(req) } }
    serving = true
    server.start()
    NSLog("sinclair-runner: listening on \(port)")
    while true { _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 1)) }
  }
}
