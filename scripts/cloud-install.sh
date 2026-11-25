#!/bin/bash
# SessionStart hook (.claude/settings.json): install the repository's dependencies in Claude Code
# cloud sessions. Does nothing locally. Skips `npm ci` while its inputs are unchanged since the
# last successful install, so resumed sessions start fast. See docs/cloud.md.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/..}" || exit 1

# Everything npm ci reads: workspace manifests and the ui postinstall script included.
inputs=(scripts/cloud-install.sh package.json package-lock.json packages/*/package.json packages/ui/scripts/prepare-pty.ts)
hashes=node_modules/.cloud-install.sha256

# node-gyp (node-pty has no Linux prebuilds) downloads Node headers from nodejs.org, which the cloud
# allowlist blocks; the installed Node ships them, so point node-gyp there.
node_prefix="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
[ -f "$node_prefix/include/node/node.h" ] && export npm_config_nodedir="$node_prefix"

if ! sha256sum --check --status "$hashes" 2>/dev/null; then
  rm -f "$hashes" # a failed install runs again next session
  if npm ci --no-audit --no-fund; then
    sha256sum "${inputs[@]}" > "$hashes" || rm -f "$hashes"
  else
    echo "cloud-install: npm ci failed; run it again to see the error (see docs/cloud.md)" >&2
  fi
fi
exit 0
