// Console 링크(studio-console 04): 메인이 기본 브라우저로 여는 주소는 설정의 control-plane 아래 /console/ 뿐(렌더러가 임의 주소를 열지 못하게). 의존 없는 모듈
export function isConsoleUrl(url: string, controlPlane: string): boolean {
  try {
    const u = new URL(url);
    const base = new URL(controlPlane);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === base.origin && u.pathname.startsWith('/console/');
  } catch { return false; }
}
