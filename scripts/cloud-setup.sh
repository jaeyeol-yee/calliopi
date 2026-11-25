#!/bin/bash
# Claude Code cloud environment setup script for calliopi.
#
# Not run from the repository: paste this file into the environment's "Setup script" field at
# claude.ai/code (or "Choose file"). It runs as root on Ubuntu 24.04 before Claude Code starts,
# and the result is cached as a filesystem snapshot when it finishes within about five minutes.
# The repository's own dependencies (npm ci) are installed by scripts/cloud-install.sh, a
# SessionStart hook. See docs/cloud.md.
#
# Must exit 0 (a failure stops the session from starting), so every step is best effort and the
# hook or `npm run check` reports what is still missing.
export DEBIAN_FRONTEND=noninteractive

# CLIs the tests use that the base image lacks (it has git, gh, ripgrep, vim, tmux), and the
# toolchain node-pty compiles with on Linux (no Linux prebuilds in node-pty 1.1.0).
apt-get update -qq && apt-get install -y -qq --no-install-recommends fzf less build-essential python3 || true

# Node >= 22.18 runs the .ts sources directly. nodejs.org is not on the default allowlist, so when
# the image's Node 22 is older, take a newer one from the npm registry (node-linux-<arch>, which
# ships bin/node and the headers) and swap it into the installed prefix: PATH and npm stay as they
# are, and the headers match the binary for node-gyp.
node_ok() { node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; }
NODE_PREFIX="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
if ! node_ok; then
  arch="$(uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')"
  tmp="$(mktemp -d)"
  if (cd "$tmp" && npm pack -q "node-linux-$arch@22" >/dev/null) && tar -xzf "$tmp"/node-linux-*.tgz -C "$tmp"; then
    cp "$tmp/package/bin/node" "$NODE_PREFIX/bin/node.new" && mv "$NODE_PREFIX/bin/node.new" "$NODE_PREFIX/bin/node"
    rm -rf "$NODE_PREFIX/include/node" && cp -r "$tmp/package/include/node" "$NODE_PREFIX/include/node"
  fi
  rm -rf "$tmp"
  hash -r
fi
node_ok || echo "cloud-setup: Node $(node -v) is older than 22.18" >&2
# node-gyp needs the headers; scripts/cloud-install.sh points it at them (npm_config_nodedir).
[ -f "$NODE_PREFIX/include/node/node.h" ] || echo "cloud-setup: no Node headers under $NODE_PREFIX/include" >&2

# Optional: demo recording (VHS). Heavy, and may push setup past the five-minute cache limit;
# GIFs are recorded by the GitHub Actions demo workflow instead. Uncomment to record in the cloud.
# apt-get install -y -qq ttyd ffmpeg fd-find fonts-noto-cjk && ln -sf "$(command -v fdfind)" /usr/local/bin/fd
# url=$(curl -fsSL https://api.github.com/repos/charmbracelet/vhs/releases/latest | grep -o 'https://[^"]*vhs_[^"]*_amd64\.deb' | head -1)
# curl -fsSL -o /tmp/vhs.deb "$url" && dpkg -i /tmp/vhs.deb
# echo 'export DEMO_FONT_FAMILY="Noto Sans Mono CJK KR"' > /etc/profile.d/calliopi-demo.sh

exit 0
