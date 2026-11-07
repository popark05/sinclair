package io.sinclair.helper;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.util.Base64;
import android.util.Log;
import android.view.Display;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 접근성 서비스의 takeScreenshot(API 30+) 으로 화면을 PNG 로 찍는다. UiAutomation 을 쓰지 않는다.
 * "같은 순간" 보장: takeScreenshot 은 호출 즉시 시스템이 프레임을 잡으므로, 호출 직후(콜백을 기다리기 전에) 트리를 읽는다.
 * 시스템이 호출 간격을 약 333ms 로 제한하므로(ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) 그 경우 한 번 기다렸다 다시 시도한다.
 */
final class ScreenCapture {
    /** 결과: pngBase64 가 null 이면 스크린샷 실패이고 detail 에 이유가 있다. tree 는 항상 있다. */
    static final class Result {
        final String pngBase64;
        final String detail;
        final JSONObject tree;
        /** onFailure 의 errorCode. 실패가 아니거나 다른 원인이면 -1. */
        int errorCode = -1;
        Result(String pngBase64, String detail, JSONObject tree) { this.pngBase64 = pngBase64; this.detail = detail; this.tree = tree; }
        Result withErrorCode(int code) { this.errorCode = code; return this; }
    }

    /** 간격 제한에 걸렸을 때 기다리는 시간. 시스템 제한(약 333ms)보다 조금 길게. */
    private static final long INTERVAL_RETRY_MS = 350L;
    /** 캡처 콜백을 기다리는 상한. 보통 수십 ms 안에 온다. */
    private static final long CALLBACK_TIMEOUT_MS = 3_000L;

    private ScreenCapture() {}

    /** 스크린샷과 트리를 같은 순간에 잡는다. 스크린샷이 불가해도 tree 는 채워 돌려준다. */
    static Result capture(AccessibilityService service, Callable<JSONObject> dumpTree) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return new Result(null, "takeScreenshot 은 Android 11(API 30) 이상에서만 지원", dumpTree.call());
        }
        Result first = captureOnce(service, dumpTree);
        if (first.pngBase64 != null || first.errorCode != AccessibilityService.ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) return first;
        try { Thread.sleep(INTERVAL_RETRY_MS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return first; }
        Result second = captureOnce(service, dumpTree);
        return second.pngBase64 != null ? second : new Result(null, "takeScreenshot 호출 간격 제한(errorCode 3), 재시도 실패", second.tree);
    }

    private static Result captureOnce(AccessibilityService service, Callable<JSONObject> dumpTree) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Bitmap> bitmapRef = new AtomicReference<>();
        AtomicReference<String> failureRef = new AtomicReference<>();
        AtomicInteger errorRef = new AtomicInteger(-1);
        JSONObject tree;
        try {
            service.takeScreenshot(Display.DEFAULT_DISPLAY, Runnable::run, new AccessibilityService.TakeScreenshotCallback() {
                @Override
                public void onSuccess(AccessibilityService.ScreenshotResult result) {
                    HardwareBuffer buffer = result.getHardwareBuffer();
                    try {
                        Bitmap hw = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
                        if (hw != null) {
                            // 하드웨어 비트맵은 압축할 수 없어 소프트웨어 사본으로 바꾼다.
                            bitmapRef.set(hw.copy(Bitmap.Config.ARGB_8888, false));
                            hw.recycle();
                        }
                    } catch (Throwable t) {
                        // 바인더 스레드에서 던지면 서비스 프로세스가 죽는다. 실패로 기록만 한다.
                        Log.w(SinclairAccessibilityService.TAG, "스크린샷 변환 실패", t);
                        failureRef.set("스크린샷 변환 실패: " + t.getMessage());
                    } finally {
                        buffer.close();
                        done.countDown();
                    }
                }

                @Override
                public void onFailure(int errorCode) {
                    errorRef.set(errorCode);
                    done.countDown();
                }
            });
            // 프레임은 위 호출 시점에 잡혔다. 콜백(비트맵 복사·인코딩)을 기다리기 전에 트리를 읽어 같은 순간에 맞춘다.
            tree = dumpTree.call();
            if (!done.await(CALLBACK_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return new Result(null, "takeScreenshot 콜백 시간 초과", tree).withErrorCode(-1);
        } catch (Exception e) {
            return new Result(null, "takeScreenshot 호출 실패: " + e.getMessage(), dumpTree.call());
        }
        Bitmap bitmap = bitmapRef.get();
        if (bitmap == null) {
            String detail = failureRef.get() != null ? failureRef.get() : "takeScreenshot 실패 errorCode=" + errorRef.get();
            return new Result(null, detail, tree).withErrorCode(errorRef.get());
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream(bitmap.getByteCount() / 4);
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        bitmap.recycle();
        return new Result(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), null, tree);
    }
}
