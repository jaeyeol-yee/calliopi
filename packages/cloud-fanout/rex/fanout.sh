#!/usr/bin/env bash
# fanout.sh — rex CLI layer for the Cursor Cloud fan-out tracker.
# Only places panes and wires the event reactor; all state lives in the tracker registry.
#
#   fanout.sh launch SPEC.json [--yes]     plan (no --yes) or create + bring up panes
#   fanout.sh up                           (re)attach: daemon, watch pane, dashboard, agent panes, reactor
#   fanout.sh add AGENT_ID [RUN_ID] [LABEL]  track an existing agent and open its pane
#   fanout.sh watch                        watch pane only (split below this pane, 30%)
#   fanout.sh status | report | down
#
# env: CURSOR_FANOUT_DIR (default $PWD/.cursor-fanout), FANOUT_DAEMON=auto|pane|lua, NODE, REX
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG=$(dirname "$HERE")
TRACKER="$PKG/bin/tracker.mjs"
LUA="$HERE/fanout.lua"
NODE=${NODE:-$(command -v node)}
REX=${REX:-$(command -v rex)}
DIR=${CURSOR_FANOUT_DIR:-$PWD/.cursor-fanout}
mkdir -p "$DIR" && chmod 700 "$DIR"
DIR=$(cd "$DIR" && pwd)
DAEMON_MODE=${FANOUT_DAEMON:-auto}

die() { printf 'fanout: %s\n' "$*" >&2; exit 1; }
T() { "$NODE" "$TRACKER" --dir "$DIR" "$@"; }
# jget PATH < json   — tiny JSON getter (node is a hard dependency anyway; jq is not)
jget() {
  "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s);
    for(const k of process.argv[1].split(".").filter(Boolean))v=v==null?v:v[/^\d+$/.test(k)?+k:k];
    process.stdout.write(v==null?"":typeof v==="object"?JSON.stringify(v):String(v))})' "$1"
}

# ---- rex environment (REX_SESSION / REX_BLOCK are set inside rex terminals)
if [[ -z "${REX_SESSION:-}" ]]; then
  REX_SESSION=$("$REX" whoami --json 2>/dev/null | jget session_id) || true
fi
S=${REX_SESSION:-}
ANCHOR=${REX_BLOCK:-}

need_rex() { [[ -n "$S" ]] || die "not inside a rex terminal (REX_SESSION unset; try: rex whoami --json)"; }
alive() { [[ -n "${1:-}" ]] && "$REX" block inspect -s "$S" "$1" --json >/dev/null 2>&1; }
pane_of_role() { T status --json | jget "panes.$1.blockId"; }
daemon_running() { [[ "$(T daemon-status --json | jget running)" == "true" ]]; }

# Panes do not inherit this shell's env, so a pane-hosted tracker only works with the
# stored login (~/.cursor/sdk/auth.json). An env-only key needs the Lua-detached daemon.
pick_daemon_mode() {
  case "$DAEMON_MODE" in
    pane|lua) echo "$DAEMON_MODE" ;;
    auto) if [[ -f "${CURSOR_SDK_AUTH_FILE:-$HOME/.cursor/sdk/auth.json}" && -z "${CURSOR_API_BASE:-}" ]]; then echo pane; else echo lua; fi ;;
    *) die "FANOUT_DAEMON must be auto|pane|lua" ;;
  esac
}

# ---- 1) tracker watch pane: split below the current pane, 30%, keep focus
cmd_watch() {
  need_rex
  local mode; mode=$(pick_daemon_mode)
  local w; w=$(pane_of_role watch)
  if alive "$w"; then echo "watch pane: $w"; return; fi
  local out
  if [[ "$mode" == pane ]] && ! daemon_running; then
    out=$("$REX" split -s "$S" ${ANCHOR:+-b "$ANCHOR"} --split=below --ratio 30 --focus=false --keep-open \
      --label fanout-tracker -c "$PWD" --json -- "$NODE" "$TRACKER" --dir "$DIR" watch --log "$DIR/tracker.log")
  else
    # daemon runs detached (Lua); the pane just follows its log
    [[ "$mode" == lua ]] && ! daemon_running && \
      "$REX" "do" -s "$S" "$LUA" tracker="$TRACKER" dir="$DIR" node="$NODE" cwd="$PWD" daemon=lua panes=false listen=false >/dev/null
    touch "$DIR/tracker.log" && chmod 600 "$DIR/tracker.log"
    out=$("$REX" split -s "$S" ${ANCHOR:+-b "$ANCHOR"} --split=below --ratio 30 --focus=false \
      --label fanout-tracker-log -c "$PWD" --json -- tail -n 100 -F "$DIR/tracker.log")
  fi
  w=$(jget block_ids.0 <<<"$out")
  T pane --role watch --block "$w" --session "$S" >/dev/null
  echo "watch pane: $w ($mode)"
}

