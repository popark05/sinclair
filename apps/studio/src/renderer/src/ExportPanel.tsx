// 코드로 내보내기(studio 06): 끝난 세션을 *.sinclair.ts 로. 자연어(act + assert — 녹화 캐시에 저장하면 첫 실행부터 모델 없이 재생)
// 또는 결정적(녹화 액션을 그 화면에서 하나로 정해진 locator 로). 미리보기·복사·파일 저장(메인의 저장 대화상자).
import { useMemo, useState } from 'react';
import { Stack } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { CodeBlock } from '@astryxdesign/core/CodeBlock';
import { Text } from '@astryxdesign/core/Text';
import type { StudioApi } from '../../shared/studio-ipc.ts';
import { exportTest } from '../../shared/export.ts';
import type { SessionRecord } from './SessionPanel.tsx';

/** 기본 control-plane(로컬 개발 서버). 바꿀 수 있다 */
export const DEFAULT_CONTROL_PLANE = 'http://127.0.0.1:4780';
const defaultName = (goal: string): string => (goal.length > 60 ? `${goal.slice(0, 60)}…` : goal) || 'Studio 세션';

export function ExportPanel({ api, record, appId }: { api: StudioApi; record: SessionRecord; appId?: string }) {
  const [style, setStyle] = useState<'natural' | 'deterministic'>('natural');
  const [name, setName] = useState(() => defaultName(record.goal));
  const [controlPlane, setControlPlane] = useState(DEFAULT_CONTROL_PLANE);
  const [status, setStatus] = useState('');
  // 앱: 툴바에서 고른 앱, 없으면 세션이 시작된 화면의 앱
  const app = appId || record.result?.startApp || '';
  const code = useMemo(() => exportTest(record, { style, testName: name.trim() || 'Studio 세션', ...(app ? { appId: app } : {}) }), [record, style, name, app]);
  const recording = record.result?.recording;

  const run = async (label: string, f: () => Promise<string>): Promise<void> => {
    try { setStatus(await f()); } catch (err) { setStatus(`${label} 실패: ${err instanceof Error ? err.message : String(err)}`); }
  };

  return (
    <Stack as="section" aria-label="코드로 내보내기" direction="vertical" gap={2}>
      <Stack direction="horizontal" gap={2}>
        <SegmentedControl label="내보내기 방식" value={style} onChange={(v) => setStyle(v as 'natural' | 'deterministic')} size="sm">
          <SegmentedControlItem label="자연어" value="natural" />
          <SegmentedControlItem label="결정적" value="deterministic" />
        </SegmentedControl>
        <TextInput label="테스트 이름" isLabelHidden size="sm" placeholder="테스트 이름" value={name} onChange={(v) => setName(v)} />
      </Stack>
      <Stack as="section" aria-label="내보낼 코드" direction="vertical">
        <CodeBlock code={code} language="ts" size="sm" hasCopyButton={false} hasLineNumbers />
      </Stack>
      <Stack direction="horizontal" gap={2}>
        <Button label="복사" size="sm" variant="secondary" onClick={() => void run('복사', async () => { await navigator.clipboard.writeText(code); return '클립보드에 복사함'; })} />
        <Button label="파일로 저장" size="sm" variant="secondary" onClick={() => void run('저장', async () => { const p = await api.saveTestFile(name.trim() || 'studio-test', code); return p ? `저장함: ${p}` : '저장 취소'; })} />
        {style === 'natural' && recording ? (
          <>
            <TextInput label="control-plane 주소" isLabelHidden size="sm" value={controlPlane} onChange={(v) => setControlPlane(v)} />
            <Button label="녹화 캐시에 저장" size="sm" variant="secondary" onClick={() => void run('녹화 저장', async () => {
              await api.saveRecording({ controlPlane: controlPlane.trim(), testId: name.trim() || 'Studio 세션', goal: record.goal, app, recording });
              return '녹화 캐시에 저장함 — 이 테스트의 첫 실행부터 모델 없이 재생된다';
            })} />
          </>
        ) : null}
      </Stack>
      {!record.result?.freshStart ? <Text type="supporting" color="secondary">앱 처음 화면에서 시작하지 않은 세션 — 내보낸 테스트는 app.restart 로 앱 처음 화면에서 시작하므로 녹화 재생·locator 가 어긋날 수 있음. 세션 패널의 "앱 처음부터 시작" 으로 다시 돌리면 맞는다</Text> : null}
      {style === 'natural' && !recording ? <Text type="supporting" color="secondary">이 세션은 녹화가 없어(가림·애매한 대상) 녹화 캐시에 저장할 수 없음 — 첫 실행은 모델로 돈다</Text> : null}
      {status ? <Text type="supporting" color="secondary">{status}</Text> : null}
    </Stack>
  );
}
