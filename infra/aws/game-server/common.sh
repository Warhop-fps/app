#!/bin/bash
# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: 배포·비우기·실행 스크립트가 같이 쓰는 함수. 슬롯(a·b)마다 포트 묶음을 정하고 /healthz·/metrics를 읽는다.
#          슬롯 a = 8801부터, 슬롯 b = 8901부터. 프로세스 하나 = 포트 하나 = CPU 코어 하나.

FPS_STATE_DIR=/etc/fps/state
FPS_LIB_DIR=/usr/local/lib/fps

# 슬롯 이름 검사. a 또는 b만 받는다
fps_check_slot() {
  case "$1" in
    a|b) return 0 ;;
    *) echo "슬롯은 a 또는 b여야 합니다: $1" >&2; return 1 ;;
  esac
}

# 슬롯의 첫 포트 바로 앞 값(a=8800, b=8900)
fps_port_base() {
  case "$1" in
    a) echo 8800 ;;
    b) echo 8900 ;;
    *) return 1 ;;
  esac
}

# 슬롯과 순번(1부터)의 포트
fps_port() {
  local base
  base=$(fps_port_base "$1") || return 1
  echo $((base + $2))
}

# 슬롯의 포트 목록(공백으로 구분). fps_slot_ports a 2 → "8801 8802"
fps_slot_ports() {
  local i out=""
  for ((i = 1; i <= $2; i++)); do out="$out $(fps_port "$1" "$i")"; done
  echo "${out# }"
}

# 한 포트의 /healthz가 200이면 0
fps_healthy() {
  curl --fail --silent --show-error --max-time 2 --output /dev/null "http://127.0.0.1:$1/healthz" 2>/dev/null
}

# 제한 시간(초) 안에 /healthz가 200이 되기를 기다린다
fps_wait_healthy() {
  local port=$1 timeout=$2 waited=0
  while ((waited < timeout)); do
    if fps_healthy "$port"; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# /metrics에서 라벨 없는 값 하나를 읽는다. 못 읽으면 빈 문자열과 실패
fps_metric() {
  curl --fail --silent --max-time 2 "http://127.0.0.1:$1/metrics" 2>/dev/null | awk -v name="$2" '$1 == name { print $2; found = 1; exit } END { if (!found) exit 1 }'
}

# 슬롯 파일(/etc/fps/state/slot-<a|b>.env)의 값 하나. 없으면 빈 문자열
fps_slot_value() {
  local file="$FPS_STATE_DIR/slot-$1.env"
  [ -f "$file" ] || return 0
  # shellcheck disable=SC1090
  (. "$file" && eval "printf '%s' \"\$$2\"")
}

# 슬롯의 게임 프로세스가 부팅 때 다시 켜지지 않게 한다(지금 도는 것은 그대로)
fps_disable_slot() {
  local slot=$1 link
  fps_check_slot "$slot" || return 1
  for link in /etc/systemd/system/multi-user.target.wants/fps-game@"$slot"*.service; do
    [ -e "$link" ] || continue
    systemctl disable --quiet "$(basename "$link")" || true
  done
  return 0
}

# 슬롯의 게임 프로세스를 모두 멈추고 부팅 때 다시 켜지지 않게 한다
fps_stop_slot() {
  fps_check_slot "$1" || return 1
  systemctl stop "fps-game@$1*.service" 2> /dev/null || true
  fps_disable_slot "$1"
}
