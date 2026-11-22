<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: server/ 폴더 안내. 권위 서버 시제품의 구조(공통 방 로직 core/와 VM용 Node 어댑터), 설치·실행·시험 명령과 자세한 문서(docs/SERVER.md) 위치.
-->
# SKALA 작전 권위 서버 (시제품)

클라이언트는 입력만 보내고, 서버가 30 Hz로 이동·사격·라운드(팀전)와 킬·부활·보상(개인전)을 판정해 상태를 보낸다. 게임 규칙은 저장소의 `js/` 순수 모듈(physics·movement·player·match·weapons)을 그대로 불러 쓴다.
구조·프로토콜·틱·되감기·운영·배포 계획은 [docs/SERVER.md](../docs/SERVER.md)에 있다.

- `core/`: 플랫폼을 모르는 공통 방 로직. `core/room.js`의 `createRoom({ send })`가 방 하나의 규칙이다(VM과 Durable Objects가 같이 쓴다).
- `node.js`, `node/`: VM용 Node WebSocket 어댑터(`ws://<호스트>:<포트>/room/<방 id>`, `/healthz`, `/metrics`).
- `tools/`: 가짜 클라이언트, 한 판 돌리기 명령(`bots.js`), 부하 측정 명령(`load.js`). `test/`: WebSocket 시험(방 규칙 시험은 저장소 `tests/`에 있어 `npm test`에 들어간다).

저장소 루트에서:

```bash
npm --prefix server ci                 # 의존성(ws) 설치, 처음 한 번
npm run server -- --port 8787          # ws://127.0.0.1:8787/room/<방 id>
npm run server:bots -- --bots 6        # 떠 있는 서버에 가짜 클라이언트 6명을 붙여 한 판
npm run server:load -- --rooms 4 --bots 8 --seconds 180   # 개인전 방 4개 × 8명 부하 측정(서버는 --max-per-ip 1000으로 띄운다, docs/SERVER.md 14절)
npm run test:server                    # WebSocket 시험
```

`server/`는 `js/`를 상대 경로로 불러 쓰므로 배포할 때 두 폴더를 함께 둔다. 사이트(GitHub Pages)는 이 폴더를 쓰지 않는다.
