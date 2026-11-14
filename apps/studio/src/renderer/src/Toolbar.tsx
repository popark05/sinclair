// 툴바(studio 02): 기기 연결 방식(데몬·직접·없음), 기기 선택, 앱 id(현재 앱으로 채우기). AppShell 의 topNav 슬롯에 놓는다.
// 기기 시리얼은 화면에 원시로 보이지 않게 끝 4자리만(Console 과 같은 규칙).
import { useEffect, useState } from 'react';
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav';
import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Button } from '@astryxdesign/core/Button';
import { Stack } from '@astryxdesign/core/Layout';
import { Text } from '@astryxdesign/core/Text';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import type { StudioSettings } from '../../shared/settings.ts';
import type { ConnectionInfo, StudioApi, StudioDevice } from '../../shared/studio-ipc.ts';

const MODE: Record<ConnectionInfo['mode'], string> = { daemon: '데몬', own: '직접', none: '연결 없음' };
const STATE: Record<string, string> = { device: '연결됨', unauthorized: 'USB 디버깅 미승인', offline: '오프라인' };
export const maskSerial = (id: string): string => `…${id.slice(-4)}`;
export const deviceLabel = (d: StudioDevice): string => `${d.model} (${maskSerial(d.id)})`;

/** Console 의 열기 요청(studio-console 06): 그 기기를 고르고 앱 id 를 채운다. nonce 가 바뀔 때마다 */
export interface SelectRequest { deviceId: string; app?: string; nonce: number }

export function Toolbar({ api, onDeviceChange, onAppChange, selectRequest }: { api: StudioApi; onDeviceChange: (id: string, label?: string) => void; onAppChange: (app: string) => void; selectRequest?: SelectRequest }) {
  const [conn, setConn] = useState<ConnectionInfo>();
  const [devices, setDevices] = useState<StudioDevice[]>([]);
  const [device, setDevice] = useState('');
  const [app, setApp] = useState('');
  const [problem, setProblem] = useState('');
  /** 버튼 바로 옆 상태(사유·결과). 툴바 끝은 눈에 잘 띄지 않아 누른 버튼 옆에 보인다 */
  const [note, setNote] = useState('');
  // 설정(studio-console 03): control-plane 주소·테스트 폴더 — 메인 프로세스가 저장한다
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draft, setDraft] = useState<StudioSettings>({ controlPlane: '', testsDir: '' });
  const [settingsProblem, setSettingsProblem] = useState('');
  const openSettings = async (): Promise<void> => {
    setSettingsProblem('');
    try { setDraft(await api.getSettings()); } catch (err) { setSettingsProblem(err instanceof Error ? err.message : String(err)); }
    setSettingsOpen(true);
  };
  const saveSettings = async (): Promise<void> => {
    try { setDraft(await api.setSettings({ controlPlane: draft.controlPlane.trim(), testsDir: draft.testsDir.trim() })); setSettingsOpen(false); setNote('설정 저장함'); }
    catch (err) { setSettingsProblem(err instanceof Error ? err.message : String(err)); }
  };

  /** manual: 새로 고침 버튼(결과를 버튼 옆에). 처음 불러올 때는 조용히 */
  const load = async (manual = false): Promise<void> => {
    try {
      const [c, list] = await Promise.all([api.connection(), api.listDevices()]);
      setConn(c);
      setDevices(list);
      setProblem('');
      if (manual) setNote(`기기 ${list.length}대 · ${new Date().toLocaleTimeString('ko-KR', { hour12: false })} 새로 고침`);
      // 고른 기기가 없거나 사라졌으면 첫 쓸 수 있는 기기
      setDevice((cur) => {
        const keep = list.some((d) => d.id === cur) ? cur : list.find((d) => d.state === 'device')?.id ?? '';
        const d = list.find((x) => x.id === keep);
        if (keep !== cur) onDeviceChange(keep, d ? deviceLabel(d) : undefined);
        return keep;
      });
    } catch (err) { const m = err instanceof Error ? err.message : String(err); setProblem(m); setNote(`새로 고침 실패: ${m}`); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [api]);

  useEffect(() => {
    if (!selectRequest) return;
    let alive = true;
    void (async () => {
      try {
        const list = await api.listDevices(); // 요청의 기기가 목록에 막 들어왔을 수 있다
        if (!alive) return;
        setDevices(list);
        const d = list.find((x) => x.id === selectRequest.deviceId);
        if (!d) { setNote(`Console 의 요청 기기 …${selectRequest.deviceId.slice(-4)} 가 연결돼 있지 않음`); return; }
        setDevice(d.id);
        onDeviceChange(d.id, deviceLabel(d));
        if (selectRequest.app) { setApp(selectRequest.app); onAppChange(selectRequest.app); }
        setNote(`Console 에서 열림 — ${deviceLabel(d)}`);
      } catch (err) { if (alive) setNote(`Console 요청을 열지 못함: ${err instanceof Error ? err.message : String(err)}`); }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectRequest?.nonce]);

  const pickDevice = (id: string): void => { setDevice(id); const d = devices.find((x) => x.id === id); onDeviceChange(id, d ? deviceLabel(d) : undefined); };
  const changeApp = (v: string): void => { setApp(v); onAppChange(v); };
  const fillForeground = async (): Promise<void> => {
    if (!device) return;
    setNote('현재 앱 확인 중…');
    try { const a = await api.foregroundApp(device); if (a) { changeApp(a); setNote(`현재 앱: ${a}`); } else setNote('지금 화면의 앱을 알 수 없음 — 앱 id 를 직접 넣으세요'); } catch (err) { setNote(`현재 앱 실패: ${err instanceof Error ? err.message : String(err)}`); }
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
          <Button label="새로 고침" size="sm" variant="ghost" onClick={() => void load(true)} />
          <Button label="설정" size="sm" variant="ghost" onClick={() => void openSettings()} />
          <Dialog isOpen={settingsOpen} onOpenChange={setSettingsOpen} width={520} aria-label="Studio 설정">
            <DialogHeader title="설정" onOpenChange={setSettingsOpen} />
            <Stack direction="vertical" gap={3} style={{ padding: 'var(--spacing-4)' }}>
              <TextInput label="control-plane 주소" size="sm" value={draft.controlPlane} onChange={(v) => setDraft((d) => ({ ...d, controlPlane: v }))} />
              <TextInput label="테스트 폴더" size="sm" description="Cycle 로 실행할 때 내보낸 테스트를 두는 곳(같은 머신의 데몬이 읽는다)" value={draft.testsDir} onChange={(v) => setDraft((d) => ({ ...d, testsDir: v }))} />
              {settingsProblem ? <Text type="supporting" color="secondary">{settingsProblem}</Text> : null}
              <Button label="설정 저장" size="sm" variant="primary" onClick={() => void saveSettings()} />
            </Stack>
          </Dialog>
          <Stack as="output" aria-label="툴바 상태" role="status"><Text type="supporting" color="secondary" maxLines={1}>{note}</Text></Stack>
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