# ---- 2) dashboard tab
cmd_dashboard() {
  need_rex
  local d; d=$(pane_of_role dashboard)
  if alive "$d"; then echo "dashboard: $d"; return; fi
  touch "$DIR/cursor-cloud-dashboard.txt" && chmod 600 "$DIR/cursor-cloud-dashboard.txt"
  local out
  # tail -F (follow by name): the tracker truncates the rolling file when it gets large.
  out=$("$REX" run -s "$S" --label dashboard --focus=false -c "$PWD" --json -- \
    tail -n 200 -F "$DIR/cursor-cloud-dashboard.txt")
  d=$(jget block_ids.0 <<<"$out")
  T pane --role dashboard --block "$d" --session "$S" >/dev/null
  echo "dashboard: $d (window $(jget window_id <<<"$out"))"
}

# ---- 3) agent panes via the Server API, version-checked; CLI fallback
api_has_new_split() {
  # capture first: `grep -q` closing the pipe early + pipefail would report SIGPIPE as failure
  local methods; methods=$("$REX" api list 2>/dev/null) || return 1
  grep -Eq '^session\.new_split[[:space:]]' <<<"$methods" || return 1
  "$REX" api describe session.new_split --json 2>/dev/null | "$NODE" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).input_schema?.properties||{};
    process.exit(["anchor_id","direction","side","layout"].every(k=>k in p)?0:1)})'
}

