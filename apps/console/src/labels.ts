// 상태·판정의 화면 문구와 배지 색. 용어는 GLOSSARY 를 따른다.
import type { CycleState, CycleVerdict } from '@sinclair/protocol';

export const CYCLE_STATE_LABEL: Record<CycleState, string> = { draft: '준비', running: '진행 중', finished: '끝남', expired: '만료', cancelled: '취소됨' };
export const CYCLE_VERDICT_LABEL: Record<CycleVerdict, string> = { verified: '검증됨', blocked: '막힘', incomplete: '판정 전' };
export type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'info';
export const VERDICT_TONE: Record<CycleVerdict, Tone> = { verified: 'good', blocked: 'bad', incomplete: 'neutral' };
export const STATE_TONE: Record<CycleState, Tone> = { draft: 'neutral', running: 'info', finished: 'neutral', expired: 'warn', cancelled: 'warn' };

import type { CaseVerdict } from '@sinclair/protocol';
/** 매트릭스 셀: 케이스 판정 + 아직 결과 없음(대기) */
export type CellKind = CaseVerdict | 'pending';
export const CELL_LABEL: Record<CellKind, string> = { passed: '통과', 'passed-flaky': '통과(흔들림)', failed: '실패', blocked: '막힘', skipped: '건너뜀', waived: '면제', pending: '대기' };
export const CELL_ORDER: CellKind[] = ['passed', 'passed-flaky', 'failed', 'blocked', 'skipped', 'waived', 'pending'];
/** 기기 id 는 시리얼이라 화면에서도 끝 4자리만(증거 마스킹 규칙과 같게) */
export const maskDevice = (id: string | undefined): string => (id ? `…${id.slice(-4)}` : '—');
