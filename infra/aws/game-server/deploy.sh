#!/bin/bash
# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: 서버 안에서 게임 서버 한 버전을 무중단으로 바꾼다(root로 실행, SSM 배포 문서와 첫 부팅 user-data가 부른다).
#          순서: 스크립트·유닛 설치 → 비밀 값 다시 읽기 → 릴리스 폴더(의존성 설치) → 빈 슬롯에 새 프로세스(코어 수만큼)
#          → 모든 새 프로세스의 /healthz 확인 → Caddy를 새 포트로 전환 → 옛 슬롯 비우기(drain.sh).
#          새 프로세스가 건강하지 않으면 새 것만 멈추고 옛 버전은 그대로 둔 채 실패로 끝난다.
# 사용법: deploy.sh <커밋 40자> [태그 이름]
set -euo pipefail
umask 022
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export HOME=${HOME:-/root}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
src=$(cd "$here/../../.." && pwd)
# shellcheck source=common.sh
. "$here/common.sh"
# shellcheck disable=SC1091
. /etc/fps/deploy.env

sha=${1:?배포할 커밋 해시(40자)가 필요합니다}
ref=${2:-$sha}
log() { echo "[deploy] $*"; }
die() { echo "[deploy] 실패: $*" >&2; exit 1; }
[[ $sha =~ ^[0-9a-f]{40}$ ]] || die "커밋 해시 40자가 아닙니다: $sha"
[[ $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]] || die "태그 이름에 쓸 수 없는 글자가 있습니다: $ref"

# 배포는 한 번에 하나만
install -d -m 0755 /run/fps-deploy
exec 9> /run/fps-deploy/lock
flock --nonblock 9 || die "다른 배포가 진행 중입니다. 끝난 뒤 다시 실행하세요"

