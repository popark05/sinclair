package io.sinclair.helper;

import android.accessibilityservice.AccessibilityService;
import android.os.Build;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * 최소 HTTP/1.1 서버(GET 만, 연결마다 닫음). 127.0.0.1 에만 바인딩하고 Bearer 토큰을 요구한다.
 *
 * 라우트:
 *   GET /ping  → {"ok":true,"version":"<versionName>","sdk":<API>,"service":"ready"}
 *   GET /dump  → 활성 창의 접근성 트리(SemanticNode JSON, 루트 객체)
 *   GET /snapshot → {"root":…, "atomic":true, "screenshot":{"format":"png","base64":…}} 또는 {"root":…, "atomic":false, "detail":…}
 *   POST /action  → {"ok":true,"via":"gesture"|"set_text"} 또는 409 {"ok":false,"detail":…}
 */
final class HelperServer extends Thread {
    /** 호스트는 adb forward 를 거쳐 요청 하나씩 보내므로 동시 연결은 몇 개면 충분하다. 넘치면 커널이 거절한다. */
    private static final int BACKLOG = 8;
    /** 느린 클라이언트가 워커 스레드를 붙들지 못하게 한다. 루프백 + adb forward 에서 정상 요청은 수 ms 안에 끝난다. */
    private static final int SOCKET_TIMEOUT_MS = 5_000;
    /** 요청 줄·헤더 한 줄의 최대 길이와 헤더 수. 넘기면 400. 메모리 소진 방지. */
    private static final int MAX_LINE_BYTES = 8 * 1024;
    private static final int MAX_HEADERS = 64;
    /** POST 본문 상한. /action 의 JSON 은 수백 바이트이며, 긴 텍스트 입력도 이 안에 든다. */
    private static final int MAX_BODY_BYTES = 64 * 1024;

    private final AccessibilityService service;
    private final int port;
    private volatile ServerSocket socket;

    HelperServer(AccessibilityService service, int port) {
        super("SinclairHelperServer");
        this.service = service;
        this.port = port;
        setDaemon(true);
    }

    @Override
    public void run() {
        try {
            socket = new ServerSocket(port, BACKLOG, InetAddress.getLoopbackAddress());
            while (!isInterrupted()) {
                Socket client = socket.accept();
                Thread worker = new Thread(() -> handle(client), "SinclairHelperConn");
                worker.setDaemon(true);
                worker.start();
            }
        } catch (IOException e) {
            if (!isInterrupted()) Log.w(SinclairAccessibilityService.TAG, "서버 종료: " + e.getMessage());
        }
    }

    void shutdown() {
        interrupt();
        ServerSocket s = socket;
        if (s != null) {
            try { s.close(); } catch (IOException ignored) {}
        }
    }

