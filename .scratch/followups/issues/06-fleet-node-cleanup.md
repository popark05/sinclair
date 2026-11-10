# 06: 노드 레코드 정리 — 사라진 노드가 플릿에 영원히 남지 않게

**What to build:** 보고가 끊긴 지 보존 기간(기본 7일, `--node-retention-ms` / `SINCLAIR_CP_NODE_RETENTION_MS`)이 지난 노드 레코드를 control-plane 이 지우고, 사람이 offline 노드를 바로 지울 수 있게 `DELETE /fleet/nodes/:agentId` 와 Console 플릿의 삭제 버튼을 둔다.

**Blocked by:** None

**Status:** ready-for-agent

## 수용 기준

- [ ] `FleetStore.deleteNode(agentId)`(memory·SQLite 계약 스위트). `GET /fleet` 이 보존 기간 지난 노드를 지우고 보여 주지 않는다.
- [ ] `DELETE /fleet/nodes/:agentId`: online 노드는 409(다시 보고하면 되살아나므로 의미 없음), 모르는 노드 404, 성공 204. 지운 노드가 다시 보고하면 새로 나타난다.
- [ ] 기기 lease 는 Run 레코드에 있으므로 노드 삭제와 무관하다(lease 중 기기도 노드가 offline 이면 지울 수 있다).
- [ ] Console 플릿: offline 노드에 "지우기" 버튼(확인 후), 지운 뒤 목록 새로 고침.

## Comments
