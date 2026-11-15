# 03-url-scheme

**What to build:** sinclair://open?request=<id>: 메인 open-url(mac)·second-instance, 창 앞으로·요청 즉시 받기, Console 버튼이 요청 뒤 URL 열기

**Blocked by:** 02

**Status:** done — `sinclair://open?request=<uuid>`(id 만, 나머지 거부), 메인 open-url·두 번째 인스턴스 argv(설치본만 단일 인스턴스)·창 앞으로·그린 뒤 전달, 렌더러는 링크가 오면 폴링을 기다리지 않고 곧바로 받음, Console 은 요청 뒤 링크를 연다(설치돼 있지 않아도 중계로 닿음). 실기 확인은 04
