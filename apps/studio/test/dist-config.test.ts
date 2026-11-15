// Studio 설치본 설정(studio-packaging 02): URL 스킴 sinclair, 서명 없음, asar 에는 out·package.json 만, Resources 는 타깃별 원본(asar 밖).
import { describe, it, expect } from 'vitest';
import { builderConfig, STUDIO_TARGETS, URL_SCHEME } from '../../../scripts/dist-studio.mjs';

describe('builderConfig', () => {
  it('URL 스킴·서명 없음·파일·Resources·산출물 이름(아키텍처 포함)', () => {
    const c = builderConfig({ version: '0.1.0', appDir: '/s/app', outDir: '/r', resDir: '/s/res/mac-arm64', electronVersion: '45.2.0', arch: 'arm64' });
    expect(c.protocols).toEqual([{ name: 'Sinclair Studio', schemes: [URL_SCHEME] }]);
    expect(URL_SCHEME).toBe('sinclair');
    expect(c.mac.identity).toBeNull();
    expect(c.files).toEqual(['out/**/*', 'package.json']);
    expect(c.extraResources).toEqual([{ from: '/s/res/mac-arm64', to: '.', filter: ['**/*'] }]);
    expect(c.npmRebuild).toBe(false);
    expect(c.artifactName).toBe('Sinclair-Studio-${version}-mac-arm64.${ext}');
    expect(Object.keys(STUDIO_TARGETS)).toEqual(['mac-arm64', 'mac-x64']);
  });
});
