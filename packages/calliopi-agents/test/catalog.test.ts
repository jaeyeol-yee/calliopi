import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_DIR, loadCatalog } from '#lib/catalog.ts';

const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliopi-agents-catalog-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('catalog: built-ins, then user, then project; problems are reported, not thrown', t => {
  const user = tmp(t), project = tmp(t);
  fs.mkdirSync(path.join(user, 'agents'));
  fs.mkdirSync(path.join(project, '.pi', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(user, 'agents', 'scout.md'), '---\ndescription: My scout\nmodel: a/b\n---\nMine.\n');
  fs.writeFileSync(path.join(project, '.pi', 'agents', 'broken.md'), '---\nmodel: x\n---\n');
  const { roles, problems } = loadCatalog(project, [BUILTIN_DIR, path.join(user, 'agents'), path.join(project, '.pi', 'agents')]);
  assert.deepEqual([...roles.keys()].sort(), ['reviewer', 'scout']);
  assert.equal(roles.get('scout')!.description, 'My scout');
  assert.equal(roles.get('reviewer')!.disallowedTools.join(','), 'edit,write');
  assert.ok(problems.some(p => /broken\.md: description이 없습니다/.test(p)));
  assert.ok(problems.some(p => /scout: .*가 .*scout\.md를 대신합니다/.test(p)));
});