# 1) 이 커밋의 스크립트와 systemd 유닛을 설치한다(배포마다 같은 버전으로 맞춘다)
install -d -m 0755 "$FPS_LIB_DIR" "$FPS_STATE_DIR" /opt/fps/releases
install -m 0755 "$here/common.sh" "$here/run-game.sh" "$here/drain.sh" "$FPS_LIB_DIR/"
install -m 0644 "$here/secrets.mjs" "$here/metrics-agent.mjs" "$FPS_LIB_DIR/"
install -m 0644 "$here"/systemd/*.service "$here"/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet fps-secrets.service fps-metrics.timer

# 2) SSM Parameter Store에서 비밀 값을 다시 읽는다. 이미 도는 프로세스는 옛 값을 계속 쓴다
systemctl restart fps-secrets.service || die "비밀 값을 읽지 못했습니다(journalctl -u fps-secrets 확인, SOP 실패 표)"

# 3) 릴리스 폴더: 커밋 내용을 그대로 풀고 서버 의존성을 설치한다. 코드는 root 소유, 게임 계정은 읽기만 한다
release=/opt/fps/releases/$sha
if [ ! -f "$release/.fps-ready" ]; then
  log "릴리스 준비: $ref ($sha)"
  rm -rf "$release.tmp"
  install -d -m 0755 "$release.tmp"
  git -C "$src" archive --format=tar "$sha" | tar -x -C "$release.tmp"
  [ -f "$release.tmp/server/node.js" ] || log "경고: server/node.js가 없습니다. service_command가 이 커밋과 맞는지 확인하세요"
  # shellcheck disable=SC2086
  (cd "$release.tmp" && set -f && npm_config_cache=/var/cache/fps-npm $FPS_INSTALL_COMMAND) || die "의존성 설치 실패: $FPS_INSTALL_COMMAND"
  printf '%s %s\n' "$ref" "$sha" > "$release.tmp/.fps-ready"
  rm -rf "$release"
  mv "$release.tmp" "$release"
fi

# 4) 슬롯 정하기: 지금 받는 슬롯(active)이 아닌 쪽에 새 버전을 띄운다
old=$(cat "$FPS_STATE_DIR/active-slot" 2>/dev/null || true)
if [ "$old" = a ]; then new=b; else new=a; fi
workers=${FPS_WORKERS:-0}
[[ $workers =~ ^[0-9]+$ ]] || die "FPS_WORKERS는 숫자여야 합니다: $workers"
((workers > 0)) || workers=$(nproc)
((workers <= 64)) || workers=64
# 새 슬롯에 지난 배포의 비우는 중인 프로세스가 남아 있으면 지금 멈춘다(그 방의 사람은 끊긴다)
systemctl stop "fps-drain-$new.service" 2>/dev/null || true
fps_stop_slot "$new"
ports=$(fps_slot_ports "$new" "$workers")
cat > "$FPS_STATE_DIR/slot-$new.env.tmp" <<EOF
FPS_RELEASE=$release
FPS_SHA=$sha
FPS_REF=$ref
FPS_WORKERS=$workers
FPS_PORTS="$ports"
EOF
mv "$FPS_STATE_DIR/slot-$new.env.tmp" "$FPS_STATE_DIR/slot-$new.env"

# 5) 새 프로세스 시작(코어 하나에 하나, 방 하나는 한 프로세스 안의 단일 스레드 액터)
log "슬롯 $new에 프로세스 $workers개 시작: 포트 $ports"
for ((i = 1; i <= workers; i++)); do
  systemctl start "fps-game@$new$i.service"
done

# 6) 건강 확인: 모든 새 프로세스의 /healthz가 200이어야 다음으로 간다
for port in $ports; do
  if ! fps_wait_healthy "$port" "${FPS_HEALTH_TIMEOUT_SECONDS:-60}"; then
    log "포트 $port의 /healthz가 ${FPS_HEALTH_TIMEOUT_SECONDS:-60}초 안에 200이 아닙니다. 새 프로세스를 멈추고 옛 버전을 그대로 둡니다"
    journalctl --no-pager --lines 40 -u "fps-game@$new*" || true
    fps_stop_slot "$new"
    die "건강 확인 실패"
  fi
done
log "새 프로세스 모두 건강함"

# 7) Caddy 전환: 새 방(새 접속)은 새 포트로만 간다. 옛 WebSocket은 stream_close_delay 동안 끊지 않는다
close_delay=$((${FPS_DRAIN_MAX_SECONDS:-1800} + 60))
upstreams=""
for port in $ports; do upstreams="$upstreams 127.0.0.1:$port"; done
caddyfile=/etc/caddy/Caddyfile
cat > "$caddyfile.new" <<EOF
# deploy.sh가 배포마다 새로 쓴다. 직접 고치지 말 것($ref, 슬롯 $new)
{
	servers {
		timeouts {
			read_header 10s
			idle 2m
		}
	}
}

$FPS_GAME_HOST {
	# 지표는 서버 안(지표 수집기)에서만 읽는다
	handle /metrics {
		respond 404
	}
	handle {
		# 방 주소 /room/<id>를 해시해 같은 방은 늘 같은 프로세스로 보낸다(방 주소에 ?쿼리를 붙이지 않는다)
		reverse_proxy$upstreams {
			lb_policy uri_hash
			lb_try_duration 2s
			health_uri /healthz
			health_interval 5s
			health_timeout 2s
			flush_interval -1
			stream_close_delay ${close_delay}s
			transport http {
				dial_timeout 2s
				keepalive 2m
			}
		}
	}
}
EOF
caddy validate --config "$caddyfile.new" --adapter caddyfile > /dev/null 2>&1 || {
  caddy validate --config "$caddyfile.new" --adapter caddyfile || true
  fps_stop_slot "$new"
  die "새 Caddyfile이 올바르지 않습니다"
}
[ -f "$caddyfile" ] && cp "$caddyfile" "$caddyfile.prev"
install -m 0644 -o caddy -g caddy "$caddyfile.new" "$caddyfile"
rm -f "$caddyfile.new"
if systemctl is-active --quiet caddy; then
  if ! systemctl reload caddy; then
    [ -f "$caddyfile.prev" ] && install -m 0644 -o caddy -g caddy "$caddyfile.prev" "$caddyfile" && systemctl reload caddy || true
    fps_stop_slot "$new"
    die "Caddy 다시 읽기 실패. 옛 설정으로 되돌렸습니다"
  fi
else
  systemctl enable --now caddy
fi
echo "$new" > "$FPS_STATE_DIR/active-slot"
for ((i = 1; i <= workers; i++)); do
  systemctl enable --quiet "fps-game@$new$i.service"
done
systemctl start fps-metrics.timer
log "Caddy가 슬롯 $new를 가리킵니다"

# 8) 옛 슬롯 비우기: 진행 중인 방이 끝나면(접속 0) 멈추고, 최대 FPS_DRAIN_MAX_SECONDS 뒤에는 남은 것도 멈춘다
if [ -n "$old" ]; then
  fps_disable_slot "$old"
  systemd-run --unit "fps-drain-$old" --collect --quiet --description "Drain game slot $old" "$FPS_LIB_DIR/drain.sh" "$old"
  log "옛 슬롯 $old 비우기 시작(journalctl -u fps-drain-$old 로 확인)"
fi

# 9) 오래된 릴리스 정리: 두 슬롯이 쓰는 것과 최근 5개는 남긴다
keep_a=$(fps_slot_value a FPS_RELEASE)
keep_b=$(fps_slot_value b FPS_RELEASE)
{ ls -1dt /opt/fps/releases/*/ 2> /dev/null || true; } | sed 's#/$##' | tail -n +6 | while read -r dir; do
  if [ "$dir" != "$keep_a" ] && [ "$dir" != "$keep_b" ]; then rm -rf "$dir"; fi
done || true

log "완료: $ref ($sha), 슬롯 $new, 프로세스 $workers개"
