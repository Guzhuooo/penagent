#!/usr/bin/env bash
# Host-side penagent remote control over adb (Y02 / firmware 4.9.7).
# Y02 calibration: LOGICAL 936 x 280, origin top-left; default map c.
# Evidence: DEVICE_PROBING.md section 2. Recalibrate for other profiles.
# App identity defaults to app/package.json; PEN_APPID explicitly overrides it.
#   tools/remote/pen.sh tap X Y
#   tools/remote/pen.sh swipe X1 Y1 X2 Y2 [ms]
#   tools/remote/pen.sh shot [out.png]        # screenshot (video layer is not captured)
#   tools/remote/pen.sh log [N] [regex]       # tail of the pen log
#   tools/remote/pen.sh start [page]          # launch the app
#   tools/remote/pen.sh key KEYCODE           # miniapp_cli injectKey
# PEN_MAP picks the logical->raw touch mapping (calibrated per device): a|b|c|d
set -euo pipefail
export MSYS_NO_PATHCONV=1

HERE="$(cd "$(dirname "$0")" && pwd)"
# Resolve identity only for start; screenshots/touch do not require host Node.
app_id() {
  if [ -n "${PEN_APPID:-}" ]; then
    printf '%s\n' "$PEN_APPID"
    return
  fi
  local package_json="$HERE/../../app/package.json"
  if command -v cygpath >/dev/null 2>&1; then package_json="$(cygpath -w "$package_json")"; fi
  node -e 'const p = require(process.argv[1]); if (typeof p.appid !== "string" || !p.appid.trim()) throw new Error("package.json appid missing"); process.stdout.write(p.appid);' "$package_json"
}
MAP="${PEN_MAP:-c}"
LW=936; LH=280

ensure_script() {
  if [ "${PEN_REPUSH:-0}" = 1 ] || ! adb shell 'test -f /tmp/pentap.pl && echo yes' | grep -q yes; then
    local src="$HERE/pentap.pl"
    if command -v cygpath >/dev/null 2>&1; then src="$(cygpath -w "$src")"; fi
    adb push "$src" /tmp/pentap.pl >/dev/null
  fi
}

# logical (lx, ly) -> raw panel (rx in 0..279, ry in 0..935)
to_raw() {
  local lx=$1 ly=$2 rx ry
  case "$MAP" in
    a) rx=$ly;              ry=$lx ;;
    b) rx=$((LH - 1 - ly)); ry=$lx ;;
    c) rx=$ly;              ry=$((LW - 1 - lx)) ;;
    d) rx=$((LH - 1 - ly)); ry=$((LW - 1 - lx)) ;;
    *) echo "bad PEN_MAP=$MAP" >&2; exit 2 ;;
  esac
  echo "$rx $ry"
}

perl_run() { adb shell "LC_ALL=C LANG=C perl /tmp/pentap.pl $* 2>&1 | grep -v -i locale"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  tap)
    ensure_script
    read -r rx ry < <(to_raw "$1" "$2")
    perl_run tap "$rx" "$ry" "${3:-60}" ;;
  swipe)
    ensure_script
    read -r ax ay < <(to_raw "$1" "$2")
    read -r bx by < <(to_raw "$3" "$4")
    perl_run swipe "$ax" "$ay" "$bx" "$by" "${5:-300}" ;;
  shot)
    out="${1:-artifacts/shot.png}"
    mkdir -p "$(dirname "$out")"
    adb shell miniapp_cli capture /tmp/pen_shot.png >/dev/null
    adb pull /tmp/pen_shot.png "$out" >/dev/null
    echo "$out" ;;
  log)
    n="${1:-200}"; re="${2:-.}"
    adb shell "L=\$(ls -t /userdata/applog/DictPen_*.log | head -n 1); tail -n $n \"\$L\" | grep -E '$re' | cut -c1-220" ;;
  start)
    APPID="$(app_id)"
    adb shell miniapp_cli start "$APPID" "${1:-index}" ;;
  key)
    adb shell miniapp_cli injectKey "$1" ;;
  *)
    printf '%s\n' 'Usage: pen.sh tap X Y | swipe X1 Y1 X2 Y2 [ms] | shot [out.png]' \
      '              log [N] [regex] | start [page=index] | key KEYCODE' \
      'Defaults: app/package.json appid; Y02 936x280, PEN_MAP=c.' >&2
    exit 1 ;;
esac
