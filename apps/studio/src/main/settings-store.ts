// Studio 설정 저장(studio-console 03): userData/settings.json. 없거나 깨졌으면 기본값. ~/ 는 홈으로 펴서 돌려준다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { parseStudioSettings, type StudioSettings } from '../shared/settings.ts';

export const DEFAULT_CONTROL_PLANE = 'http://127.0.0.1:4780';

export function createSettingsStore(file: string, home: string) {
  const expand = (p: string): string => (p.startsWith('~/') ? path.join(home, p.slice(2)) : p);
  const defaults = (): StudioSettings => ({ controlPlane: DEFAULT_CONTROL_PLANE, testsDir: path.join(home, 'Sinclair', 'tests') });
  return {
    async get(): Promise<StudioSettings> {
      try {
        const parsed = parseStudioSettings(JSON.parse(await readFile(file, 'utf8')));
        if (parsed.ok) return { ...parsed.value, testsDir: expand(parsed.value.testsDir) };
      } catch { /* 없거나 깨짐: 기본값 */ }
      return defaults();
    },
    async set(raw: unknown): Promise<StudioSettings> {
      const parsed = parseStudioSettings(raw);
      if (!parsed.ok) throw new Error(`설정이 올바르지 않음: ${parsed.errors.join('; ')}`);
      const value = { ...parsed.value, testsDir: expand(parsed.value.testsDir) };
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
      return value;
    },
  };
}
