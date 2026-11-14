# Studio (첫 묶음)

QA 엔지니어가 실기기를 보며 테스트를 만들고 디버깅하는 Electron 앱. 첫 묶음은 **기기 + Inspector + 에이전트 세션 + 코드 내보내기**. 테스트 파일 편집·실행(Monaco·러너 디버깅), Network(EverMock), Trace Viewer, Console 딥링크는 다음 묶음.

## 결정 (2026-11-14, 사용자)

| 항목 | 결정 |
| --- | --- |
| UI | **astryx 디자인 시스템**(`@astryxdesign/core` 0.7.15 + `theme-neutral`, StyleX 0.19.2), React 19. 규칙은 `apps/studio/AGENTS.md`(템플릿에서 시작, `<div>` 없이 컴포넌트로 레이아웃, 토큰만, 테마로 색). 시작 템플릿 `ide` |
| 기기 연결 | 디바이스 서버(JSON-RPC)에 붙는다 — ADR 0005(작업 프로세스가 열거나 데몬에 붙음) |
| 라이브 화면 | 스냅샷 폴링(`device.snapshot`: 스크린샷 + 트리 원자, 초당 2~5장). H.264 는 후속 |
| 실행 | Studio(작업 프로세스)가 러너·에이전트를 직접 돌린다(스텝 보고·중지) |
| 레이아웃 | 기기 왼쪽 고정 · 가운데 탭(세션, 이후 테스트 파일) · 오른쪽 Inspector · 아래 실행 로그 드로어 |
| 내보내기 | 자연어(`agent.act` + `agent.assert`, 녹화 캐시 저장)와 결정적 locator 코드 **둘 다 고를 수 있게** |
| Console 연결 | 다음 묶음(딥링크) |
| 빌드 | electron-vite(EverMock 과 같음), preload 는 CJS |

## 화면 (텍스트 와이어프레임)

```
┌ 툴바: [기기 ▾ SM-N981N (…XLZW) ● 연결됨]  [앱 ▾ com.google.android.youtube]  [▶ 세션] [⏹]        ┐
├─ 기기 ─────────┬─ [세션 ×] [+] ──────────────────────────┬─ Inspector ───────────────────┤
│ ┌───────────┐  │ 목표: [YouTube 에서 "…" 검색 ……] [실행] │ 트리   [검색…]                │
│ │           │  │ ─────────────────────────────────────── │ ▾ root                        │
│ │  스크린샷 │  │ 턴 1  tap button "검색"        ✓ 0.8s   │   ▾ group toolbar             │
│ │ (선택 노드 │  │ 턴 2  type textbox [YouTube 검색] ✓     │     ▸ button "검색"  ◀ 선택   │
│ │  하이라이트)│  │ 턴 3  submit                    ✓     │ ───────────────────────────── │
│ │           │  │ 턴 4  done "결과 목록이 열림"            │ 속성: role button · testId …  │
│ └───────────┘  │ [+ assert 추가] [코드로 내보내기 ▾]       │ locator 후보(현재 화면 매치 수)│
│ [◀ 뒤로][● 홈] │                                         │  getByRole('button',{name:'검색'}) 1 [복사] │
│ 클릭=탭 · 드래그=스와이프 · 입력=키보드                   │  getByTestId('…menu_item_view') 1 [복사]   │
├────────────────┴─────────────────────────────────────────┴───────────────────────────────┤
│ ▾ 로그  [스텝] [에이전트 턴 상세] [기기]                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- 기기 화면 클릭 → 그 좌표 탭, 그리고 Inspector 가 그 자리의 노드를 선택. 트리에서 노드를 고르면 화면에 하이라이트.
- locator 후보는 runner 의 locate 규칙으로 현재 화면에서 몇 개가 맞는지 함께 보인다(1 이 아니면 경고).
- 세션: 목표 → `runAct`(실제 모델), 턴마다 툴·대상·안전망·Incident 를 스트리밍, 중지. 끝나면 `agent.assert` 문장을 더해 판정. 녹화 캐시 기록(`read-write`, control-plane 이 있으면 공유 저장, 없으면 로컬 파일).
- 내보내기: (a) 자연어 `test(...)` — act + assert 를 그대로, (b) 결정적 — 녹화한 액션을 `screen.getByRole/Text/TestId(...).tap()/type()` 로 풀고 assert 는 자연어로 남김(결정적 판정으로 바꿀 수 있는 것은 `expect(...).toBeVisible()`).

## 범위 밖(다음 묶음)

테스트 파일 트리·Monaco 편집·실행(스텝 디버깅, 중단점), Trace Viewer, Network(EverMock), Console 딥링크, H.264 스트림, iOS.
