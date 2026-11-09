// 상태·판정의 화면 문구와 배지 색. 용어는 GLOSSARY 를 따른다.
import type { CycleState, CycleVerdict } from '@sinclair/protocol';

export const CYCLE_STATE_LABEL: Record<CycleState, string> = { draft: '준비', running: '진행 중', finished: '끝남', expired: '만료', cancelled: '취소됨' };
export const CYCLE_VERDICT_LABEL: Record<CycleVerdict, string> = { verified: '검증됨', blocked: '막힘', incomplete: '판정 전' };
export type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'info';
export const VERDICT_TONE: Record<CycleVerdict, Tone> = { verified: 'good', blocked: 'bad', incomplete: 'neutral' };
export const STATE_TONE: Record<CycleState, Tone> = { draft: 'neutral', running: 'info', finished: 'neutral', expired: 'warn', cancelled: 'warn' };
