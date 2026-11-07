package io.sinclair.helper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 세션 토큰 전달 경로. 매니페스트에서 WRITE_SECURE_SETTINGS(signature|privileged) 권한을 요구하므로
 * adb shell(uid 2000)과 system 만 보낼 수 있다:
 *
 *   adb shell am broadcast -a io.sinclair.helper.SET_TOKEN -n io.sinclair.helper/.TokenReceiver --es token <hex>
 *
 * `token` 을 비워 보내면 인증이 잠긴다.
 */
public final class TokenReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        HelperAuth.update(intent.getStringExtra("token"));
        Log.i(SinclairAccessibilityService.TAG, HelperAuth.locked() ? "세션 토큰 해제됨(잠김)" : "세션 토큰 갱신됨");
    }
}
