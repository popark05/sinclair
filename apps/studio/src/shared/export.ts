// 코드로 내보내기(studio 06): 에이전트 세션 → *.sinclair.ts.
// - 자연어: app.open(앱을 알면) + agent.act(목표) + 참이었던 판정의 agent.assert. 녹화 캐시에 저장하면 첫 실행부터 모델 없이 재생된다.
// - 결정적: 녹화 액션(성공한 툴 호출)을 그 턴의 화면에서 하나로 정해진 locator 로 — tap·type·press('Enter'), 스크롤·back 은 주석·app.back.
//   판정은 문장 그대로 agent.assert(결정적 판정으로 옮길 근거가 없다).
import type { JudgeView, SessionResult, TurnView } from './studio-ipc.ts';
import { jsString } from './locators.ts';

export interface SessionExportInput { goal: string; turns: TurnView[]; result?: SessionResult; judgments: Array<JudgeView & { statement: string }> }
export interface ExportOptions { style: 'natural' | 'deterministic'; testName: string; appId?: string }

const SECRET = /\{\{secret:([A-Z][A-Z0-9_]*)\}\}/g;
/** 글자 → JS 표현식: 비밀값 자리표시가 있으면 템플릿 리터럴로 secret() 을 이어 붙인다 */
function textExpr(text: string): { code: string; usesSecret: boolean } {
  if (!SECRET.test(text)) return { code: jsString(text), usesSecret: false };
  SECRET.lastIndex = 0;
  const parts = text.split(SECRET); // [글자, 이름, 글자, 이름, …]
  if (parts.length === 3 && parts[0] === '' && parts[2] === '') return { code: `secret('${parts[1]}')`, usesSecret: true };
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return { code: `\`${parts.map((p, i) => (i % 2 ? `\${secret('${p}')}` : esc(p))).join('')}\``, usesSecret: true };
}

export function exportTest(rec: SessionExportInput, opts: ExportOptions): string {
  const lines: string[] = [];
  const fixtures = new Set<string>();
  const passed = rec.judgments.filter((j) => j.pass);
  const failed = rec.judgments.filter((j) => !j.pass);

  if (opts.style === 'natural') {
    if (opts.appId) { fixtures.add('app'); lines.push(`  await app.open(${jsString(opts.appId)});`); }
    fixtures.add('agent');
    const goal = textExpr(rec.goal);
    if (goal.usesSecret) fixtures.add('secret');
    lines.push(`  await agent.act(${goal.code});`);
  } else {
    lines.push(`  // 목표: ${rec.goal.replace(/\n/g, ' ')}`);
    if (opts.appId) { fixtures.add('app'); lines.push(`  await app.open(${jsString(opts.appId)});`); }
    // 녹화 액션은 성공한 툴 호출(done 제외)과 같은 순서다 — 턴의 locator 와 짝짓는다
    const okTurns = rec.turns.filter((t) => t.result === 'ok' && t.tool && t.tool !== 'done');
    const actions = rec.result?.recording?.actions ?? [];
    okTurns.forEach((t, i) => {
      const a = actions[i];
      if (t.tool === 'back') { fixtures.add('app'); lines.push('  await app.back();'); return; }
      if (t.tool === 'scroll') { lines.push(`  // scroll${a?.direction ? ` ${a.direction}` : ''}: 결정적 코드로 옮기지 않음 — 다음 대상이 화면 밖이면 scrollIntoView() 를 쓴다`); return; }
      const text = t.tool === 'type' && a?.text !== undefined ? textExpr(a.text) : undefined;
      if (text?.usesSecret) fixtures.add('secret');
      if (!t.locator) {
        fixtures.add('screen'); // TODO 자리에 locator 를 채울 것이므로 screen 을 미리 받아 둔다
        const what = a?.target ? `${a.target.role}${a.target.label ? ` "${a.target.label}"` : ''}` : (t.target ?? '');
        lines.push(`  // TODO ${t.tool} ${what}: 이 화면에서 하나로 정해지는 locator 가 없음 — Inspector 로 고르세요.${text ? ` 입력: ${text.code}` : ''}`);
        return;
      }
      fixtures.add('screen');
      if (t.tool === 'tap') lines.push(`  await ${t.locator}.tap();`);
      else if (t.tool === 'submit') lines.push(`  await ${t.locator}.press('Enter');`);
      else if (t.tool === 'type') lines.push(`  await ${t.locator}.type(${text?.code ?? "''"});`);
      else lines.push(`  // ${t.tool}: 결정적 코드로 옮기지 않음`);
    });
  }
  for (const j of passed) { fixtures.add('agent'); lines.push(`  await agent.assert(${jsString(j.statement)});`); }
  for (const j of failed) lines.push(`  // 세션에서 거짓이었던 판정: agent.assert(${jsString(j.statement)}) — ${j.reason.replace(/\n/g, ' ')}`);

  const order = ['app', 'screen', 'agent', 'secret'];
  const params = order.filter((f) => fixtures.has(f)).join(', ');
  const head = opts.style === 'natural'
    ? `// Sinclair Studio 에서 내보냄: 에이전트 세션 1개(모델 ${rec.result?.modelCalls ?? 0}회)`
    : '// Sinclair Studio 에서 내보냄: 에이전트 세션의 액션을 결정적 locator 로(모델 없이 돈다 — 판정만 모델)';
  return `${head}\nimport { test } from '@sinclair/runner';\n\ntest(${jsString(opts.testName)}, async ({ ${params} }) => {\n${lines.join('\n')}\n});\n`;
}
