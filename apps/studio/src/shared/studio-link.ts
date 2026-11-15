// URL 스킴(studio-packaging 03): sinclair://open?request=<id>. Console 이 control-plane 에 열기 요청을 남긴 뒤 이 URL 을 열면
// 설치본 Studio 가 앞으로 와서 그 요청을 곧바로 받는다(폴링 차례를 기다리지 않음). 데이터는 중계 하나 — URL 에는 요청 id 만 싣고 나머지는 거부한다.
// 메인 프로세스가 닿는 모듈이라 워크스페이스 패키지를 import 하지 않는다.
export const STUDIO_URL_SCHEME = 'sinclair';
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const studioLink = (requestId: string): string => `${STUDIO_URL_SCHEME}://open?request=${encodeURIComponent(requestId)}`;

export function parseStudioLink(raw: string): { requestId: string } | undefined {
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  if (u.protocol !== `${STUDIO_URL_SCHEME}:` || u.hostname !== 'open' || (u.pathname && u.pathname !== '/')) return undefined;
  const keys = [...u.searchParams.keys()];
  const id = u.searchParams.get('request');
  if (keys.length !== 1 || !id || !ID.test(id)) return undefined;
  return { requestId: id };
}
