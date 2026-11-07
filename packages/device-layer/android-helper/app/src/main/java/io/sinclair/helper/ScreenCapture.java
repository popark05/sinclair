package io.sinclair.helper;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.util.Base64;
import android.view.Display;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 접근성 서비스의 takeScreenshot(API 30+) 으로 화면을 PNG 로 찍는다. UiAutomation 을 쓰지 않는다.
 * 시스템이 호출 간격을 약 333ms 로 제한하므로(ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT) 그 경우 한 번 기다렸다 다시 시도한다.
 */
final class ScreenCapture {
    /** 결과: png 가 null 이면 실패이고 detail 에 이유가 있다. */
    static final class Result {
        final String pngBase64;
        final String detail;
        Result(String pngBase64, String detail) { this.pngBase64 = pngBase64; this.detail = detail; }
    }

    /** 간격 제한에 걸렸을 때 기다리는 시간. 시스템 제한(약 333ms)보다 조금 길게. */
    private static final long INTERVAL_RETRY_MS = 350L;
    /** 캡처 콜백을 기다리는 상한. 보통 수십 ms 안에 온다. */
    private static final long CALLBACK_TIMEOUT_MS = 3_000L;

    private ScreenCapture() {}

    static Result capture(AccessibilityService service) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return new Result(null, "takeScreenshot 은 Android 11(API 30) 이상에서만 지원");
        }
        Result first = captureOnce(service);
        if (first.pngBase64 != null || !first.detail.startsWith("errorCode=3")) return first;
        try { Thread.sleep(INTERVAL_RETRY_MS); } catch (InterruptedException e) { Thread.currentThread().interrupt(); return first; }
        Result second = captureOnce(service);
        return second.pngBase64 != null ? second : new Result(null, "takeScreenshot 호출 간격 제한(errorCode 3), 재시도 실패");
    }

    private static Result captureOnce(AccessibilityService service) {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Bitmap> bitmapRef = new AtomicReference<>();
        AtomicInteger errorRef = new AtomicInteger(-1);
        try {
            service.takeScreenshot(Display.DEFAULT_DISPLAY, Runnable::run, new AccessibilityService.TakeScreenshotCallback() {
                @Override
                public void onSuccess(AccessibilityService.ScreenshotResult result) {
                    HardwareBuffer buffer = result.getHardwareBuffer();
                    try {
                        Bitmap hw = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
                        // 하드웨어 비트맵은 압축할 수 없어 소프트웨어 사본으로 바꾼다.
                        if (hw != null) bitmapRef.set(hw.copy(Bitmap.Config.ARGB_8888, false));
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
            if (!done.await(CALLBACK_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return new Result(null, "takeScreenshot 콜백 시간 초과");
        } catch (Exception e) {
            return new Result(null, "takeScreenshot 호출 실패: " + e.getMessage());
        }
        Bitmap bitmap = bitmapRef.get();
        if (bitmap == null) return new Result(null, "errorCode=" + errorRef.get());
        ByteArrayOutputStream out = new ByteArrayOutputStream(bitmap.getByteCount() / 4);
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        bitmap.recycle();
        return new Result(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), null);
    }
}
