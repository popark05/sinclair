package io.sinclair.helper;

import android.accessibilityservice.AccessibilityService;
import android.os.Build;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * 최소 HTTP/1.1 서버(GET 만, 연결마다 닫음). 127.0.0.1 에만 바인딩하고 Bearer 토큰을 요구한다.
 *
 * 라우트:
 *   GET /ping  → {"ok":true,"version":"<versionName>","sdk":<API>,"service":"ready"}
 *   GET /dump  → 활성 창의 접근성 트리(SemanticNode JSON, 루트 객체)
 */
final class HelperServer extends Thread {
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
            socket = new ServerSocket(port, 8, InetAddress.getLoopbackAddress());
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
            c.setSoTimeout(5000);
            BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.ISO_8859_1));
            String requestLine = in.readLine();
            if (requestLine == null) return;
            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0] : "";
            String path = parts.length > 1 ? parts[1] : "/";
            int q = path.indexOf('?');
            if (q >= 0) path = path.substring(0, q);

            String bearer = null;
            for (String line = in.readLine(); line != null && !line.isEmpty(); line = in.readLine()) {
                int colon = line.indexOf(':');
                if (colon < 0) continue;
                String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String value = line.substring(colon + 1).trim();
                if (name.equals("authorization") && value.startsWith("Bearer ")) bearer = value.substring(7);
            }

            OutputStream out = c.getOutputStream();
            if (!SessionToken.matches(bearer)) {
                respond(out, 401, "Unauthorized", json("error", SessionToken.isSet() ? "토큰 불일치" : "세션 토큰이 설정되지 않음"));
                return;
            }
            if (!method.equals("GET")) {
                respond(out, 405, "Method Not Allowed", json("error", "GET 만 지원"));
                return;
            }
            switch (path) {
                case "/ping":
                    respond(out, 200, "OK", ping());
                    break;
                case "/dump":
                    respond(out, 200, "OK", new TreeDumper(service).dumpActiveWindow().toString());
                    break;
                default:
                    respond(out, 404, "Not Found", json("error", "알 수 없는 경로: " + path));
            }
        } catch (Exception e) {
            Log.w(SinclairAccessibilityService.TAG, "요청 처리 실패", e);
            try {
                respond(client.getOutputStream(), 500, "Internal Server Error", json("error", String.valueOf(e.getMessage())));
            } catch (IOException ignored) {}
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

    private static String json(String key, String value) {
        try {
            return new JSONObject().put(key, value).toString();
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
