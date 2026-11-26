// Subagents. In a child Pi (started with CALLIOPI_AGENT_DIR) this installs the child side: the
// finish tool, the contract, the inbox and the result. The delegating side comes in the same file.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installChild } from '#lib/child.ts';
import { AGENT_DIR_ENV } from '#lib/launch.ts';

export default function (pi: ExtensionAPI) {
  const dir = process.env[AGENT_DIR_ENV];
  if (dir) installChild(pi, dir);
}
