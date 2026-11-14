// Studio IPC 계약(studio 01): 메인 ↔ 작업 프로세스 메시지는 단일 정의와 닫힌 검사기를 지난다(구조화 복제 가능한 평범한 데이터).
import { describe, it, expect } from 'vitest';
import { MAX_EXPORT_BYTES, parseFromWorker, parseStudioRequest, STUDIO_CHANNELS } from '../src/shared/studio-ipc.ts';

describe('studio IPC 계약', () => {
  it('작업 프로세스 메시지: ready·pong 만, 필드가 맞을 때만 통과', () => {
    expect(parseFromWorker({ type: 'ready', node: 'v24.13.0', pid: 12 })).toEqual({ type: 'ready', node: 'v24.13.0', pid: 12 });
    expect(parseFromWorker({ type: 'pong', id: 'p1', node: 'v24.13.0', pid: 12 })).toEqual({ type: 'pong', id: 'p1', node: 'v24.13.0', pid: 12 });
    for (const bad of [null, 'x', { type: 'eval', code: '1' }, { type: 'pong', id: 1, node: 'v', pid: 1 }, { type: 'ready', node: 'v', pid: '1' }]) expect(parseFromWorker(bad)).toBeUndefined();
  });

  it('응답 메시지와 렌더러 요청: 알려진 요청만, 기기 id 는 문자열', () => {
    expect(parseFromWorker({ type: 'response', id: 'r1', ok: true, value: [] })).toEqual({ type: 'response', id: 'r1', ok: true, value: [] });
    expect(parseFromWorker({ type: 'response', id: 'r1', ok: false, error: '실패' })).toEqual({ type: 'response', id: 'r1', ok: false, error: '실패' });
    expect(parseStudioRequest({ kind: 'devices' })).toEqual({ kind: 'devices' });
    expect(parseStudioRequest({ kind: 'connection' })).toEqual({ kind: 'connection' });
    expect(parseStudioRequest({ kind: 'foreground-app', deviceId: 'SER' })).toEqual({ kind: 'foreground-app', deviceId: 'SER' });
    for (const bad of [{ kind: 'shell', cmd: 'rm' }, { kind: 'foreground-app' }, { kind: 'foreground-app', deviceId: 3 }, null]) expect(parseStudioRequest(bad)).toBeUndefined();
  });

  it('기기 조작 요청(studio 03): 좌표는 0~20000 정수로 반올림, 스와이프 시간 50~5000ms, 글자 500자, 키·버튼은 정해진 것만', () => {
    expect(parseStudioRequest({ kind: 'snapshot', deviceId: 'S' })).toEqual({ kind: 'snapshot', deviceId: 'S' });
    expect(parseStudioRequest({ kind: 'tap', deviceId: 'S', x: 10.6, y: 20.2 })).toEqual({ kind: 'tap', deviceId: 'S', x: 11, y: 20 });
    expect(parseStudioRequest({ kind: 'swipe', deviceId: 'S', fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 300 })).toEqual({ kind: 'swipe', deviceId: 'S', fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 300 });
    expect(parseStudioRequest({ kind: 'text', deviceId: 'S', text: '안녕' })).toEqual({ kind: 'text', deviceId: 'S', text: '안녕' });
    expect(parseStudioRequest({ kind: 'key', deviceId: 'S', key: 'enter' })).toEqual({ kind: 'key', deviceId: 'S', key: 'enter' });
    expect(parseStudioRequest({ kind: 'button', deviceId: 'S', button: 'home' })).toEqual({ kind: 'button', deviceId: 'S', button: 'home' });
    for (const bad of [
      { kind: 'tap', deviceId: 'S', x: -1, y: 0 }, { kind: 'tap', deviceId: 'S', x: 'a', y: 0 }, { kind: 'tap', deviceId: 'S', x: 1e9, y: 0 },
      { kind: 'swipe', deviceId: 'S', fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 10 }, { kind: 'text', deviceId: 'S', text: 'x'.repeat(501) },
      { kind: 'key', deviceId: 'S', key: 'POWER' }, { kind: 'button', deviceId: 'S', button: 'power' }, { kind: 'snapshot' },
    ]) expect(parseStudioRequest(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it('세션 요청(studio 05)과 작업 프로세스의 이벤트 푸시', () => {
    expect(parseStudioRequest({ kind: 'agent-status' })).toEqual({ kind: 'agent-status' });
    expect(parseStudioRequest({ kind: 'session-start', deviceId: 'S', goal: '로그인' })).toEqual({ kind: 'session-start', deviceId: 'S', goal: '로그인' });
    expect(parseStudioRequest({ kind: 'session-stop', sessionId: 's1' })).toEqual({ kind: 'session-stop', sessionId: 's1' });
    expect(parseStudioRequest({ kind: 'session-assert', deviceId: 'S', statement: '홈이다' })).toEqual({ kind: 'session-assert', deviceId: 'S', statement: '홈이다' });
    expect(parseStudioRequest({ kind: 'session-start', deviceId: 'S', goal: '로그인', restartApp: 'com.google.android.youtube' })).toEqual({ kind: 'session-start', deviceId: 'S', goal: '로그인', restartApp: 'com.google.android.youtube' });
    // 앱 id 는 패키지 이름 형식만(셸로 가는 값이다)
    for (const restartApp of ['com app', 'com.app;reboot', '', 'x', 'a'.repeat(256), 3]) expect(parseStudioRequest({ kind: 'session-start', deviceId: 'S', goal: '로그인', restartApp }), String(restartApp)).toBeUndefined();
    for (const bad of [{ kind: 'session-start', deviceId: 'S', goal: '' }, { kind: 'session-start', deviceId: 'S', goal: 'x'.repeat(2001) }, { kind: 'session-stop' }, { kind: 'session-assert', deviceId: 'S' }]) expect(parseStudioRequest(bad), JSON.stringify(bad)).toBeUndefined();
    // 비밀값(agent-secrets 03): 이름 규칙·값 길이(4~200)·10개까지. 값은 작업 프로세스로만 간다
    expect(parseStudioRequest({ kind: 'session-start', deviceId: 'S', goal: '문 열기 {{secret:SIMPLE_PIN}}', secrets: { SIMPLE_PIN: '2580' } })).toEqual({ kind: 'session-start', deviceId: 'S', goal: '문 열기 {{secret:SIMPLE_PIN}}', secrets: { SIMPLE_PIN: '2580' } });
    for (const secrets of [{ pin: '2580' }, { SIMPLE_PIN: '12' }, { SIMPLE_PIN: 'x'.repeat(201) }, { SIMPLE_PIN: 2580 }, Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`S${i}`, '1234'])), ['2580']]) expect(parseStudioRequest({ kind: 'session-start', deviceId: 'S', goal: 'g', secrets }), JSON.stringify(secrets)).toBeUndefined();
    // Cycle 로 실행(studio-console 04): 렌더러는 이름·코드·기기만 — control-plane·테스트 폴더는 메인이 설정에서 넣는다(렌더러가 준 것은 버린다)
    expect(parseStudioRequest({ kind: 'run-cycle', deviceId: 'S', deviceLabel: 'M (…S)', testName: 'YouTube 검색', code: 'x', testsDir: '/etc', controlPlane: 'http://evil' })).toEqual({ kind: 'run-cycle', deviceId: 'S', deviceLabel: 'M (…S)', testName: 'YouTube 검색', code: 'x' });
    expect(parseStudioRequest({ kind: 'cycle-status', cycleId: 'studio-20261114-1' })).toEqual({ kind: 'cycle-status', cycleId: 'studio-20261114-1' });
    for (const bad of [{ kind: 'run-cycle', deviceId: 'S', deviceLabel: 'M', testName: '', code: 'x' }, { kind: 'run-cycle', deviceId: 'S', deviceLabel: 'M', testName: 'n', code: 'x'.repeat(MAX_EXPORT_BYTES + 1) }, { kind: 'cycle-status', cycleId: '../x' }]) expect(parseStudioRequest(bad), JSON.stringify(bad).slice(0, 80)).toBeUndefined();
    // 요소 판정(studio 09): 닫힌 질의·검사 종류, 값은 값이 있는 검사에만
    expect(parseStudioRequest({ kind: 'expect-check', deviceId: 'S', query: { text: '창신동', exact: true }, matcher: 'visible' })).toEqual({ kind: 'expect-check', deviceId: 'S', query: { text: '창신동', exact: true }, matcher: 'visible' });
    expect(parseStudioRequest({ kind: 'expect-check', deviceId: 'S', query: { testId: 'a:id/q' }, matcher: 'value', expected: '사과' })).toEqual({ kind: 'expect-check', deviceId: 'S', query: { testId: 'a:id/q' }, matcher: 'value', expected: '사과' });
    for (const bad of [
      { kind: 'expect-check', deviceId: 'S', query: { text: 'x' }, matcher: 'toBeVisible' }, { kind: 'expect-check', deviceId: 'S', query: {}, matcher: 'visible' },
      { kind: 'expect-check', deviceId: 'S', query: { text: 'x' }, matcher: 'text' }, { kind: 'expect-check', deviceId: 'S', query: { text: 'x' }, matcher: 'visible', expected: 'y' },
      { kind: 'expect-check', deviceId: 'S', query: { text: 'x' }, matcher: 'text', expected: 'y'.repeat(501) },
    ]) expect(parseStudioRequest(bad), JSON.stringify(bad)).toBeUndefined();
    const ev = { type: 'event', event: { kind: 'session', sessionId: 's1', payload: { type: 'turn', index: 0, turn: { tool: 'tap', result: 'ok' } } } };
    expect(parseFromWorker(ev)).toEqual(ev);
    expect(parseFromWorker({ type: 'event', event: { kind: 'other' } })).toBeUndefined();
  });

  it('렌더러 채널 이름은 studio: 접두사로 겹치지 않는다', () => {
    const names = Object.values(STUDIO_CHANNELS);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^studio:/);
  });
});
