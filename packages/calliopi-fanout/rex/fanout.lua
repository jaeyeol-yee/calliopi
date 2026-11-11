-- fanout.lua — rex layer for the Cursor Cloud fan-out tracker.
--
-- Thin by design: it only (1) starts the multiplexer-agnostic tracker detached,
-- (2) places panes, and (3) reacts to `terminal.child_exited` events. All state
-- is read from the tracker's registry through `tracker.mjs ... --json`; this
-- script never talks to the Cursor API and never sees the API key.
--
--   rex do rex/fanout.lua tracker=/abs/bin/tracker.mjs dir=/abs/.cursor-fanout node=/abs/node
--        [daemon=lua|none] [panes=true|false] [listen=true|false]
--        [zoom_failures=true] [stop_when_done=false] [cols=3] [max_panes=9]
--
-- Why the daemon is started here: `rex.exec.start` runs where `rex do` runs and
-- inherits that environment (CURSOR_API_KEY included). Terminal panes created by
-- the server do NOT inherit the caller's environment.

local A = rex.args or {}
local TRACKER = A.tracker or error("tracker=/abs/path/to/bin/tracker.mjs is required", 0)
local DIR = A.dir or error("dir=/abs/path/to/state-dir is required", 0)
local NODE = A.node or "node"
local CWD = A.cwd
local function flag(v, default) if v == nil then return default end return v == true or v == "true" end
local DAEMON = A.daemon or "lua"
local PANES = flag(A.panes, true)
local LISTEN = flag(A.listen, true)
local ZOOM = flag(A.zoom_failures, true)
local STOP_WHEN_DONE = flag(A.stop_when_done, false)
local COLS = tonumber(A.cols) or 3
local MAX_PANES = tonumber(A.max_panes) or 9
local SHELL = "com.superlogical.terminal.shell"
local ICON = { CREATING = "…", RUNNING = "▶", WAITING_FOR_BACKGROUND_WORK = "⏳",
  FINISHED = "✓", ERROR = "✗", CANCELLED = "⊘", EXPIRED = "⌛", MISSING = "?" }
local TERMINAL = { FINISHED = true, ERROR = true, CANCELLED = true, EXPIRED = true }

