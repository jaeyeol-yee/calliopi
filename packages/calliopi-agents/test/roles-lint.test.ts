import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintRole } from '@calliopi/core/agents';
import { BUILTIN_DIR, loadCatalog } from '#lib/catalog.ts';

test('the built-in roles pass the role lint', () => {
  const { roles, problems } = loadCatalog(process.cwd(), [BUILTIN_DIR], [true]);
  assert.deepEqual(problems, []);
  assert.ok(roles.size >= 2);
  assert.deepEqual([...roles.values()].flatMap(lintRole), []);
});
