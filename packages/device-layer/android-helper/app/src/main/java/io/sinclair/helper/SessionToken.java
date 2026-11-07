package io.sinclair.helper;

/** 호스트가 브로드캐스트로 준 세션 토큰. 없으면 서버는 모든 요청을 401 로 거부한다. */
final class SessionToken {
    private static volatile String value;

    private SessionToken() {}

    static void set(String token) {
        value = (token == null || token.isEmpty()) ? null : token;
    }

    static boolean isSet() {
        return value != null;
    }

    /** 상수 시간 비교(토큰 길이 유출 외에는 타이밍 차이를 만들지 않는다). */
    static boolean matches(String candidate) {
        String current = value;
        if (current == null || candidate == null || current.length() != candidate.length()) return false;
        int diff = 0;
        for (int i = 0; i < current.length(); i++) diff |= current.charAt(i) ^ candidate.charAt(i);
        return diff == 0;
    }
}
