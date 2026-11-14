// 작은따옴표 JS 문자열 리터럴. 의존이 없는 모듈로 둔다 — 메인 프로세스(Electron 의 Node)가 import 하는 shared 모듈이
// 워크스페이스 패키지(TS 소스)를 런타임에 끌어오면 앱이 뜨지 않는다(main-imports 테스트가 지킨다).
export const jsString = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