-- ---------------------------------------------------------------- tracker I/O
local function T(args)
  local argv = { NODE, TRACKER, "--dir", DIR }
  for _, a in ipairs(args) do argv[#argv + 1] = a end
  local r, err = rex.exec(argv, { cwd = CWD, timeout = 30 })
  if r == nil then return nil, err end
  if not r.ok then return nil, (r.stderr ~= "" and r.stderr or ("exit " .. tostring(r.code))) end
  if r.stdout == "" then return {} end
  return rex.json.decode(r.stdout)
end

local function cmd(...)
  local argv = { NODE, TRACKER, "--dir", DIR }
  for _, a in ipairs({ ... }) do argv[#argv + 1] = a end
  return argv
end

local function alive(block_id)
  if not block_id then return false end
  local d = rex.session.describe_block{ block_id = block_id }
  return d ~= nil
end

local function term_node(label, command)
  return { block = { flavor = SHELL, label = label,
    -- default (login) shell on purpose: with shell="none" this rex build reported
    -- exit_code 0 for failing commands in terminal.child_exited.
    options = { command = command, cwd = CWD, exit = { on_completion = false } } } }
end

-- n nodes → nested equal splits (ratio is the share of `before`)
local function chain(nodes, direction)
  if #nodes == 1 then return nodes[1] end
  local rest = {}
  for i = 2, #nodes do rest[#rest + 1] = nodes[i] end
  return { split = { direction = direction, ratio = 1 / #nodes, before = nodes[1], after = chain(rest, direction) } }
end

local function grid(nodes)
  local rows, row = {}, {}
  for _, n in ipairs(nodes) do
    row[#row + 1] = n
    if #row == COLS then rows[#rows + 1] = chain(row, "horizontal"); row = {} end
  end
  if #row > 0 then rows[#rows + 1] = chain(row, "horizontal") end
  return chain(rows, "vertical")
end

-- ------------------------------------------------------------------- daemon
local function ensure_daemon()
  local st = T{ "daemon-status", "--json" }
  if st and st.running then rex.log("info", "tracker already running pid " .. tostring(st.pid)); return end
  if DAEMON ~= "lua" then return end
  local h, err = rex.exec.start(cmd("watch", "--log", DIR .. "/tracker.log", "--quiet"), {
    cwd = CWD, detach = true, stdout = false, stderr = false, -- tracker writes its own log
  })
  if h == nil then error("could not start tracker: " .. tostring(err), 0) end
  rex.sleep(0.5)
  local after = T{ "daemon-status", "--json" }
  rex.log("info", string.format("tracker detached pid %s (running=%s)", tostring(h.pid), tostring(after and after.running)))
end

-- -------------------------------------------------------------------- panes
local function status() return T{ "status", "--json" } or { agents = {}, panes = {} } end

local function ensure_dashboard(st)
  local d = st.panes and st.panes.dashboard
  if d and alive(d.blockId) then return d.blockId end
  local w, err = rex.session.new_window{
    window_label = "cursor-fanout", focus = false,
    layout = term_node("dashboard", { "tail", "-n", "200", "-F", DIR .. "/cursor-cloud-dashboard.txt" }),
  }
  if w == nil then error("dashboard: " .. tostring(err), 0) end
  local id = w.block_ids[1]
  T{ "pane", "--role", "dashboard", "--block", id, "--session", rex.session_id }
  return id
end

local function ensure_agent_panes(st, dashboard)
  local want, anchor, live = {}, nil, 0
  for _, a in ipairs(st.agents or {}) do
    if a.pane and alive(a.pane.blockId) then live = live + 1; anchor = a.pane.blockId
    elseif (a.phase == "created" or a.phase == "imported") and not a.missing then want[#want + 1] = a end
  end
  local room = MAX_PANES - live
  if room <= 0 or #want == 0 then return end
  while #want > room do table.remove(want) end

  local nodes = {}
  for i, a in ipairs(want) do
    nodes[i] = term_node((ICON[a.status] or "·") .. " " .. (a.label or a.agentId), cmd("follow", a.agentId))
  end
  -- First batch: grid under the dashboard. Later additions: beside the last agent pane.
  local req
  if anchor then
    req = { anchor_id = anchor, direction = "horizontal", side = "after", focus = false, layout = chain(nodes, "horizontal") }
  else
    req = { anchor_id = dashboard, direction = "vertical", side = "after", ratio = 0.35, focus = false, layout = grid(nodes) }
  end
  local s, err = rex.session.new_split(req) -- atomic: all panes or none
  if s == nil then rex.log("warn", "agent panes: " .. tostring(err)); return end
  for i, a in ipairs(want) do
    T{ "pane", a.agentId, "--block", s.block_ids[i], "--session", rex.session_id }
  end
  rex.log("info", string.format("opened %d agent pane(s)", #want))
end

-- ---------------------------------------------------------------- reactions
local reported_total, report_block = 0, nil

local function refresh(st)
  st = st or status()
  local c, total, done = {}, 0, 0
  for _, a in ipairs(st.agents or {}) do
    local s = a.missing and "MISSING" or a.status or a.phase
    c[s] = (c[s] or 0) + 1
    total = total + 1
    if TERMINAL[s] or a.missing or a.phase == "create_failed" then done = done + 1 end
  end
  local parts = {}
  for s, n in pairs(c) do parts[#parts + 1] = (ICON[s] or s) .. n end
  table.sort(parts)
  local d = st.panes and st.panes.dashboard
  if d and d.blockId then
    rex.session.set_block_label{ block_id = d.blockId, label = "dashboard " .. table.concat(parts, " ") }
  end
  return total, done, st
end

local function maybe_report(st)
  local total, done = refresh(st)
  -- Re-report when agents were added (`fanout.sh add`) after an earlier report.
  if total == 0 or done < total or total <= reported_total then return false end
  reported_total = total
  local rep = T{ "report", "--out", DIR .. "/report.md", "--json" }
  local d = st and st.panes and st.panes.dashboard
  if rep and d and alive(d.blockId) then
    if alive(report_block) then rex.call("block.close", { block_id = report_block }) end
    local s = rex.session.new_split{ anchor_id = d.blockId, direction = "horizontal", side = "after", ratio = 0.5, focus = false,
      layout = term_node("report", { "cat", DIR .. "/report.md" }) }
    report_block = s and s.block_ids[1]
    if report_block then T{ "pane", "--role", "report", "--block", report_block, "--session", rex.session_id } end
  end
  rex.log("info", string.format("all %d agent(s) terminal · report %s/report.md", total, DIR))
  return true
end

local function on_exit(ctx, ev)
  local info = T{ "show", "--block", ctx.block_id, "--json" }
  if not info then return end
  if info.role == "watch" then
    rex.log("warn", "tracker pane exited with " .. tostring(ev.exit_code))
    if ev.exit_code ~= 0 then rex.session.zoom_block{ block_id = ctx.block_id, zoom = true } end
    return
  end
  if not info.agentId then return end -- not one of ours

  -- Registry is the source of truth; the exit code only tells us *that* it ended.
  local st = info.missing and "MISSING" or info.status or "?"
  local ok = st == "FINISHED" and ev.exit_code == 0
  local pr = (info.branches and info.branches[1] and info.branches[1].prUrl) and " PR" or ""
  rex.session.set_block_label{ block_id = ctx.block_id, label = (ICON[st] or "·") .. " " .. (info.label or "") .. pr }
  rex.log(ok and "info" or "warn", string.format("%s %s → %s (exit %s)", info.label or "", info.agentId, st, tostring(ev.exit_code)))
  if not ok and ZOOM then rex.session.zoom_block{ block_id = ctx.block_id, zoom = true } end
  if maybe_report(status()) and STOP_WHEN_DONE then rex.stop(0) end
end

-- --------------------------------------------------------------------- main
ensure_daemon()
local st = status()
if PANES then
  local dash = ensure_dashboard(st)
  ensure_agent_panes(status(), dash)
end
refresh()

if LISTEN then
  rex.on("terminal.child_exited", on_exit)
  rex.on("block_closed", function(ctx, ev)
    local info = T{ "show", "--block", ev.block_id, "--json" }
    if info and (info.agentId or info.role) then T{ "pane", "--clear", ev.block_id } end
  end)
  rex.log("info", "listening for terminal.child_exited (Ctrl-C to stop; tracker keeps running)")
end
