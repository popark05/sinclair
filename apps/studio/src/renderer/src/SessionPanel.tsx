// 에이전트 세션(studio 05): 목표를 넣어 실행하면 작업 프로세스가 고른 기기에서 agent.act(실제 모델)를 돌리고,
// 턴이 오는 대로 타임라인에 쌓는다. 실행 중엔 중지, 끝나면 결과. 지금 화면에 대한 판정(agent.assert)도 더할 수 있다.
// 세션 기록(목표·턴·판정·녹화)은 onRecord 로 넘겨 내보내기(06)가 쓴다.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Stack, StackItem } from '@astryxdesign/core/Layout';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { Selector } from '@astryxdesign/core/Selector';
import { APP_ID, type AgentStatus, type Judgment, type SessionResult, type StudioApi, type TurnView } from '../../shared/studio-ipc.ts';
import { EXPECT_MATCHERS, expectCode, locatorCode, type ExpectMatcher, type JudgeQuery } from '../../shared/expect-judge.ts';
import { ExportPanel } from './ExportPanel.tsx';

export interface SessionRecord { goal: string; turns: TurnView[]; result?: SessionResult; judgments: Judgment[] }
/** 요소 판정의 대상(Inspector·화면에서 고른 노드의, 그 화면에서 하나로 정해지는 첫 locator 후보) */
export interface JudgeTarget { query: JudgeQuery; code: string; text?: string; value?: string }

/** 판정 목록 한 줄 */
export const judgmentText = (j: Judgment): string => (j.kind === 'expect' ? `${j.pass ? '통과' : '실패'} · ${expectCode(locatorCode(j.query), j.matcher, j.expected)}` : `${j.pass ? '참' : '거짓'} · ${j.statement}`);

const GUARD = { gone: '사라짐', ambiguous: '애매함', covered: '덮임' } as const;
const styles: Record<string, CSSProperties> = {
  panel: { padding: 'var(--spacing-4)', height: '100%' },
  scroll: { minHeight: 0, overflow: 'auto' },
};

export function turnText(t: TurnView, index: number): string {
  const head = `${index + 1}. ${t.tool ?? '(툴 없음)'}${t.target ? ` ${t.target}` : ''}${t.retargeted ? ` → ${t.retargeted}` : ''}`;
  if (t.guard) return `${head} — 안전망: ${GUARD[t.guard]}`;
  return t.result === 'ok' ? head : `${head} — ${t.result === 'rejected' ? '거부' : '오류'}`;
}

export function resultText(r: SessionResult): string {
  const usage = r.inputTokens !== undefined ? ` · 입력 ${r.inputTokens.toLocaleString('en-US')} 토큰` : '';
  return r.ok ? `성공 — ${r.summary ?? ''} · ${r.turns}턴 · 모델 ${r.modelCalls}회${usage}` : `실패 — ${r.reason ?? ''} · ${r.turns}턴 · 모델 ${r.modelCalls}회${usage}`;
}

export interface SessionPanelProps {
  api: StudioApi; deviceId: string; appId?: string; onRecord?: (r: SessionRecord) => void;
  /** 세션이 기기를 쓰는 중인지(Workspace 가 화면 폴링을 멈춘다) */
  onBusyChange?: (busy: boolean) => void;
  /** 턴 하나가 끝날 때마다(Workspace 가 화면을 한 번 받는다) */
  onTurn?: () => void;
  /** 요소 판정 대상(고른 노드). 없으면 요소 판정 줄 대신 안내 */
  target?: JudgeTarget;
}

