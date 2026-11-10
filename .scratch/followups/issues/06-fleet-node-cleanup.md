# 06: 노드 레코드 정리 — 사라진 노드가 플릿에 영원히 남지 않게

**What to build:** 보고가 끊긴 지 보존 기간(기본 7일, `--node-retention-ms` / `SINCLAIR_CP_NODE_RETENTION_MS`)이 지난 노드 레코드를 control-plane 이 지우고, 사람이 offline 노드를 바로 지울 수 있게 `DELETE /fleet/nodes/:agentId` 와 Console 플릿의 삭제 버튼을 둔다.

**Blocked by:** None

**Status:** done

## 수용 기준

- [x] `FleetStore.deleteNode(agentId)`(memory·SQLite 계약 스위트). `GET /fleet` 이 보존 기간 지난 노드를 지우고 보여 주지 않는다.
- [x] `DELETE /fleet/nodes/:agentId`: online 노드는 409(다시 보고하면 되살아나므로 의미 없음), 모르는 노드 404, 성공 204. 지운 노드가 다시 보고하면 새로 나타난다.
- [x] 기기 lease 는 Run 레코드에 있으므로 노드 삭제와 무관하다(lease 중 기기도 노드가 offline 이면 지울 수 있다).
- [x] Console 플릿: offline 노드에 "지우기" 버튼(확인 후), 지운 뒤 목록 새로 고침.

## Comments

- 2026-11-10 구현. `FleetStore.deleteNode(agentId, reportedBefore)`(deleted/recent/no-node — 판단과 삭제가 한 문장이라 그 사이 다시 보고한 노드는 남는다)·`pruneNodes(reportedBefore)`(memory·SQLite 계약 스위트, SQLite 는 `json_extract(record,'$.reportedAt') <` 한 문장). HTTP `DELETE /fleet/nodes/:agentId`(204 / 404 node-not-found / 409 node-online), `GET /fleet` 이 보존 기간 지난 노드를 지운다(경계는 offline 규칙 `now - reportedAt >= TTL` 과 같게). 설정 `--node-retention-ms` / `SINCLAIR_CP_NODE_RETENTION_MS`(기본 7일, lease TTL 이상). Console 플릿: 끊긴 노드에 "지우기"(확인 → DELETE → 화면에서 바로 빠짐, 실패는 경고).
- 증명: verify-console 8/8(`.scratch/console/evidence/verify-console-latest.json`) — 끊긴 노드의 지우기 버튼 렌더, 실제 서버의 DELETE 204·409, 지운 뒤 플릿.
- 스키마 변경 없음(SQLite 스키마 4 그대로).
