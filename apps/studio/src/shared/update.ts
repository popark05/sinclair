// Studio 업데이트 상태(studio-update 03). 의존 없는 모듈(메인이 import — main-imports 테스트).
export type UpdateStatus =
  | { state: 'idle'; current: string; checkedAt?: string; /** 마지막 확인이 조용히 실패한 이유(주기 확인) */ note?: string }
  | { state: 'checking'; current: string }
  | { state: 'available'; current: string; version: string; size: number }
  | { state: 'downloading'; current: string; version: string; received: number; size: number }
  | { state: 'installing'; current: string; version: string }
  | { state: 'error'; current: string; error: string; version?: string }
  /** 이 실행에서는 업데이트할 수 없음(개발 모드, 디스크 이미지·격리 위치에서 실행 등) */
  | { state: 'unsupported'; current: string; reason: string };
