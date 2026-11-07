package io.sinclair.helper;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Bundle;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 접근성 API 로 입력을 넣는다(ADR 0003: 1차 경로). 탭·롱프레스·스와이프는 dispatchGesture, 텍스트는 포커스된 입력 필드에
 * ACTION_SET_TEXT 로 덧붙인다(IME 없이 한글·이모지 가능). 거부(취소·포커스 없음)는 호스트가 adb shell input 으로 대체한다.
 */
final class AccessibilityInput {
    /** 결과. ok 가 false 면 detail 에 이유. */
    static final class Outcome {
        final boolean ok;
        final String via;
        final String detail;
        private Outcome(boolean ok, String via, String detail) { this.ok = ok; this.via = via; this.detail = detail; }
        static Outcome done(String via) { return new Outcome(true, via, null); }
        static Outcome refused(String detail) { return new Outcome(false, null, detail); }
    }

    /** 탭 한 번의 접촉 시간. 너무 짧으면 일부 앱이 클릭으로 인식하지 않는다. */
    private static final long TAP_DURATION_MS = 60L;
    /** 제스처 완료 콜백을 기다리는 여유. 제스처 자체 시간에 더한다. */
    private static final long GESTURE_GRACE_MS = 2_000L;

    private AccessibilityInput() {}

    static Outcome tap(AccessibilityService service, float x, float y) throws InterruptedException {
        Path p = new Path();
        p.moveTo(x, y);
        return dispatch(service, p, TAP_DURATION_MS);
    }

    static Outcome longPress(AccessibilityService service, float x, float y, long durationMs) throws InterruptedException {
        Path p = new Path();
        p.moveTo(x, y);
        return dispatch(service, p, Math.max(durationMs, TAP_DURATION_MS));
    }

    static Outcome swipe(AccessibilityService service, float fromX, float fromY, float toX, float toY, long durationMs) throws InterruptedException {
        Path p = new Path();
        p.moveTo(fromX, fromY);
        p.lineTo(toX, toY);
        return dispatch(service, p, Math.max(durationMs, TAP_DURATION_MS));
    }

    private static Outcome dispatch(AccessibilityService service, Path path, long durationMs) throws InterruptedException {
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0L, durationMs))
                .build();
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean completed = new AtomicBoolean(false);
        boolean accepted = service.dispatchGesture(gesture, new AccessibilityService.GestureResultCallback() {
            @Override public void onCompleted(GestureDescription g) { completed.set(true); done.countDown(); }
            @Override public void onCancelled(GestureDescription g) { done.countDown(); }
        }, null);
        if (!accepted) return Outcome.refused("dispatchGesture 가 제스처를 받지 않음(서비스에 canPerformGestures 가 없거나 다른 제스처 진행 중)");
        if (!done.await(durationMs + GESTURE_GRACE_MS, TimeUnit.MILLISECONDS)) return Outcome.refused("제스처 완료 콜백 시간 초과");
        return completed.get() ? Outcome.done("gesture") : Outcome.refused("제스처가 취소됨(dispatchGesture cancelled: 다른 접근성 서비스나 사용자 터치가 가로챔)");
    }

    /**
     * 포커스된 편집 가능 노드의 내용 뒤에 text 를 덧붙인다(타이핑 의미). 비밀번호 필드는 내용을 읽을 수 없으므로(redaction)
     * 덧붙이지 못하고 text 로 바꾼다. API 33 미만의 AccessibilityNodeInfo.recycle 은 호출하지 않는다: 호출당 노드 수가 적고 GC 가 회수한다.
     */
    static Outcome type(AccessibilityService service, String text) {
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) return Outcome.refused("활성 창 없음");
        AccessibilityNodeInfo target = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (target == null || !target.isEditable()) target = findFocusedEditable(root);
        if (target == null) return Outcome.refused("포커스된 입력 필드가 없음");
        CharSequence existing = target.isPassword() ? "" : target.getText();
        String merged = (existing == null ? "" : existing.toString()) + text;
        Bundle args = new Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, merged);
        boolean ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        return ok ? Outcome.done("set_text") : Outcome.refused("ACTION_SET_TEXT 거부됨(편집 불가 노드이거나 앱이 거부)");
    }

    private static AccessibilityNodeInfo findFocusedEditable(AccessibilityNodeInfo node) {
        if (node.isEditable() && node.isFocused()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo c = node.getChild(i);
            if (c == null) continue;
            AccessibilityNodeInfo found = findFocusedEditable(c);
            if (found != null) return found;
        }
        return null;
    }
}
