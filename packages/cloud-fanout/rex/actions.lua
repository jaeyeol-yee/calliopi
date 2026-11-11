-- actions.lua — `rex do fanout ...` one-liners (custom actions).
--
-- Install: in ~/.config/rex/init.lua add
--     CALLIOPI_FANOUT = { node = "/abs/path/to/node", rex = "/abs/path/to/rex" }  -- optional
--     dofile("/abs/path/to/calliopi/packages/cloud-fanout/rex/actions.lua")
-- then `rex config reload`. Try without installing:
--     rex do rex/actions.lua --action fanout spec=fanout.json
--
-- Actions defined in init.lua run inside the Rex *server*: they see the server's environment,
-- not your shell's. Use the stored login (~/.cursor/sdk/auth.json) there, or run the
-- script form above (runs where the CLI runs, with your env). Actions also have a 30 s
-- budget, so anything long (creates, the daemon, the event reactor) is started detached.

local src = debug.getinfo(1, "S").source:gsub("^@", "")
local HERE = src:match("^(.*)/[^/]*$") or "."
local PKG = HERE:match("^(.*)/[^/]*$") or ".."
local O = rawget(_G, "CALLIOPI_FANOUT") or {}
local NODE = O.node or "node"
local REX = O.rex or "rex"
local TRACKER = PKG .. "/bin/tracker.mjs"
local LUA = HERE .. "/fanout.lua"

local function block_cwd(ctx)
  if not ctx.block_id then return nil end
  local r = rex.block.call("com.superlogical.terminal", "pwd", { block_id = ctx.block_id })
  local url = r and (r.pwd or r.url)
  if type(url) ~= "string" then return nil end
  local path = url:gsub("^file://[^/]*", "")
  return (path:gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end))
end

local function resolve(ctx, args)
  local cwd = args.cwd or block_cwd(ctx) or os.getenv("PWD") or os.getenv("HOME")
  local dir = args.dir or (cwd .. "/.cursor-fanout")
  if dir:sub(1, 1) ~= "/" then dir = cwd .. "/" .. dir end
  local spec = args.spec
  if spec and spec:sub(1, 1) ~= "/" then spec = cwd .. "/" .. spec end
  return cwd, dir, spec
end

local function T(dir, cwd, ...)
  local argv = { NODE, TRACKER, "--dir", dir }
  for _, a in ipairs({ ... }) do argv[#argv + 1] = a end
  local r, err = rex.exec(argv, { cwd = cwd, timeout = 20 })
  if r == nil then error(err, 0) end
  if not r.ok and r.code ~= 2 then error(r.stderr ~= "" and r.stderr or ("tracker exit " .. r.code), 0) end
  return r.stdout ~= "" and rex.json.decode(r.stdout) or {}
end

local function reactor_argv(ctx, dir, cwd, daemon)
  return { REX, "do", "-s", ctx.session_id, LUA, "tracker=" .. TRACKER, "dir=" .. dir, "node=" .. NODE,
    "cwd=" .. cwd, "daemon=" .. daemon, "panes=true", "listen=true" }
end

rex.action{
  name = "fanout",
  title = "Cursor Cloud: Fan Out Agents…",
  category = "Cursor Cloud",
  keywords = "cursor cloud agents fanout parallel",
  description = "Plan (default) or launch (yes=true) N Cursor Cloud Agents from a spec, then open tracker panes.",
  args = { spec = "string", yes = "boolean?", dir = "string?", cwd = "string?" },
  run = function(ctx, args)
    local cwd, dir, spec = resolve(ctx, args)
    if not args.yes then
      -- Free and local: shows what *would* be created. Creating agents is paid → explicit yes=true.
      local plan = T(dir, cwd, "launch", "--spec", spec, "--json")
      plan.next = plan.toCreate > 0 and "re-run with yes=true to create these agents" or "nothing to create"
      return plan
    end
    -- create → then the Lua reactor (which detaches the daemon and opens panes). Args are
    -- passed positionally to sh, so nothing is re-quoted; nothing secret is on argv.
    local script = [[mkdir -p "$3" && chmod 700 "$3" &&
      "$1" "$2" --dir "$3" launch --spec "$4" --yes >>"$3/launch.log" 2>&1; rc=$?
      [ $rc -le 1 ] || exit $rc
      shift 4; exec "$@"]]
    local argv = { "/bin/sh", "-c", script, "sh", NODE, TRACKER, dir, spec }
    for _, a in ipairs(reactor_argv(ctx, dir, cwd, "lua")) do argv[#argv + 1] = a end
    local h, err = rex.exec.start(argv, { cwd = cwd, detach = true, stdout = false, stderr = false })
    if h == nil then error(err, 0) end
    return { started = true, pid = h.pid, dir = dir, launch_log = dir .. "/launch.log" }
  end,
}

rex.action{
  name = "fanout_up",
  title = "Cursor Cloud: Reattach Fan-out Panes",
  category = "Cursor Cloud",
  args = { dir = "string?", cwd = "string?" },
  run = function(ctx, args)
    local cwd, dir = resolve(ctx, args)
    local h, err = rex.exec.start(reactor_argv(ctx, dir, cwd, "lua"), { cwd = cwd, detach = true, stdout = false, stderr = false })
    if h == nil then error(err, 0) end
    return { started = true, pid = h.pid, dir = dir }
  end,
}

rex.action{
  name = "fanout_status",
  title = "Cursor Cloud: Fan-out Status",
  category = "Cursor Cloud",
  args = { dir = "string?", cwd = "string?" },
  run = function(ctx, args)
    local cwd, dir = resolve(ctx, args)
    local st = T(dir, cwd, "status", "--json")
    return { counts = st.counts, daemon = st.daemon, agents = #(st.agents or {}) }
  end,
}

rex.action{
  name = "fanout_report",
  title = "Cursor Cloud: Fan-out Report",
  category = "Cursor Cloud",
  args = { dir = "string?", cwd = "string?", batch = "string?" },
  run = function(ctx, args)
    local cwd, dir = resolve(ctx, args)
    local extra = args.batch and { "--batch", args.batch } or {}
    local up = table.unpack or unpack -- Lua 5.1
    local rep = T(dir, cwd, "report", "--out", dir .. "/report.md", "--json", up(extra))
    rex.session.new_window{
      window_label = "fanout-report", focus = true,
      layout = { block = { flavor = "com.superlogical.terminal.shell", label = "report",
        options = { command = { "less", "-R", dir .. "/report.md" }, cwd = cwd } } },
    }
    return { agents = rep.agents, done = rep.done, tokens = rep.tokens and rep.tokens.totalTokens, prs = #(rep.prs or {}) }
  end,
}
