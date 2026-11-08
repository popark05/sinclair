# 업그레이드

새 zip 을 다른 디렉터리에 풀고 런처만 바꿔도 데이터 디렉터리의 DB·스풀이 그대로 쓰인다.

## Sub-features

- `upgrade-db` 이전 설치본이 쓴 SQLite DB 를 새 설치 디렉터리의 서버가 열어 같은 `GET /runs/:id` 를 돌려준다.
- `upgrade-schema` 스키마 버전은 기동 시 올라가고(현재 2), 더 새로운 DB 는 이전 버전이 거부한다(`verify-ingest` `schema-check.sh`).

## How to get to it (user POV)

README "업그레이드" 절: 새 디렉터리에 풀고 런처 교체, 데이터는 그대로.

## Driving it with scripts

```bash
$S/upgrade-check.sh $RUN      # UPGRADE OK (서버가 새 설치 디렉터리로 다시 떠 있다)
```

## Gotchas

- 같은 zip 을 다시 푼 것으로 "새 버전" 을 흉내 낸다. 실제 스키마 마이그레이션은 단위 테스트(`cycle-store.test.ts` 1→2)가 덮는다.
