// URL 스킴(studio-packaging 03): sinclair://open?request=<id> 만 받는다 — 데이터는 control-plane 중계, URL 에는 요청 id 만.
import { describe, it, expect } from 'vitest';
import { parseStudioLink, studioLink } from '../src/shared/studio-link.ts';

const ID = '3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b';
describe('parseStudioLink', () => {
  it('sinclair://open?request=<uuid> → 요청 id; 만들기와 왕복', () => {
    expect(parseStudioLink(`sinclair://open?request=${ID}`)).toEqual({ requestId: ID });
    expect(parseStudioLink(studioLink(ID))).toEqual({ requestId: ID });
  });
  it('다른 스킴·동작·형식이 아닌 id·추가 정보는 거부', () => {
    for (const u of [`https://open?request=${ID}`, `sinclair://run?request=${ID}`, 'sinclair://open?request=../../etc', 'sinclair://open', 'not a url', `sinclair://open?request=${ID}&goal=x`]) expect(parseStudioLink(u)).toBeUndefined();
  });
});
