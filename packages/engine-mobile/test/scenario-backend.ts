// 계약 스위트용 가짜 기기: 로그인 화면 → 홈 화면 상태 기계를 DeviceBackend 로 흉내 낸다(좌표 탭, 포커스된 입력 필드, 앱 실행/종료).
import type { DeviceBackend, DeviceInfo, Point } from '@sinclair/device-layer';
import type { SemanticNode, SnapshotResult } from '@sinclair/protocol';
import { findNodeByRef } from '@sinclair/protocol';
import { HOME_SCREEN, LOGIN_SCREEN } from '@sinclair/protocol/testing';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);

export class ScenarioBackend implements DeviceBackend {
  readonly platform = 'android' as const;
  readonly calls: string[] = [];
  /** 화면 키보드 표시 여부(테스트가 넣는다). 없으면 모름 */
  keyboardShown?: (deviceId: string) => Promise<boolean | undefined>;
  /** 앱이 실행 중이 아니면 빈 화면(root 만). */
  private screen: SemanticNode | undefined = structuredClone(LOGIN_SCREEN);
  private focused: string | undefined;
  /** true 면 다음 dump 마다 로그인 버튼 rect 가 움직인다(애니메이션 흉내). dumps 로 횟수를 센다. */
  animateButtonFor = 0;
  dumps = 0;
  /** 입력이 트리에 늦게 보이는 기기 흉내: text 뒤 이 횟수의 dump 동안 값이 아직 없다(실기기 YouTube 검색창 약 200ms). Infinity 면 끝내 안 보인다 */
  textLagDumps = 0;
  /** 화면 전환이 트리에 늦게 보이는 기기 흉내: 로그인 탭 뒤 이 횟수의 dump 동안 이전 화면이 보인다(실기기 탭 직후 관찰에 옛 화면) */
  screenLagDumps = 0;
  private pendingScreen: { screen: SemanticNode; dumpsLeft: number } | undefined;
  private pendingText: { ref: string; text: string; dumpsLeft: number } | undefined;

  constructor(private readonly id = 'PHONE1') {}

  /** 테스트에서 화면을 통째로 바꾼다(노드가 끼어들어 ref 가 밀리는 상황 등). */
  setScreen(screen: SemanticNode): void {
    this.screen = structuredClone(screen);
  }

  private hit(p: Point): SemanticNode | undefined {
    if (!this.screen) return undefined;
    let best: SemanticNode | undefined;
    const walk = (n: SemanticNode) => {
      const r = n.rect;
      if (r && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height && n.ref !== this.screen!.ref) best = n;
      for (const c of n.children ?? []) walk(c);
    };
    walk(this.screen);
    return best;
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return [{ id: this.id, platform: 'android', model: 'Scenario', osVersion: '14', state: 'device', helper: { state: 'ready', version: '0.1.0' } }];
  }
  async info(): Promise<DeviceInfo> { return (await this.listDevices())[0]!; }
  async screenshot(): Promise<Uint8Array> { return PNG; }
  async dumpUi(): Promise<SemanticNode> {
    this.dumps++;
    if (this.pendingScreen && this.pendingScreen.dumpsLeft-- <= 0) { this.screen = this.pendingScreen.screen; this.pendingScreen = undefined; }
    if (this.pendingText && this.screen) {
      if (this.pendingText.dumpsLeft-- <= 0) {
        const n = findNodeByRef(this.screen, this.pendingText.ref);
        if (n) n.value = (n.value ?? '') + this.pendingText.text;
        this.pendingText = undefined;
      }
    }
    const tree = structuredClone(this.screen ?? { ref: '@e0', role: 'root' });
    if (this.animateButtonFor > 0 && this.screen) {
      this.animateButtonFor--;
      const btn = findNodeByRef(tree, '@e4');
      if (btn?.rect) btn.rect = { ...btn.rect, y: btn.rect.y + 37 * (this.animateButtonFor + 1) };
    }
    return tree;
  }
  async snapshot(): Promise<SnapshotResult> {
    return { screenshot: { format: 'png', base64: PNG.toString('base64') }, root: await this.dumpUi(), atomic: true, capturedAt: new Date().toISOString() };
  }
  async tap(_: string, p: Point) {
    this.calls.push(`tap ${p.x},${p.y}`);
    const n = this.hit(p);
    if (!n) return;
    if (n.role === 'textbox') this.focused = n.ref;
    if (n.role === 'button' && n.name === '로그인' && !n.states?.disabled) {
      if (this.screenLagDumps > 0) this.pendingScreen = { screen: structuredClone(HOME_SCREEN), dumpsLeft: this.screenLagDumps };
      else this.screen = structuredClone(HOME_SCREEN);
    }
    if (n.role === 'button' && n.name === '로그아웃') this.screen = structuredClone(LOGIN_SCREEN);
  }
  async longPress(_: string, p: Point, d: number) { this.calls.push(`longpress ${p.x},${p.y} ${d}`); }
  async swipe(_: string, a: Point, b: Point, d: number) { this.calls.push(`swipe ${a.x},${a.y}->${b.x},${b.y} ${d}`); }
  async text(_: string, t: string) {
    this.calls.push(`text ${t}`);
    // 실제 `input text` 처럼 포커스가 없으면 아무 일도 없다(오류 아님)
    if (!this.focused || !this.screen) return;
    if (this.textLagDumps > 0) { this.pendingText = { ref: this.focused, text: t, dumpsLeft: this.textLagDumps }; return; }
    const n = findNodeByRef(this.screen, this.focused);
    if (n) n.value = (n.value ?? '') + t;
  }
  async keys(_: string, k: string[]) { this.calls.push(`keys ${k.join('+')}`); }
  async button(_: string, b: string) {
    this.calls.push(`button ${b}`);
    if (b === 'back' && this.screen?.ref === HOME_SCREEN.ref) this.screen = structuredClone(LOGIN_SCREEN);
  }
  async launchApp(_: string, a: string) { this.calls.push(`launch ${a}`); this.screen = structuredClone(LOGIN_SCREEN); this.focused = undefined; }
  async terminateApp(_: string, a: string) { this.calls.push(`terminate ${a}`); this.screen = undefined; }
  async openUrl(_: string, u: string) { this.calls.push(`url ${u}`); }
}
