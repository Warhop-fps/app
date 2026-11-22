/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 서버(server/, 서버가 판정하는 방)와 브라우저가 함께 쓰는 메시지 약속. 프로토콜 판, 키 비트, 스냅샷 줄 칸 순서, 닫기 코드를 한곳에 둔다.
 *          server/core/protocol.js가 이 값을 그대로 다시 내보낸다. 순수 모듈이라 node 시험에서도 불러 쓴다(docs/SERVER.md 3절).
 */

/** 메시지 형식 판. 형식을 바꾸면 올린다(옛 클라이언트는 join에서 bad_version을 받고 새로고침 안내를 띄운다) */
export const PROTOCOL = 2;
/** 버전이 다를 때 서버가 error.message에 싣는 말 */
export const RELOAD_MESSAGE = '새로고침 필요';   // i18n-ok: 서버가 싣는 고정 표시. 화면은 t('net.reloadRequired')를 쓴다

/** 누르고 있는 키(input.keys) */
export const KEY = Object.freeze({
  FORWARD: 1, BACK: 2, LEFT: 4, RIGHT: 8, JUMP: 16, CROUCH: 32, WALK: 64, FIRE: 128, AIM: 256
});
export const KEY_MASK = 0x1ff;

/** 이번 입력 사이에 새로 누른 키(input.press). 한 입력 안에서 눌렀다 뗀 클릭도 놓치지 않으려고 따로 싣는다 */
export const PRESS = Object.freeze({ JUMP: 1, FIRE: 2, AIM: 4, RELOAD: 8, NEXT: 16, PREV: 32 });
export const PRESS_MASK = 0x3f;

/** 끊을 때 쓰는 닫기 코드. 1xxx는 WebSocket 표준, 4xxx는 게임 서버가 정한 값 */
export const CLOSE = Object.freeze({
  NORMAL: 1000, GOING_AWAY: 1001, POLICY: 1008, TOO_BIG: 1009,
  ROOM_FULL: 4001, BAD_VERSION: 4002, JOIN_TIMEOUT: 4003, SERVER_FULL: 4004, BAD_JOIN: 4005, SLOW: 4006, ROOM_ERROR: 4007
});

/**
 * 스냅샷 줄의 칸 순서. 위치 cm 정수, 각도 mrad(0.001 rad) 정수, flags는 js/game/protocol.js의 FLAG 비트.
 * ack = 그 사람의 입력 중 서버가 마지막으로 처리한 번호(클라이언트 예측·보정의 기준).
 */
export const ROW = Object.freeze({ ID: 0, X: 1, Y: 2, Z: 3, YAW: 4, PITCH: 5, FLAGS: 6, HP: 7, WEAPON: 8, ACK: 9 });
