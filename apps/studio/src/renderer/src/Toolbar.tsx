// 툴바(studio 02): 기기 연결 방식(데몬·직접·없음), 기기 선택, 앱 id(현재 앱으로 채우기). AppShell 의 topNav 슬롯에 놓는다.
// 기기 시리얼은 화면에 원시로 보이지 않게 끝 4자리만(Console 과 같은 규칙).
import { useEffect, useState } from 'react';
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Stack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import type { ConnectionInfo, StudioApi, StudioDevice } from '../../shared/studio-ipc.ts';

const MODE: Record<ConnectionInfo['mode'], string> = { daemon: '데몬', own: '직접', none: '연결 없음' };
const STATE: Record<string, string> = { device: '연결됨', unauthorized: 'USB 디버깅 미승인', offline: '오프라인' };
export const maskSerial = (id: string): string => `…${id.slice(-4)}`;
export const deviceLabel = (d: StudioDevice): string => `${d.model} (${maskSerial(d.id)})`;

export function Toolbar({ api, onDeviceChange, onAppChange }: { api: StudioApi; onDeviceChange: (id: string) => void; onAppChange: (app: string) => void }) {
  const [conn, setConn] = useState<ConnectionInfo>();
  const [devices, setDevices] = useState<StudioDevice[]>([]);
  const [device, setDevice] = useState('');
  const [app, setApp] = useState('');
  const [problem, setProblem] = useState('');

  const load = async (): Promise<void> => {
    try {
      const [c, list] = await Promise.all([api.connection(), api.listDevices()]);
      setConn(c);
      setDevices(list);
      setProblem('');
      // 고른 기기가 없거나 사라졌으면 첫 쓸 수 있는 기기
      setDevice((cur) => {
        const keep = list.some((d) => d.id === cur) ? cur : list.find((d) => d.state === 'device')?.id ?? '';
        if (keep !== cur) onDeviceChange(keep);
        return keep;
      });
    } catch (err) { setProblem(err instanceof Error ? err.message : String(err)); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [api]);

  const pickDevice = (id: string): void => { setDevice(id); onDeviceChange(id); };
  const changeApp = (v: string): void => { setApp(v); onAppChange(v); };
  const fillForeground = async (): Promise<void> => {
    if (!device) return;
    try { const a = await api.foregroundApp(device); if (a) changeApp(a); else setProblem('지금 화면의 앱을 알 수 없음'); } catch (err) { setProblem(err instanceof Error ? err.message : String(err)); }
  };

  return (
    <TopNav
      label="Studio 툴바"
      heading={<TopNavHeading heading="Sinclair Studio" />}
      startContent={
        <Stack direction="horizontal" gap={2}>
          <Selector
            label="기기" isLabelHidden size="sm" variant="secondary" placeholder={devices.length ? '기기 선택' : '기기 없음'}
            options={devices.map((d) => ({ value: d.id, label: deviceLabel(d), description: STATE[d.state] ?? d.state, disabled: d.state !== 'device' }))}
            value={device} onChange={(v) => { if (v) pickDevice(v); }}
            isDisabled={devices.length === 0}
          />
          <TextInput label="앱 id" isLabelHidden size="sm" placeholder="com.example.app" value={app} onChange={(v) => changeApp(v)} />
          <Button label="현재 앱" size="sm" variant="secondary" isDisabled={!device} onClick={() => void fillForeground()} />
          <Button label="새로 고침" size="sm" variant="ghost" onClick={() => void load()} />
        </Stack>
      }
      endContent={
        <Stack direction="horizontal" gap={2}>
          {conn ? <Text type="supporting" color={conn.mode === 'none' ? 'secondary' : 'primary'} maxLines={1}>{MODE[conn.mode]}</Text> : null}
          {conn?.mode === 'none' || problem ? <Text type="supporting" color="secondary" maxLines={1}>{problem || conn?.detail}</Text> : null}
        </Stack>
      }
    />
  );
}
