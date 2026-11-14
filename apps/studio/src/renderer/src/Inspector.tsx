// Inspector(studio 04): 같은 스냅샷의 화면 트리, 고른 노드의 속성, locator 후보(현재 화면 매치 수 — 1 이 아니면 경고)와 복사.
import { useMemo, useState, type CSSProperties } from 'react';
import { Stack, StackItem } from '@astryxdesign/core/Layout';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { TreeList, type TreeListItemData } from '@astryxdesign/core/TreeList';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { List, ListItem } from '@astryxdesign/core/List';
import { Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Icon } from '@astryxdesign/core/Icon';
import { Squares2X2Icon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import type { SemanticNode } from '@sinclair/protocol';
import type { StudioSnapshot } from '../../shared/studio-ipc.ts';
import { findNode, locatorCandidates, nodeProps, treeLabel } from './inspector-model.ts';

const styles: Record<string, CSSProperties> = {
  panel: { height: '100%' },
  scroll: { minHeight: 0, overflow: 'auto' },
  code: { fontFamily: 'var(--font-family-mono, monospace)', wordBreak: 'break-all' },
};

/** 검색어가 있으면 맞는 노드와 그 조상만 남긴다(대소문자 무시) */
function toItems(n: SemanticNode, selected: string | undefined, onSelect: (ref: string) => void, query: string): TreeListItemData | undefined {
  const children = (n.children ?? []).map((c) => toItems(c, selected, onSelect, query)).filter((c): c is TreeListItemData => !!c);
  const label = treeLabel(n);
  const hit = !query || label.toLowerCase().includes(query);
  if (!hit && children.length === 0) return undefined;
  return { id: n.ref, label: <Text maxLines={1}>{label}</Text>, isSelected: n.ref === selected, isExpanded: true, onClick: () => onSelect(n.ref), ...(children.length ? { children } : {}) };
}

export function Inspector({ snapshot, selectedRef, onSelect }: { snapshot: StudioSnapshot | undefined; selectedRef: string | undefined; onSelect: (ref: string) => void }) {
  const [tab, setTab] = useState('tree');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  const items = useMemo(() => {
    if (!snapshot) return [];
    const top = toItems(snapshot.root, selectedRef, onSelect, query.trim().toLowerCase());
    return top ? [top] : [];
  }, [snapshot, selectedRef, onSelect, query]);
  const node = snapshot && selectedRef ? findNode(snapshot.root, selectedRef) : undefined;
  const candidates = snapshot && node ? locatorCandidates(snapshot.root, node) : [];

  const copy = async (code: string): Promise<void> => {
    try { await navigator.clipboard.writeText(code); setCopied(code); } catch { setCopied(''); }
  };

  return (
    <Stack as="section" aria-label="Inspector" direction="vertical" gap={3} style={styles.panel}>
      <SegmentedControl label="Inspector 보기" value={tab} onChange={setTab} size="sm" layout="fill">
        <SegmentedControlItem label="화면 트리" value="tree" />
        <SegmentedControlItem label="속성" value="props" />
      </SegmentedControl>
      {!snapshot ? (
        <EmptyState isCompact icon={<Icon icon={Squares2X2Icon} size="lg" />} title="화면 트리 없음" description="기기를 연결하면 지금 화면의 노드 트리와 locator 후보가 보입니다." />
      ) : tab === 'tree' ? (
        <>
          <TextInput label="트리 검색" isLabelHidden size="sm" placeholder="역할·이름·testId" startIcon={MagnifyingGlassIcon} value={query} onChange={(v) => setQuery(v)} />
          <StackItem size="fill" style={styles.scroll}>
            <TreeList items={items} density="compact" />
          </StackItem>
        </>
      ) : null}
      {snapshot && node ? (
        <Stack direction="vertical" gap={2}>
          <Text type="label">선택한 노드</Text>
          {tab === 'props' ? (
            <MetadataList>
              {nodeProps(node).map(([k, v]) => <MetadataListItem key={k} label={k}>{v}</MetadataListItem>)}
            </MetadataList>
          ) : <Text type="supporting" color="secondary" maxLines={1}>{treeLabel(node)}</Text>}
          <List aria-label="locator 후보">
            {candidates.length === 0 ? <ListItem label="이 노드로는 locator 를 만들 수 없음 — 이름·글자·testId 가 있는 조상을 고르세요" /> : candidates.map((c) => (
              <ListItem
                key={c.code}
                label={<Text maxLines={3} style={styles.code}>{c.code}</Text>}
                description={c.count === 1 ? '현재 화면 1개' : `현재 화면 ${c.count}개 — 하나로 정해지지 않음`}
                endContent={<Button label={copied === c.code ? '복사됨' : '복사'} aria-label="복사" size="sm" variant="ghost" onClick={() => void copy(c.code)} />}
              />
            ))}
          </List>
        </Stack>
      ) : null}
    </Stack>
  );
}
