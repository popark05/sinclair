// 녹화 캐시 계약(recording-cache 01): agent.act 가 실제로 한 액션을 의미 기술자로 기록한 항목과 저장소.
// 러너가 쓰고 읽으며, control-plane 은 공유 저장소로 같은 검증기를 쓴다. 기술자에는 화면마다 바뀌는 ref·위치를 넣지 않는다.

export const CACHE_SCHEMA = 'rc-1';
/** 저장소 키: 키 필드의 canonical JSON sha256(64자 소문자 16진수). 파일 이름·URL 경로로 그대로 쓴다 */
export const CACHE_KEY = /^[0-9a-f]{64}$/;
export const CACHE_LIMITS = { actions: 50, text: 4096, label: 300, summary: 300, anchors: 8, bytes: 64 * 1024 } as const;
export const CACHE_TOOLS = ['tap', 'type', 'submit', 'scroll', 'back', 'enter_secret'] as const;
/** enter_secret 의 글자: 비밀값 자리표시 하나뿐(실제 값이 녹화에 들어가지 않게) */
export const SECRET_PLACEHOLDER_ONLY = /^\{\{secret:[A-Z][A-Z0-9_]{0,63}\}\}$/;
export type CacheTool = (typeof CACHE_TOOLS)[number];

/** 재생이 다시 찾을 대상. 정체 필드만(역할·이름 또는 글자·testId·placeholder) */
export interface CacheTarget { role: string; label?: string; testId?: string; placeholder?: string }
export interface CacheAction {
  tool: CacheTool;
  /** back 말고는 필수 */
  target?: CacheTarget;
  /** type 의 글자. 비밀값은 자리표시({{secret:이름}})로만 */
  text?: string;
  /** scroll 방향 */
  direction?: 'up' | 'down';
  /** 사람이 읽는 한 줄(재생 보고·이어받기 안내) */
  summary: string;
}
export interface CacheEntry {
  schema: typeof CACHE_SCHEMA;
  createdAt: string;
  /** 출처(키가 아니다) */
  recordedBy: { agentId?: string; deviceModel?: string; model?: string };
  /** 재생 전제: 시작 화면의 foreground 앱 */
  start: { app?: string };
  actions: CacheAction[];
  /** 결과 화면에 새로 나타난 이름 있는 노드: 재생 뒤 모두 있어야 한다 */
  end: { anchors: CacheTarget[] };
}

