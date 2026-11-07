package io.sinclair.helper;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 요청 인증. 호스트가 기기에 심은 세션 토큰과 `Authorization` 헤더를 비교한다.
 * 토큰이 심어지기 전에는 어떤 요청도 통과하지 못한다.
 */
final class HelperAuth {
    private static final String SCHEME = "Bearer ";
    private static final AtomicReference<byte[]> EXPECTED = new AtomicReference<>();

    private HelperAuth() {}

    /** 새 토큰으로 바꾼다. 빈 값이면 인증을 잠근다(토큰 해제). */
    static void update(String token) {
        EXPECTED.set(token == null || token.isEmpty() ? null : token.getBytes(StandardCharsets.UTF_8));
    }

    static boolean locked() {
        return EXPECTED.get() == null;
    }

    /** `Authorization` 헤더 값 전체를 받아 판정한다. 길이 비교까지 상수 시간(MessageDigest.isEqual). */
    static boolean accepts(String authorizationHeader) {
        byte[] expected = EXPECTED.get();
        if (expected == null || authorizationHeader == null || !authorizationHeader.startsWith(SCHEME)) return false;
        byte[] presented = authorizationHeader.substring(SCHEME.length()).trim().getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(expected, presented);
    }
}
