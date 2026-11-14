// Studio 작업 화면(studio 01): astryx `ide` 템플릿의 틀(크기 조절·접기 패널, 하단 드로어, 반대편 패널)을 그대로 두고
// 내용만 Studio 4영역으로 — 왼쪽 기기(고정), 가운데 탭(세션), 오른쪽 Inspector, 아래 로그 드로어. 각 영역의 기능은 다음 티켓(02~06).
import { useEffect, useState, type CSSProperties } from 'react';
import { Layout, LayoutContent, LayoutPanel, Stack, StackItem } from '@astryxdesign/core/Layout';
import { ResizeHandle, useResizable } from '@astryxdesign/core/Resizable';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { List, ListItem } from '@astryxdesign/core/List';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { AppShell } from '@astryxdesign/core/AppShell';
import { ChatBubbleLeftRightIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import type { StudioApi, WorkerStatus } from '../../shared/studio-ipc.ts';
import { Toolbar } from './Toolbar.tsx';
import { DevicePanel } from './DevicePanel.tsx';
import { useSnapshot } from './useSnapshot.ts';

const styles: Record<string, CSSProperties> = {
  contentFill: { height: '100%' },
  terminalWrapper: { minHeight: 0, overflow: 'auto', display: 'grid' },
  tabListPadding: { paddingTop: 'var(--spacing-2)' },
  editorArea: { overflow: 'auto', minHeight: 0 },
  propertiesPanel: { height: '100%' },
  terminalPanel: { flexShrink: 0, overflow: 'hidden' },
};

/** 작업 프로세스 상태를 읽고 바뀔 때마다 갱신 */
function useWorkerStatus(api: StudioApi): WorkerStatus {
  const [status, setStatus] = useState<WorkerStatus>({ state: 'starting' });
  useEffect(() => {
    let alive = true;
    void api.getWorkerStatus().then((s) => { if (alive) setStatus(s); });
    const off = api.onWorkerStatus((s) => { if (alive) setStatus(s); });
    return () => { alive = false; off(); };
  }, [api]);
  return status;
}

export function workerStatusText(s: WorkerStatus): string {
  if (s.state === 'starting') return '띄우는 중';
  if (s.state === 'ready') return `준비됨 · Node ${s.node ?? '?'} · pid ${s.pid ?? '?'}`;
  return `종료됨${s.error ? ` · ${s.error}` : ''}`;
}

export function Workspace({ api }: { api: StudioApi }) {
  const worker = useWorkerStatus(api);
  const [centerTab, setCenterTab] = useState('session');
  const [drawerTab, setDrawerTab] = useState('log');
  const [inspectorTab, setInspectorTab] = useState('tree');
  // 고른 기기·앱(기기 화면·세션이 쓴다). 화면 폴링은 여기서 한 번 — Device 패널과 Inspector 가 같은 스냅샷을 본다
  const [deviceId, setDeviceId] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [, setAppId] = useState('');
  const screen = useSnapshot(api, deviceId);

  // 기기 화면은 세로로 길어 기본 폭을 넉넉히(폰 비율), Inspector 는 트리·속성이 읽힐 만큼
  const startPanel = useResizable({ defaultSize: 360, minSize: 240, maxSize: 560, collapsible: true, collapsedSize: 50 });
  const endPanel = useResizable({ defaultSize: 360, minSize: 220, maxSize: 560, collapsible: true, collapsedSize: 50 });
  const bottomPanel = useResizable({ defaultSize: 220, minSize: 80, maxSize: Infinity, direction: 'vertical', collapsible: true, collapsedSize: 40 });
  const isNarrow = useMediaQuery('(max-width: 768px)');

  // AppShell 이 뷰포트(100dvh)를 채우고, 그 안의 ide 레이아웃이 height fill 로 남은 높이를 채운다(루트에 높이가 없으면 내용만큼만 자란다)
  return (
    <AppShell height="fill" contentPadding={0} variant="section" mobileNav={false}
      topNav={<Toolbar api={api} onDeviceChange={(id, label) => { setDeviceId(id); setDeviceLabel(label ?? ''); }} onAppChange={setAppId} />}>
    <Layout
      height="fill"
      content={
        <LayoutContent padding={0}>
          <Layout
            height="fill"
            start={isNarrow ? undefined : (
              <>
                {!startPanel.isCollapsed && (
                  <LayoutPanel width={startPanel.size} hasDivider={false} padding={0}>
                    <DevicePanel api={api} deviceId={deviceId} deviceLabel={deviceLabel} {...(screen.snapshot ? { snapshot: screen.snapshot } : {})} {...(screen.error ? { error: screen.error } : {})} onInput={screen.refresh} />
                  </LayoutPanel>
                )}
                <ResizeHandle direction="horizontal" hasDivider isAlwaysVisible={false} resizable={startPanel.props} label="기기 패널 크기 조절" />
              </>
            )}
            content={
              <LayoutContent padding={0}>
                <Layout
                  height="fill"
                  content={
                    <LayoutContent padding={0}>
                      <Stack direction="vertical" style={styles.contentFill}>
                        <TabList value={centerTab} onChange={setCenterTab} size="sm" style={styles.tabListPadding}>
                          <Tab label="세션" value="session" />
                        </TabList>
                        <StackItem size="fill" style={styles.editorArea}>
                          <Stack as="section" aria-label="세션" direction="vertical" style={styles.contentFill}>
                            <EmptyState
                              icon={<Icon icon={ChatBubbleLeftRightIcon} size="lg" />}
                              title="에이전트 세션"
                              description="목표를 자연어로 넣으면 에이전트가 기기를 조작하고, 한 일을 테스트 코드로 내보냅니다."
                            />
                          </Stack>
                        </StackItem>
                        <ResizeHandle direction="vertical" hasDivider isReversed isAlwaysVisible={false} resizable={bottomPanel.props} label="로그 드로어 크기 조절" />
                        {!bottomPanel.isCollapsed && (
                          <Stack as="section" aria-label="로그" direction="vertical" height={bottomPanel.size} style={styles.terminalPanel}>
                            <TabList value={drawerTab} onChange={setDrawerTab} size="sm" hasDivider={false} style={styles.tabListPadding}>
                              <Tab label="로그" value="log" />
                              <Tab label="스텝" value="steps" />
                              <Tab label="에이전트 턴" value="turns" />
                            </TabList>
                            <StackItem size="fill" style={styles.terminalWrapper}>
                              <List>
                                <ListItem
                                  label="작업 프로세스"
                                  endContent={<Text type="supporting" color={worker.state === 'exited' ? 'secondary' : 'primary'} maxLines={1}>{workerStatusText(worker)}</Text>}
                                />
                              </List>
                            </StackItem>
                          </Stack>
                        )}
                      </Stack>
                    </LayoutContent>
                  }
                  end={isNarrow ? undefined : (
                    <>
                      <ResizeHandle direction="horizontal" hasDivider isReversed isAlwaysVisible={false} resizable={endPanel.props} label="Inspector 크기 조절" />
                      {!endPanel.isCollapsed && (
                        <LayoutPanel width={endPanel.size} hasDivider={false} padding={4}>
                          <Stack as="section" aria-label="Inspector" direction="vertical" gap={3} style={styles.propertiesPanel}>
                            <SegmentedControl label="Inspector 보기" value={inspectorTab} onChange={setInspectorTab} size="sm" layout="fill">
                              <SegmentedControlItem label="화면 트리" value="tree" />
                              <SegmentedControlItem label="속성" value="props" />
                            </SegmentedControl>
                            <EmptyState
                              isCompact
                              icon={<Icon icon={Squares2X2Icon} size="lg" />}
                              title="화면 트리 없음"
                              description="기기를 연결하면 지금 화면의 노드 트리와 locator 후보가 보입니다."
                            />
                          </Stack>
                        </LayoutPanel>
                      )}
                    </>
                  )}
                />
              </LayoutContent>
            }
          />
        </LayoutContent>
      }
    />
    </AppShell>
  );
}