/** 교체 가능한 저장소. read 는 계약을 통과한 항목만(못 읽거나 깨졌으면 undefined — 미스). 키 모양이 틀리면 던진다 */
export interface CacheStore {
  read(key: string): Promise<CacheEntry | undefined>;
  write(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export function assertCacheKey(key: string): void {
  if (!CACHE_KEY.test(key)) throw new Error(`녹화 캐시 키는 64자 소문자 16진수여야 함: ${JSON.stringify(key.slice(0, 80))}`);
}

export type CacheEntryParse = { ok: true; value: CacheEntry } | { ok: false; errors: string[] };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): boolean => typeof v === 'string' && v.length <= max;

function checkTarget(t: unknown, at: string, errors: string[]): void {
  if (!isRecord(t)) { errors.push(`${at}: 객체여야 함`); return; }
  for (const k of Object.keys(t)) if (!['role', 'label', 'testId', 'placeholder'].includes(k)) errors.push(`${at}.${k}: 모르는 필드`);
  if (typeof t.role !== 'string' || !t.role || t.role.length > CACHE_LIMITS.label) errors.push(`${at}.role: 비어 있지 않은 문자열이어야 함`);
  for (const k of ['label', 'testId', 'placeholder'] as const) if (t[k] !== undefined && !str(t[k], CACHE_LIMITS.label)) errors.push(`${at}.${k}: ${CACHE_LIMITS.label}자 이하 문자열이어야 함`);
}

/** 닫힌 검사: 모르는 필드·툴, 툴에 맞지 않는 인자, 상한을 거부한다 */
export function parseCacheEntry(input: unknown): CacheEntryParse {
  if (!isRecord(input)) return { ok: false, errors: ['항목은 객체여야 함'] };
  const errors: string[] = [];
  for (const k of Object.keys(input)) if (!['schema', 'createdAt', 'recordedBy', 'start', 'actions', 'end'].includes(k)) errors.push(`${k}: 모르는 필드`);
  if (input.schema !== CACHE_SCHEMA) errors.push(`schema: ${CACHE_SCHEMA} 이어야 함`);
  if (typeof input.createdAt !== 'string') errors.push('createdAt: 문자열이어야 함');
  if (!isRecord(input.recordedBy)) errors.push('recordedBy: 객체여야 함');
  else for (const [k, v] of Object.entries(input.recordedBy)) if (!['agentId', 'deviceModel', 'model'].includes(k)) errors.push(`recordedBy.${k}: 모르는 필드`); else if (!str(v, CACHE_LIMITS.label)) errors.push(`recordedBy.${k}: 문자열이어야 함`);
  if (!isRecord(input.start)) errors.push('start: 객체여야 함');
  else for (const [k, v] of Object.entries(input.start)) if (k !== 'app') errors.push(`start.${k}: 모르는 필드`); else if (!str(v, CACHE_LIMITS.label)) errors.push('start.app: 문자열이어야 함');
  if (!Array.isArray(input.actions)) errors.push('actions: 배열이어야 함');
  else if (input.actions.length > CACHE_LIMITS.actions) errors.push(`actions: ${CACHE_LIMITS.actions}개 이하여야 함`);
  else input.actions.forEach((a: unknown, i: number) => {
    const at = `actions[${i}]`;
    if (!isRecord(a)) { errors.push(`${at}: 객체여야 함`); return; }
    for (const k of Object.keys(a)) if (!['tool', 'target', 'text', 'direction', 'summary'].includes(k)) errors.push(`${at}.${k}: 모르는 필드`);
    if (!(CACHE_TOOLS as readonly unknown[]).includes(a.tool)) { errors.push(`${at}.tool: ${CACHE_TOOLS.join('|')} 중 하나여야 함`); return; }
    if (a.tool === 'back') { if (a.target !== undefined) errors.push(`${at}.target: back 에는 없어야 함`); }
    else if (a.target === undefined) errors.push(`${at}.target: ${a.tool} 에는 필요함`);
    else checkTarget(a.target, `${at}.target`, errors);
    if (a.tool === 'type') { if (!str(a.text, CACHE_LIMITS.text)) errors.push(`${at}.text: ${CACHE_LIMITS.text}자 이하 문자열이어야 함`); }
    else if (a.tool === 'enter_secret') { if (typeof a.text !== 'string' || !SECRET_PLACEHOLDER_ONLY.test(a.text)) errors.push(`${at}.text: 비밀값 자리표시 하나({{secret:NAME}})여야 함`); }
    else if (a.text !== undefined) errors.push(`${at}.text: type·enter_secret 에만 있음`);
    if (a.tool === 'scroll') { if (a.direction !== 'up' && a.direction !== 'down') errors.push(`${at}.direction: up|down 이어야 함`); }
    else if (a.direction !== undefined) errors.push(`${at}.direction: scroll 에만 있음`);
    if (!str(a.summary, CACHE_LIMITS.summary)) errors.push(`${at}.summary: ${CACHE_LIMITS.summary}자 이하 문자열이어야 함`);
  });
  if (!isRecord(input.end) || !Array.isArray(input.end.anchors)) errors.push('end: { anchors: [...] } 이어야 함');
  else {
    for (const k of Object.keys(input.end)) if (k !== 'anchors') errors.push(`end.${k}: 모르는 필드`);
    if (input.end.anchors.length > CACHE_LIMITS.anchors) errors.push(`end.anchors: ${CACHE_LIMITS.anchors}개 이하여야 함`);
    else input.end.anchors.forEach((t: unknown, i: number) => checkTarget(t, `end.anchors[${i}]`, errors));
  }
  if (!errors.length && JSON.stringify(input).length > CACHE_LIMITS.bytes) errors.push(`항목이 ${CACHE_LIMITS.bytes} 바이트를 넘음`);
  return errors.length ? { ok: false, errors } : { ok: true, value: input as unknown as CacheEntry };
}

/** 메모리 저장소(단일 프로세스·테스트용, control-plane memory 모드). 항목은 JSON 문자열로 보관해 사본을 돌려준다 */
export interface MemoryCacheStore extends CacheStore { size(): number }
export function createMemoryCacheStore(): MemoryCacheStore {
  const entries = new Map<string, string>();
  return {
    async read(key) {
      assertCacheKey(key);
      const raw = entries.get(key);
      if (raw === undefined) return undefined;
      const parsed = parseCacheEntry(JSON.parse(raw));
      return parsed.ok ? parsed.value : undefined;
    },
    async write(key, entry) {
      assertCacheKey(key);
      const parsed = parseCacheEntry(entry);
      if (!parsed.ok) throw new Error(`녹화 캐시 항목이 계약을 통과하지 못함: ${parsed.errors.join('; ')}`);
      entries.set(key, JSON.stringify(entry));
    },
    async delete(key) { assertCacheKey(key); entries.delete(key); },
    size: () => entries.size,
  };
}
