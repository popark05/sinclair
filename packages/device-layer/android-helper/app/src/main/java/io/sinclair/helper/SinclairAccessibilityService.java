package io.sinclair.helper;

import android.accessibilityservice.AccessibilityService;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;

/**
 * Sinclair 온디바이스 에이전트. 접근성 서비스가 켜지면 루프백 HTTP 서버를 띄우고, 꺼지면 내린다.
 * UiAutomation 을 잡지 않으므로 다른 자동화 도구와 공존한다(ADR 0003).
 */
public final class SinclairAccessibilityService extends AccessibilityService {
    static final String TAG = "SinclairHelper";
    /** 호스트는 `adb forward tcp:<호스트포트> tcp:38300` 으로 접근한다. */
    static final int PORT = 38300;

    private HelperServer server;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        if (server == null) {
            server = new HelperServer(this, PORT);
            server.start();
            Log.i(TAG, "HTTP 서버 시작: 127.0.0.1:" + PORT);
        }
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // 트리는 요청 시 읽는다. 이벤트는 구독하지 않는다.
    }

    @Override
    public void onInterrupt() {}

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        stopServer();
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        stopServer();
        super.onDestroy();
    }

    private void stopServer() {
        if (server != null) {
            server.shutdown();
            server = null;
            Log.i(TAG, "HTTP 서버 종료");
        }
    }
}