    private void handle(Socket client) {
        try (Socket c = client) {
            c.setSoTimeout(SOCKET_TIMEOUT_MS);
            InputStream in = c.getInputStream();
            OutputStream out = c.getOutputStream();

            String requestLine = readLine(in);
            if (requestLine == null) return;
            if (requestLine.length() >= MAX_LINE_BYTES) {
                respond(out, 400, "Bad Request", errorBody("요청 줄이 너무 깁니다"));
                return;
            }
            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "";
            String path = parts.length > 1 ? parts[1] : "/";
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);

            String authorization = null;
            int contentLength = 0;
            for (int n = 0; ; n++) {
                String line = readLine(in);
                if (line == null || line.isEmpty()) break;
                if (n >= MAX_HEADERS || line.length() >= MAX_LINE_BYTES) {
                    respond(out, 400, "Bad Request", errorBody("헤더가 너무 많거나 깁니다"));
                    return;
                }
                int colon = line.indexOf(':');
                if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase("Authorization")) {
                    authorization = line.substring(colon + 1).trim();
                }
                if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase("Content-Length")) {
                    try { contentLength = Integer.parseInt(line.substring(colon + 1).trim()); } catch (NumberFormatException ignored) {}
                }
            }

            if (!HelperAuth.accepts(authorization)) {
                respond(out, 401, "Unauthorized", errorBody(HelperAuth.locked() ? "세션 토큰이 설정되지 않음" : "토큰 불일치"));
                return;
            }
            if (method.equals("POST") && path.equals("/action")) {
                if (contentLength <= 0 || contentLength > MAX_BODY_BYTES) {
                    respond(out, 400, "Bad Request", errorBody("본문이 없거나 너무 큽니다"));
                    return;
                }
                byte[] body = new byte[contentLength];
                int got = 0;
                while (got < contentLength) {
                    int r = in.read(body, got, contentLength - got);
                    if (r < 0) break;
                    got += r;
                }
                AccessibilityInput.Outcome outcome;
                try {
                    outcome = action(new JSONObject(new String(body, 0, got, StandardCharsets.UTF_8)));
                } catch (JSONException e) {
                    // 본문이 JSON 이 아니거나 필수 키(x, y, durationMs, text …)가 빠진 것: 호출자 잘못이므로 400.
                    respond(out, 400, "Bad Request", errorBody("action 본문 오류: " + e.getMessage()));
                    return;
                }
                JSONObject o = new JSONObject().put("ok", outcome.ok);
                if (outcome.ok) o.put("via", outcome.via); else o.put("detail", outcome.detail);
                respond(out, outcome.ok ? 200 : 409, outcome.ok ? "OK" : "Conflict", o.toString());
                return;
            }
            if (!method.equals("GET")) {
                respond(out, 405, "Method Not Allowed", errorBody("GET/POST 만 지원"));
                return;
            }
            switch (path) {
                case "/ping":
                    respond(out, 200, "OK", ping());
                    break;
                case "/dump":
                    respond(out, 200, "OK", new TreeDumper(service).dumpActiveWindow().toString());
                    break;
                case "/snapshot":
                    respond(out, 200, "OK", snapshot());
                    break;
                default:
                    respond(out, 404, "Not Found", errorBody("알 수 없는 경로: " + path));
            }
        } catch (Exception e) {
            // 내부 사정은 logcat 에만 남기고 응답에는 싣지 않는다.
            Log.w(SinclairAccessibilityService.TAG, "요청 처리 실패", e);
            try {
                respond(client.getOutputStream(), 500, "Internal Server Error", errorBody("처리 실패. adb logcat -s SinclairHelper 참고"));
            } catch (IOException ignored) {}
        }
    }

    /** CRLF 로 끝나는 한 줄(ISO-8859-1). 스트림이 먼저 끝나면 null. MAX_LINE_BYTES 에서 읽기를 멈춘다. */
    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder(128);
        int b;
        while ((b = in.read()) >= 0) {
            if (b == '\n') break;
            if (b != '\r') sb.append((char) b);
            if (sb.length() >= MAX_LINE_BYTES) break;
        }
        return b < 0 && sb.length() == 0 ? null : sb.toString();
    }

    /** 같은 순간의 스크린샷과 트리(ScreenCapture 가 takeScreenshot 직후 트리를 읽는다). 스크린샷이 실패하면 트리만 atomic:false 로. */
    private String snapshot() throws Exception {
        ScreenCapture.Result shot = ScreenCapture.capture(service, () -> new TreeDumper(service).dumpActiveWindow());
        JSONObject o = new JSONObject();
        o.put("root", shot.tree);
        if (shot.pngBase64 != null) {
            o.put("atomic", true);
            o.put("screenshot", new JSONObject().put("format", "png").put("base64", shot.pngBase64));
        } else {
            o.put("atomic", false);
            o.put("detail", shot.detail);
        }
        return o.toString();
    }

    /** POST /action: {"action":"tap","x":..,"y":..} | long_press(+durationMs) | swipe(fromX,fromY,toX,toY,durationMs) | type(text) */
    private AccessibilityInput.Outcome action(JSONObject a) throws Exception {
        String action = a.optString("action", "");
        switch (action) {
            case "tap":
                return AccessibilityInput.tap(service, (float) a.getDouble("x"), (float) a.getDouble("y"));
            case "long_press":
                return AccessibilityInput.longPress(service, (float) a.getDouble("x"), (float) a.getDouble("y"), a.getLong("durationMs"));
            case "swipe":
                return AccessibilityInput.swipe(service, (float) a.getDouble("fromX"), (float) a.getDouble("fromY"),
                        (float) a.getDouble("toX"), (float) a.getDouble("toY"), a.getLong("durationMs"));
            case "type":
                return AccessibilityInput.type(service, a.getString("text"));
            default:
                throw new JSONException("알 수 없는 action: " + action);
        }
    }

    private String ping() throws JSONException {
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("version", BuildConfig.VERSION_NAME);
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("service", "ready");
        return o.toString();
    }

    private static String errorBody(String message) {
        try {
            return new JSONObject().put("error", message).toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    private static void respond(OutputStream out, int status, String reason, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " " + reason + "\r\n"
                + "Content-Type: application/json; charset=utf-8\r\n"
                + "Content-Length: " + bytes.length + "\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(bytes);
        out.flush();
    }
}
