// 최소 HTTP/1.1 서버(Network.framework). 요청 하나 → 응답 하나 → 연결 닫음(Connection: close). 본문은 Content-Length 만.
import Foundation
import Network

struct HttpRequest {
  let method: String
  let path: String
  let query: [String: String]
  let headers: [String: String]
  let body: Data
}

struct HttpResponse {
  var status: Int
  var body: Data

  static func json(_ obj: Any, status: Int = 200) -> HttpResponse {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{\"error\":\"JSON 직렬화 실패\"}".utf8)
    return HttpResponse(status: status, body: data)
  }
}

final class HttpServer {
  private let listener: NWListener
  private let queue = DispatchQueue(label: "sinclair.http", attributes: .concurrent)
  private let handler: (HttpRequest) -> HttpResponse
  private static let maxRequest = 8 << 20

  init(port: UInt16, handler: @escaping (HttpRequest) -> HttpResponse) throws {
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    guard let p = NWEndpoint.Port(rawValue: port) else { throw RunnerError("잘못된 포트: \(port)") }
    listener = try NWListener(using: params, on: p)
    self.handler = handler
  }

  func start() {
    listener.newConnectionHandler = { [weak self] c in self?.accept(c) }
    listener.stateUpdateHandler = { s in NSLog("sinclair-runner: listener \(s)") }
    listener.start(queue: queue)
  }

  private func accept(_ c: NWConnection) {
    c.start(queue: queue)
    receive(c, buffer: Data())
  }

  private func receive(_ c: NWConnection, buffer: Data) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      var buf = buffer
      if let data { buf.append(data) }
      if let req = Self.parse(buf) {
        self.send(c, self.handler(req))
        return
      }
      if isComplete || error != nil || buf.count > Self.maxRequest { c.cancel(); return }
      self.receive(c, buffer: buf)
    }
  }

  private func send(_ c: NWConnection, _ res: HttpResponse) {
    let reason = [200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 500: "Internal Server Error"][res.status] ?? "Status"
    var out = Data("HTTP/1.1 \(res.status) \(reason)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(res.body.count)\r\nConnection: close\r\n\r\n".utf8)
    out.append(res.body)
    c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
  }

  /// 헤더와 본문(Content-Length)이 다 왔으면 요청, 아니면 nil
  static func parse(_ buf: Data) -> HttpRequest? {
    guard let end = buf.range(of: Data("\r\n\r\n".utf8)),
          let head = String(data: buf.subdata(in: buf.startIndex..<end.lowerBound), encoding: .utf8) else { return nil }
    var lines = head.components(separatedBy: "\r\n")
    let first = lines.removeFirst().split(separator: " ")
    guard first.count >= 2 else { return nil }
    var headers: [String: String] = [:]
    for l in lines {
      guard let i = l.firstIndex(of: ":") else { continue }
      headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
    }
    let length = Int(headers["content-length"] ?? "0") ?? 0
    guard buf.distance(from: end.upperBound, to: buf.endIndex) >= length else { return nil }
    let body = buf.subdata(in: end.upperBound..<buf.index(end.upperBound, offsetBy: length))
    let target = String(first[1])
    let comps = URLComponents(string: target)
    var query: [String: String] = [:]
    for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }
    return HttpRequest(method: String(first[0]), path: comps?.path ?? target, query: query, headers: headers, body: body)
  }
}