cmd_agent_panes() {
  need_rex
  local d; d=$(pane_of_role dashboard); alive "$d" || die "no dashboard pane (run: fanout.sh up)"
  # agents needing a pane: tracked, not missing, pane absent or dead. Lines: id<TAB>label<TAB>blockId
  local ids=() labels=() last="" a l b
  while IFS=$'\t' read -r a l b; do
    [[ -z "$a" ]] && continue
    if [[ -n "$b" ]] && alive "$b"; then last="$b"; continue; fi
    ids+=("$a"); labels+=("$l")
  done < <(T status --json | "$NODE" -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const a of JSON.parse(s).agents)
      if((a.phase==="created"||a.phase==="imported")&&!a.missing)
        console.log([a.agentId,(a.label||a.agentId).replace(/\s+/g," "),a.pane?.blockId||""].join("\t"))})')
  (( ${#ids[@]} )) || { echo "agent panes: up to date"; return; }
  local max=${FANOUT_MAX_PANES:-9}
  if (( ${#ids[@]} > max )); then ids=("${ids[@]:0:$max}"); labels=("${labels[@]:0:$max}"); fi

  if api_has_new_split; then
    # One atomic session.new_split carrying a grid of follow panes (all created or none).
    # First batch goes under the dashboard; later additions go beside the last live agent pane.
    local req="$DIR/layout.json" pairs=() i
    for i in "${!ids[@]}"; do pairs+=("${ids[$i]}" "${labels[$i]}"); done
    "$NODE" - "$NODE" "$TRACKER" "$DIR" "${last:-$d}" "${last:+beside}" "$PWD" "${FANOUT_COLS:-3}" "${pairs[@]}" >"$req" <<'JS'
const [node, tracker, dir, anchor, beside, cwd, cols, ...kv] = process.argv.slice(2);
const items = []; for (let i = 0; i < kv.length; i += 2) items.push({ id: kv[i], label: kv[i + 1] });
const leaf = ({ id, label }) => ({ block: { flavor: 'com.superlogical.terminal.shell', label: `· ${label}`.slice(0, 128),
  options: { command: [node, tracker, '--dir', dir, 'follow', id], cwd, exit: { on_completion: false } } } });
const chain = (n, d) => n.length === 1 ? n[0] : { split: { direction: d, ratio: 1 / n.length, before: n[0], after: chain(n.slice(1), d) } };
let layout;
if (beside) layout = chain(items.map(leaf), 'horizontal');
else { const rows = []; for (let i = 0; i < items.length; i += +cols) rows.push(chain(items.slice(i, i + +cols).map(leaf), 'horizontal')); layout = chain(rows, 'vertical'); }
process.stdout.write(JSON.stringify(beside
  ? { anchor_id: anchor, direction: 'horizontal', side: 'after', focus: false, layout }
  : { anchor_id: anchor, direction: 'vertical', side: 'after', ratio: 0.35, focus: false, layout }));
JS
    chmod 600 "$req"
    local out; out=$("$REX" api call -s "$S" session.new_split @"$req")
    for i in "${!ids[@]}"; do
      T pane "${ids[$i]}" --block "$(jget "block_ids.$i" <<<"$out")" --session "$S" >/dev/null
    done
    echo "agent panes: ${#ids[@]} via session.new_split"
  else
    local prev="${last:-$d}" dir out
    [[ -n "$last" ]] && dir=right || dir=below
    for i in "${!ids[@]}"; do
      out=$("$REX" split -s "$S" -b "$prev" --split=$dir --focus=false --keep-open \
        --label "· ${labels[$i]}" -c "$PWD" --json -- "$NODE" "$TRACKER" --dir "$DIR" follow "${ids[$i]}")
      b=$(jget block_ids.0 <<<"$out"); T pane "${ids[$i]}" --block "$b" --session "$S" >/dev/null
      prev="$b"; dir=right
    done
    echo "agent panes: ${#ids[@]} via rex split (API fallback)"
  fi
}

# ---- 4) event reactor: Lua, child_exited → label / zoom / report
cmd_reactor() {
  need_rex
  local r; r=$(pane_of_role events)
  if alive "$r"; then echo "reactor: $r"; return; fi
  local d; d=$(pane_of_role dashboard)
  local out; out=$("$REX" split -s "$S" ${d:+-b "$d"} --split=below --ratio 15 --focus=false --keep-open \
    --label fanout-events -c "$PWD" --json -- \
    "$REX" "do" -s "$S" "$LUA" tracker="$TRACKER" dir="$DIR" node="$NODE" cwd="$PWD" daemon=none panes=false listen=true)
  r=$(jget block_ids.0 <<<"$out")
  T pane --role events --block "$r" --session "$S" >/dev/null
  echo "reactor: $r"
}

cmd_up() { cmd_watch; cmd_dashboard; cmd_agent_panes; cmd_reactor; }

cmd_launch() {
  local spec=${1:-}; shift || true
  [[ -f "$spec" ]] || die "usage: fanout.sh launch SPEC.json [--yes]"
  if [[ " $* " != *" --yes "* ]]; then T launch --spec "$spec" "$@"; exit $?; fi
  local rc=0; T launch --spec "$spec" "$@" || rc=$?
  (( rc == 0 || rc == 1 )) || exit "$rc"   # 1 = partial failure: still bring up what exists
  local created; created=$(T status --json | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>
    console.log(JSON.parse(s).agents.filter(a=>a.phase==="created"||a.phase==="imported").length))')
  if (( created == 0 )); then echo "nothing to track; panes not opened"; exit "$rc"; fi
  [[ -n "$S" ]] && cmd_up
  exit "$rc"
}

cmd_add() {
  local id=${1:-} run=${2:-} label=${3:-}
  [[ "$id" == bc-* ]] || die "usage: fanout.sh add AGENT_ID [RUN_ID] [LABEL]"
  T add "$id" ${run:+--run "$run"} ${label:+--label "$label"}
  if [[ -n "$S" ]]; then
    alive "$(pane_of_role dashboard)" || cmd_dashboard
    daemon_running || cmd_watch
    cmd_agent_panes
    alive "$(pane_of_role events)" || cmd_reactor
  fi
}

cmd_down() {
  need_rex
  local b
  T stop   # first: closing the watch pane would SIGHUP it mid-write
  for role in events report dashboard watch; do
    b=$(pane_of_role "$role"); alive "$b" && "$REX" block close -s "$S" "$b" || true
  done
  while read -r b; do [[ -n "$b" ]] && alive "$b" && "$REX" block close -s "$S" "$b" || true; done \
    < <(T status --json | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const a of JSON.parse(s).agents)if(a.pane)console.log(a.pane.blockId)})')
  echo "panes closed, tracker stopped (agents keep running in Cursor; registry kept)"
}

sub=${1:-help}; shift || true
case "$sub" in
  launch) cmd_launch "$@" ;;
  up) cmd_up ;;
  add) cmd_add "$@" ;;
  watch) cmd_watch ;;
  dashboard) cmd_dashboard ;;
  panes) cmd_agent_panes ;;
  reactor) cmd_reactor ;;
  status) T status "$@" ;;
  report) need_rex; T report --out "$DIR/report.md" >/dev/null
          "$REX" window new -s "$S" Report --keep-open --focus=false -c "$PWD" --json -- cat "$DIR/report.md" | jget window_id; echo ;;
  down) cmd_down ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
