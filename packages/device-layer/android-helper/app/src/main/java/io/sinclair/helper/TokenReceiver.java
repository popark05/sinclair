package io.sinclair.helper;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 호스트의 세션 토큰을 받는다. 매니페스트에서 WRITE_SECURE_SETTINGS 권한으로 보호되므로 adb shell 만 보낼 수 있다:
 *   adb shell am broadcast -a io.sinclair.helper.SET_TOKEN -n io.sinclair.helper/.TokenReceiver --es token <hex>
 * token 을 비우면 토큰이 해제된다.
 */
public final class TokenReceiver extends BroadcastReceiver {
    static final String ACTION_SET_TOKEN = "io.sinclair.helper.SET_TOKEN";
    static final String EXTRA_TOKEN = "token";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_SET_TOKEN.equals(intent.getAction())) return;
        SessionToken.set(intent.getStringExtra(EXTRA_TOKEN));
        Log.i("SinclairHelper", SessionToken.isSet() ? "세션 토큰 설정됨" : "세션 토큰 해제됨");
    }
}
