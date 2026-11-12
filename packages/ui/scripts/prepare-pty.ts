// node-pty 1.1.0 ships its Unix prebuilt spawn-helper without executable bits.
// Repair only the helper shipped with this dependency, during npm install.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/${process.platform}-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const helper = path.join(root, relative);
    if (fs.existsSync(helper)) fs.chmodSync(helper, fs.statSync(helper).mode | 0o111);
  }
}
