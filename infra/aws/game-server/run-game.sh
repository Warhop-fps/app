#!/bin/bash
# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: systemd fps-game@<슬롯><순번> 하나를 실행한다. 순번으로 포트를 정하고 그 슬롯의 릴리스 폴더에서 게임 서버 명령을 띄운다.
#          예: fps-game@a2 → PORT=8802, /etc/fps/state/slot-a.env의 FPS_RELEASE 폴더에서 FPS_SERVICE_COMMAND 실행.
set -euo pipefail
set -f   # 명령을 낱말로 나눌 때 * 같은 글자를 파일 이름으로 바꾸지 않는다

# shellcheck source=common.sh
. /usr/local/lib/fps/common.sh
# shellcheck disable=SC1091
. /etc/fps/deploy.env

instance=${1:?fps-game@<슬롯><순번> 형식이어야 합니다}
slot=${instance:0:1}
index=${instance:1}
fps_check_slot "$slot"
if ! [[ $index =~ ^[1-9][0-9]?$ ]]; then
  echo "순번은 1~99여야 합니다: $instance" >&2
  exit 2
fi

release=$(fps_slot_value "$slot" FPS_RELEASE)
if [ -z "$release" ] || [ ! -f "$release/.fps-ready" ]; then
  echo "슬롯 $slot의 릴리스 폴더가 준비되지 않았습니다: '$release'" >&2
  exit 1
fi

PORT=$(fps_port "$slot" "$index")
export PORT
export FPS_SLOT=$slot FPS_INSTANCE=$instance
# 경기 결과의 serverId(docs/MATCH_RESULT_CONTRACT.md). 서버 이름과 프로세스 이름으로 프로세스마다 다르게 만든다
GAME_SERVER_ID="$(hostname -s | tr -cd 'A-Za-z0-9.-' | cut -c1-40):$instance"
export GAME_SERVER_ID
cd "$release"
# FPS_SERVICE_COMMAND는 Terraform 변수 service_command(따옴표·$ 없는 한 줄)다. 낱말로 나눠 그대로 실행한다
# shellcheck disable=SC2086
exec $FPS_SERVICE_COMMAND
