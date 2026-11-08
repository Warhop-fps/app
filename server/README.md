<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: server/ 폴더 안내. 권위 서버 시제품을 설치·실행·시험하는 명령과 자세한 문서(docs/SERVER.md) 위치.
-->
# SKALA 작전 권위 서버 (시제품)

클라이언트는 입력만 보내고, 서버가 30 Hz로 이동·사격·라운드를 판정해 상태를 보낸다. 게임 규칙은 저장소의 `js/` 순수 모듈(physics·movement·player·match·weapons)을 그대로 불러 쓴다.
구조·프로토콜·틱·되감기·배포 계획은 [docs/SERVER.md](../docs/SERVER.md)에 있다.

저장소 루트에서:

```bash
npm --prefix server ci                 # 의존성(ws) 설치, 처음 한 번
npm run server -- --port 8787          # ws://127.0.0.1:8787/ws, /healthz, /metrics
npm run server:bots -- --bots 6        # 떠 있는 서버에 가짜 클라이언트 6명을 붙여 한 판
npm run test:server                    # node:test 시험
```

`server/`는 `js/`를 상대 경로로 불러 쓰므로 배포할 때 두 폴더를 함께 둔다. 사이트(GitHub Pages)는 이 폴더를 쓰지 않는다.
