#!/bin/bash
# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: 옛 슬롯의 게임 프로세스를 비운다. Caddy가 이미 새 방을 새 슬롯으로만 보내므로 옛 프로세스에는 진행 중인 방만 남는다.
#          접속(skala_connections)이 0이 된 프로세스부터 멈추고, FPS_DRAIN_MAX_SECONDS가 지나면 남은 것도 멈춘다.
#          deploy.sh가 systemd-run --unit fps-drain-<슬롯>으로 띄워 SSM 명령이 끝나도 계속 돈다.
set -uo pipefail

# shellcheck source=common.sh
. /usr/local/lib/fps/common.sh
# shellcheck disable=SC1091
. /etc/fps/deploy.env

slot=${1:?비울 슬롯(a 또는 b)이 필요합니다}
fps_check_slot "$slot" || exit 2
max=${FPS_DRAIN_MAX_SECONDS:-1800}
interval=10
deadline=$(($(date +%s) + max))
log() { echo "[drain $slot] $*"; }

ports=$(fps_slot_value "$slot" FPS_PORTS)
read -r -a port_list <<< "$ports"
log "시작: 포트 ${ports:-없음}, 최대 ${max}초"

while :; do
  left=0
  for i in "${!port_list[@]}"; do
    index=$((i + 1))
    unit="fps-game@$slot$index.service"
    systemctl is-active --quiet "$unit" || continue
    port=${port_list[$i]}
    conns=$(fps_metric "$port" skala_connections) || conns=""
    if [ -z "$conns" ]; then
      log "$unit 응답 없음 → 멈춤"
      systemctl stop "$unit" || true
    elif [ "$conns" = "0" ]; then
      log "$unit 접속 0 → 멈춤"
      systemctl stop "$unit" || true
    else
      left=$((left + 1))
    fi
  done
  if ((left == 0)); then
    log "끝: 모든 옛 프로세스가 멈췄습니다"
    break
  fi
  if (($(date +%s) >= deadline)); then
    log "최대 시간 ${max}초가 지나 남은 ${left}개를 멈춥니다(접속 중인 사람은 끊기고 다시 들어오면 새 버전으로 간다)"
    break
  fi
  sleep "$interval"
done

fps_stop_slot "$slot"
