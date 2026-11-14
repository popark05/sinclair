// @vitest-environment node
// 메인 프로세스(Electron 내장 Node)는 워크스페이스 패키지의 TS 소스를 런타임에 읽지 못한다(타입 스트리핑만 — 파라미터 프로퍼티 등에서 앱이 뜨지 않음).
// 메인이 닿는 모듈(상대 import 를 따라)에 '@sinclair/*' 런타임 import 가 없어야 한다. 작업 프로세스는 --experimental-transform-types 로 돈다(ADR 0005).
// 2026-11-14: shared/expect-judge → locators → @sinclair/protocol 이 studio-ipc 를 통해 메인에 들어가 앱이 "App threw an error during load" 로 멈췄다.
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../src');
const IMPORT = /^\s*(import|export)\s+(?!type\b)([^'";]*?\bfrom\s+)?['"]([^'"]+)['"]/gm;

function runtimeImports(file: string, seen = new Set<string>()): Array<{ from: string; spec: string }> {
  if (seen.has(file)) return [];
  seen.add(file);
  const out: Array<{ from: string; spec: string }> = [];
  const code = fs.readFileSync(file, 'utf8');
  for (const m of code.matchAll(IMPORT)) {
    const clause = m[2] ?? '';
    // `import { type A, type B } from` 처럼 이름이 전부 type 이면 런타임 import 가 아니다
    const names = /\{([^}]*)\}/.exec(clause)?.[1];
    if (names && names.split(',').map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith('type '))) continue;
    const spec = m[3]!;
    if (spec.startsWith('.')) out.push(...runtimeImports(path.resolve(path.dirname(file), spec), seen));
    else out.push({ from: path.relative(SRC, file), spec });
  }
  return out;
}

describe('메인 프로세스 import', () => {
  it('메인·preload 가 닿는 모듈에 워크스페이스 패키지 런타임 import 가 없다', () => {
    for (const entry of ['main/index.ts', 'preload/index.ts']) {
      const bad = runtimeImports(path.join(SRC, entry)).filter((i) => i.spec.startsWith('@sinclair/'));
      expect(bad, entry).toEqual([]);
    }
  });
});