export function SessionPanel({ api, deviceId, appId, onRecord, onBusyChange, onTurn, target }: SessionPanelProps) {
  const [matcher, setMatcher] = useState<ExpectMatcher>('visible');
  const [expected, setExpected] = useState('');
  // 대상이 바뀌면 값 칸을 그 노드의 글자·값으로 채운다(글자·값 검사의 출발점)
  useEffect(() => { setExpected(target?.value ?? target?.text ?? ''); }, [target?.code, target?.text, target?.value]);
  const [status, setStatus] = useState<AgentStatus>();
  const [goal, setGoal] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [record, setRecord] = useState<SessionRecord>();
  const [statement, setStatement] = useState('');
  const [problem, setProblem] = useState('');
  /** 앱 처음부터 시작(studio 08): 내보낸 테스트는 app.restart 로 처음 화면에서 시작하므로 세션도 같은 화면에서 */
  const [fresh, setFresh] = useState(true);
  const current = useRef<string>(undefined);

  useEffect(() => { void api.agentStatus().then(setStatus, (err: unknown) => setStatus({ ready: false, reason: err instanceof Error ? err.message : String(err) })); }, [api]);
  useEffect(() => api.onEvent((e) => {
    if (e.kind !== 'session' || e.sessionId !== current.current) return;
    const p = e.payload;
    setRecord((r) => {
      if (!r) return r;
      const next = p.type === 'turn' ? { ...r, turns: [...r.turns.slice(0, p.index), p.turn] } : { ...r, result: p.result };
      if (p.type === 'done') onRecord?.(next);
      return next;
    });
    if (p.type === 'turn') onTurn?.();
    if (p.type === 'done') { current.current = undefined; setSessionId(undefined); }
  }), [api, onRecord, onTurn]);

  const running = sessionId !== undefined;
  useEffect(() => { onBusyChange?.(running); }, [running, onBusyChange]);
  const canRestart = !!appId && APP_ID.test(appId);
  const restartApp = canRestart && fresh ? appId : undefined;
  const canRun = !!deviceId && !!status?.ready && !!goal.trim() && !running;
  const run = async (): Promise<void> => {
    setProblem('');
    try {
      setRecord({ goal: goal.trim(), turns: [], judgments: [] });
      const { sessionId: id } = await api.startSession(deviceId, goal.trim(), restartApp ? { restartApp } : undefined);
      current.current = id;
      setSessionId(id);
    } catch (err) { setProblem(err instanceof Error ? err.message : String(err)); }
  };
  const judge = async (): Promise<void> => {
    const st = statement.trim();
    if (!st || !deviceId) return;
    try {
      const j = await api.assertNow(deviceId, st);
      addJudgment({ ...j, statement: st });
      setStatement('');
    } catch (err) { setProblem(err instanceof Error ? err.message : String(err)); }
  };

  const addJudgment = (j: Judgment): void => setRecord((r) => { const next = { ...(r ?? { goal: '', turns: [], judgments: [] }), judgments: [...(r?.judgments ?? []), j] }; onRecord?.(next); return next; });
  const needsValue = EXPECT_MATCHERS[matcher].needsValue;
  const judgeElement = async (): Promise<void> => {
    if (!target || !deviceId) return;
    try {
      const v = await api.expectCheck(deviceId, target.query, matcher, needsValue ? expected : undefined);
      addJudgment({ kind: 'expect', query: target.query, matcher, ...(needsValue ? { expected } : {}), ...v });
    } catch (err) { setProblem(err instanceof Error ? err.message : String(err)); }
  };

  const why = !deviceId ? '기기를 고르세요' : status && !status.ready ? status.reason : undefined;
  return (
    <Stack as="section" aria-label="세션" direction="vertical" gap={3} style={styles.panel}>
      <TextArea label="목표" value={goal} onChange={(v) => setGoal(v)} rows={2} placeholder='예: YouTube 앱에서 "florence guerin 영화" 를 검색해 결과 목록을 연다' />
      <CheckboxInput
        label="앱 처음부터 시작"
        description={canRestart ? `${appId} 를 종료하고 다시 띄운 뒤 시작 — 내보낸 테스트와 같은 시작 화면` : '툴바에 앱 id 를 넣으면 쓸 수 있음 — 지금 화면에서 시작'}
        value={canRestart && fresh}
        onChange={(v) => setFresh(v)}
        isDisabled={!canRestart || running}
      />
      <Stack direction="horizontal" gap={2}>
        {running
          ? <Button label="중지" variant="destructive" size="sm" onClick={() => void api.stopSession(sessionId)} />
          : <Button label="실행" variant="primary" size="sm" isDisabled={!canRun} onClick={() => void run()} />}
        <Text type="supporting" color="secondary" maxLines={2}>{running ? '실행 중…' : why ?? (status?.model ? `모델 ${status.model}` : '')}</Text>
      </Stack>
      {record?.result ? <Stack as="output" aria-label="세션 결과" direction="vertical"><Text color={record.result.ok ? 'primary' : 'secondary'}>{resultText(record.result)}</Text></Stack> : null}
      {problem ? <Text type="supporting" color="secondary">{problem}</Text> : null}
      <StackItem size="fill" style={styles.scroll}>
        <List aria-label="턴">
          {(record?.turns ?? []).map((t, i) => <ListItem key={i} label={turnText(t, i)} {...(t.detail && t.result !== 'ok' ? { description: t.detail } : {})} />)}
        </List>
      </StackItem>
      <Stack direction="horizontal" gap={2}>
        <StackItem size="fill">
          <TextInput label="판정 문장" isLabelHidden size="sm" width="100%" placeholder="지금 화면에서 참이어야 할 문장 — 예: 검색 결과 목록이 열려 있다" value={statement} onChange={(v) => setStatement(v)} />
        </StackItem>
        <Button label="판정" size="sm" variant="secondary" isDisabled={!deviceId || !status?.ready || running || !statement.trim()} onClick={() => void judge()} />
      </Stack>
      {target ? (
        <Stack as="section" aria-label="요소 판정" direction="vertical" gap={1}>
          <Text type="supporting" color="secondary" maxLines={2}>선택한 노드: {target.code}</Text>
          <Stack direction="horizontal" gap={2}>
            <Selector label="검사 종류" isLabelHidden size="sm" variant="secondary" options={Object.entries(EXPECT_MATCHERS).map(([value, m]) => ({ value, label: m.label }))} value={matcher} onChange={(v) => { if (v) setMatcher(v as ExpectMatcher); }} />
            {needsValue ? <StackItem size="fill"><TextInput label="판정 값" isLabelHidden size="sm" width="100%" placeholder="기대하는 글자·값" value={expected} onChange={(v) => setExpected(v)} /></StackItem> : null}
            <Button label="요소 판정" size="sm" variant="secondary" isDisabled={!deviceId || running} onClick={() => void judgeElement()} />
          </Stack>
        </Stack>
      ) : <Text type="supporting" color="secondary">Inspector 나 기기 화면에서 노드를 고르면 요소 판정(모델 없이 보인다·글자·값·체크 검사)을 더할 수 있음</Text>}
      <List aria-label="판정">
        {(record?.judgments ?? []).map((j, i) => <ListItem key={i} label={judgmentText(j)} description={j.reason} />)}
      </List>
      {record?.result?.ok && !running ? <ExportPanel api={api} record={record} {...(appId ? { appId } : {})} /> : null}
    </Stack>
  );
}
