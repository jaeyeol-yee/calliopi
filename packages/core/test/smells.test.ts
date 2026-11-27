import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_STREAK_MIN, HARNESS_ENTRY, JUMP_TOKENS, REPEAT_MIN, RESTATE_MIN_CHARS, SMELL_KINDS, formatSmells, harnessLabel, sessionInfo, sessionSmells, shipsCommand, similarity, summarizeSmells, undoCommand, type SessionEntry, type SessionSmells } from '#lib/smells.ts';

let seq = 0;
const id = () => `e${++seq}`;
const user = (text = 'do it'): SessionEntry => ({ type: 'message', id: id(), message: { role: 'user', content: [{ type: 'text', text }] } });
const call = (name: string, args: unknown, callId = 'c') => ({ type: 'toolCall', id: callId, name, arguments: args });
/** An assistant message: its tool calls, the size of the prompt it was sent, and how it stopped. */
const assistant = (calls: unknown[] = [], prompt = 0, stopReason = calls.length ? 'toolUse' : 'stop', model = 'm1'): SessionEntry =>
  ({ type: 'message', id: id(), message: { role: 'assistant', provider: 'p', model, content: calls, stopReason, usage: prompt ? { input: 10, cacheRead: prompt - 10, cacheWrite: 0 } : undefined } });
const result = (toolName: string, isError = false, toolCallId = 'c'): SessionEntry => ({ type: 'message', id: id(), message: { role: 'toolResult', toolName, isError, toolCallId } });
const bash = (command: string, callId = 'c') => assistant([call('bash', { command, timeout: 10 }, callId)]);
const stamp = (sha: string, dirty = false): SessionEntry => ({ type: 'custom', id: id(), customType: HARNESS_ENTRY, data: { sha, dirty } });
const kinds = (entries: SessionEntry[]) => sessionSmells(entries).map(s => s.kind);

test('repeat: the same call REPEAT_MIN times in one run, counted once; other arguments or another run do not add up', () => {
  const grep = (pattern = 'x') => assistant([call('grep', { pattern })]);
  const under = [user(), ...Array.from({ length: REPEAT_MIN - 1 }, () => grep())];
  assert.deepEqual(kinds(under), []);
  const last = grep();
  const smells = sessionSmells([...under, grep('y'), grep(), last]);
  assert.deepEqual(smells.map(s => [s.kind, s.tool, s.detail, s.entry]), [['repeat', 'grep', `grep called ${REPEAT_MIN + 1} times with the same arguments`, last.id]]); // the entry is the last of them
  // split over two runs: neither reaches the minimum
  assert.deepEqual(kinds([user(), grep(), grep(), user(), grep(), grep()]), []);
  // the same tool with different arguments is not a repeat
  assert.deepEqual(kinds([user(), grep('a'), grep('b'), grep('c'), grep('d')]), []);
  // several identical calls in one message count too
  assert.deepEqual(kinds([user(), assistant(Array.from({ length: REPEAT_MIN }, () => call('read', { path: 'a' })))]), ['repeat']);
});

test('error-streak: errors in a row, ended by a success or by the user; the tools are named', () => {
  const errors = (n: number, tool = 'read') => Array.from({ length: n }, () => result(tool, true));
  assert.deepEqual(kinds([user(), ...errors(ERROR_STREAK_MIN - 1), result('read'), ...errors(ERROR_STREAK_MIN - 1)]), []);
  const streak = [...errors(ERROR_STREAK_MIN), result('bash', true)];
  const smells = sessionSmells([user(), ...streak, result('read'), result('read', true)]);
  assert.deepEqual(smells.map(s => [s.kind, s.tool, s.detail, s.entry]), [['error-streak', 'read', `${ERROR_STREAK_MIN + 1} tool errors in a row (read ${ERROR_STREAK_MIN}, bash 1)`, streak.at(-1)!.id]]);
  // a user message ends the run: errors before and after it are separate streaks
  assert.deepEqual(kinds([user(), ...errors(ERROR_STREAK_MIN - 1), user(), ...errors(ERROR_STREAK_MIN - 1)]), []);
  // assistant messages between the errors do not break the streak
  assert.deepEqual(kinds([user(), ...errors(1), assistant([call('read', { path: 'a' })]), ...errors(1), assistant([call('read', { path: 'b' })]), ...errors(ERROR_STREAK_MIN - 2)]), ['error-streak']);
});

test('interrupted: every reply the user aborted, and only those', () => {
  const aborted = assistant([], 0, 'aborted');
  assert.deepEqual(sessionSmells([user(), assistant([], 100), user(), aborted, user(), assistant([], 100, 'error')]).map(s => [s.kind, s.entry]), [['interrupted', aborted.id]]);
});

test('context-jump: the prompt grows by JUMP_TOKENS between two requests of one run, with the tools in between', () => {
  const big = assistant([], 5000 + JUMP_TOKENS);
  const smells = sessionSmells([user(), assistant([call('bash', {})], 5000), result('bash'), result('read'), result('bash'), big]);
  assert.deepEqual(smells.map(s => [s.kind, s.tool, s.detail, s.entry]), [['context-jump', 'bash', `prompt grew by ${JUMP_TOKENS} tokens after bash 2, read 1`, big.id]]);
  assert.deepEqual(kinds([user(), assistant([], 5000), result('bash'), assistant([], 5000 + JUMP_TOKENS - 1)]), []);
  // the first request of a run has no baseline, however long the user's message was
  assert.deepEqual(kinds([user(), assistant([], 5000), user(), assistant([], 5000 + 2 * JUMP_TOKENS)]), []);
  // a request without usage (aborted) neither jumps nor resets the baseline, and the tools before it are still named
  const afterGap = sessionSmells([user(), assistant([], 5000), result('read'), assistant([], 0, 'error'), assistant([], 5000 + JUMP_TOKENS)]);
  assert.deepEqual(afterGap.map(s => [s.kind, s.tool]), [['context-jump', 'read']]);
  // shrinking (a compaction) is not a jump
  assert.deepEqual(kinds([user(), assistant([], 5000 + JUMP_TOKENS), assistant([], 5000)]), []);
  assert.match(sessionSmells([user(), assistant([], 5000), assistant([], 5000 + JUMP_TOKENS)])[0]!.detail, /after no tool result$/);
});

test('sessionSmells: other entries are ignored, and no detail carries what was written', () => {
  const entries: SessionEntry[] = [
    { type: 'session', id: 's' }, { type: 'custom', id: id() }, { type: 'compaction', id: id() }, { type: 'message', id: id() },
    { type: 'message', id: id(), message: { role: 'bashExecution' } }, { type: 'message', id: id(), message: { role: 'system' } },
    user(), ...Array.from({ length: REPEAT_MIN }, () => assistant([call('bash', { command: 'SECRET=1 run' })])),
  ];
  const smells = sessionSmells(entries);
  assert.deepEqual(smells.map(s => s.kind), ['repeat']);
  assert.doesNotMatch(JSON.stringify(smells), /SECRET|do it/);
  assert.deepEqual(sessionSmells([]), []);
  // whatever a line of the file parsed to: not an object, no message, content that is not blocks
  const odd = [null, 3, 'x', [], { type: 'message', message: null }, { type: 'message', message: { role: 'assistant', content: 'text', usage: null } },
    { type: 'message', message: { role: 'assistant', content: [null, 1, { type: 'toolCall' }, { type: 'toolCall', name: 'a' }] } }, { type: 'message', message: { role: 'toolResult' } }] as unknown as SessionEntry[];
  assert.deepEqual(sessionSmells(odd), []);
  assert.equal(sessionInfo(odd).requests, 2);
  // fields of another type than Pi writes: nothing throws, no number is made of strings, and no such value reaches a detail or a label
  const evil = '/secret/path | x\ninjected';
  const wrong = [
    { type: 'session', id: { a: 1 }, cwd: 9, timestamp: 12345 }, user(),
    ...Array.from({ length: ERROR_STREAK_MIN }, () => ({ type: 'message', id: evil, message: { role: 'toolResult', toolName: { x: 1 }, isError: true } })),
    { type: 'message', message: { role: 'toolResult', toolName: evil, isError: true } },
    { type: 'message', message: { role: 'assistant', provider: evil, model: evil, content: [], usage: { input: '5000' } } },
    { type: 'message', message: { role: 'assistant', model: { m: 1 }, content: Array.from({ length: REPEAT_MIN }, () => ({ type: 'toolCall', id: 7, name: evil, arguments: 'x' })), usage: { input: '99999', cacheRead: -5, cacheWrite: Infinity } } },
  ] as unknown as SessionEntry[];
  const found = sessionSmells(wrong);
  assert.deepEqual(found.map(s => [s.kind, s.tool, s.entry]), [['error-streak', 'unknown', undefined], ['repeat', 'unknown', undefined]]);
  assert.deepEqual(sessionInfo(wrong), { id: 'unknown', cwd: '', startedAt: 0, model: 'unknown/unknown', runs: 1, requests: 2, outcome: 'other', harness: 'unrecorded' });
  assert.doesNotMatch(JSON.stringify(found) + formatSmells([{ info: sessionInfo(wrong), smells: found }]), /secret|injected/);
});

test('sessionInfo: the header, the model that answered most, runs and requests', () => {
  const entries = [{ type: 'session', id: 's-1', cwd: '/work/app', timestamp: '2026-11-20T05:42:59.590Z' }, user(), assistant([], 0, 'stop', 'a'), user(), assistant([], 0, 'stop', 'b'), assistant([], 0, 'stop', 'b')];
  assert.deepEqual(sessionInfo(entries), { id: 's-1', cwd: '/work/app', startedAt: Date.parse('2026-11-20T05:42:59.590Z'), model: 'p/b', runs: 2, requests: 3, outcome: 'other', harness: 'unrecorded' });
  assert.deepEqual(sessionInfo([{ type: 'session', id: 's-2', timestamp: 'not a date' }]), { id: 's-2', cwd: '', startedAt: 0, model: 'unknown', runs: 0, requests: 0, outcome: 'other', harness: 'unrecorded' });
  assert.equal(sessionInfo([]).id, 'unknown');
});

const session = (sid: string, model: string, startedAt: number, smells: SessionSmells['smells'], over: Partial<SessionSmells['info']> = {}): SessionSmells =>
  ({ info: { id: sid, cwd: '/w', startedAt, model, runs: 1, requests: 1, outcome: 'other', harness: 'unrecorded', ...over }, smells });

test('summarizeSmells and formatSmells: sessions with a hit, hits, the common tool, by model, latest hits first', () => {
  const sessions = [
    session('s-1', 'p/a', Date.UTC(2026, 10, 1), [{ kind: 'repeat', tool: 'grep', entry: 'e1', detail: 'grep called 3 times with the same arguments' }, { kind: 'repeat', tool: 'grep', detail: 'd' }, { kind: 'interrupted', entry: 'e2', detail: 'the user aborted the reply' }]),
    session('s-2', 'p/b', Date.UTC(2026, 10, 2), [{ kind: 'repeat', tool: 'read', entry: 'e3', detail: 'read called 4 times with the same arguments' }], { outcome: 'shipped', harness: 'abc' }),
    session('s-3', 'p/a', 0, [], { outcome: 'aborted', harness: 'abc-dirty' }),
  ];
  assert.deepEqual(summarizeSmells(sessions), [
    { kind: 'repeat', sessions: 2, hits: 3, tool: 'grep' }, { kind: 'error-streak', sessions: 0, hits: 0, tool: undefined },
    { kind: 'interrupted', sessions: 1, hits: 1, tool: undefined }, { kind: 'context-jump', sessions: 0, hits: 0, tool: undefined },
    { kind: 'restate', sessions: 0, hits: 0, tool: undefined }, { kind: 'backtrack', sessions: 0, hits: 0, tool: undefined },
  ]);
  assert.deepEqual(summarizeSmells([]).map(r => r.kind), [...SMELL_KINDS]);

  const text = formatSmells(sessions, 2);
  assert.match(text, /^## Session smells\n\n3 top-level sessions\. Provisional thresholds: /);
  assert.ok(text.includes('| repeat | 2 | 67% | 3 | grep |'));
  assert.ok(text.includes('| error-streak | 0 | 0% | 0 |  |'));
  assert.ok(text.includes('| p/a | 2 | 1 | 0 | 1 | 0 | 0 | 0 |'));
  assert.ok(text.includes('| p/b | 1 | 1 | 0 | 0 | 0 | 0 | 0 |'));
  // by outcome in the fixed order (only those present), then by harness version, then by model
  const tables = text.split('Sessions with at least one hit, by ').slice(1).map(t => t.split('\n').filter(l => l.startsWith('| ')).slice(1).map(l => l.split(' | ').slice(0, 3).join(' | ')));
  assert.deepEqual(tables, [
    ['| shipped | 1 | 1', '| aborted | 1 | 0', '| other | 1 | 1'],
    ['| abc | 1 | 1', '| abc-dirty | 1 | 0', '| unrecorded | 1 | 1'],
    ['| p/a | 2 | 1', '| p/b | 1 | 1'],
  ]);
  assert.ok(text.endsWith(['Latest hits (2 of 4):', '', '- repeat · 2026-11-02 · session s-2 · entry e3 · read called 4 times with the same arguments', '- repeat · 2026-11-01 · session s-1 · entry e1 · grep called 3 times with the same arguments'].join('\n')));
  assert.equal(formatSmells([]), '## Session smells\n\nNo top-level sessions to read.');
  assert.doesNotMatch(formatSmells([session('s-3', 'p/a', 0, [])]), /Latest hits/);
  assert.match(formatSmells([session('s-3', 'p/a', 0, [])]), /^## Session smells\n\n1 top-level session\. /);
});

test('restate: a user message that says nearly the same as the one before it; short messages never count', () => {
  const long = 'please rename the verbose option to debug everywhere in src';
  assert.ok(long.length >= RESTATE_MIN_CHARS);
  const again = user(`${long}!!`);
  const smells = sessionSmells([user(long), assistant([], 100), again, assistant([], 100), user('now add a test for the cli flag as well')]);
  assert.deepEqual(smells.map(s => [s.kind, s.entry]), [['restate', again.id]]);
  assert.match(smells[0]!.detail, /^user message \d+% similar to the previous one$/);
  assert.doesNotMatch(JSON.stringify(smells), /rename|verbose/); // never what was written
  assert.deepEqual(kinds([user('yes'), assistant(), user('yes'), assistant(), user('yes')]), []); // too short to judge
  assert.deepEqual(kinds([user('로그인 실패하면 재시도하게 해줄 수 있어요?'), assistant(), user('로그인이 실패하면 재시도하게 해 줄 수 있어요')]), ['restate']); // no word list: any language
  // compared with the previous user message only, not with every earlier one
  assert.deepEqual(kinds([user(long), assistant(), user('something entirely unrelated to that request'), assistant(), user(long)]), []);
  // a plain string body is read too; the very same text is said to be identical
  const same = sessionSmells([{ type: 'message', message: { role: 'user', content: long } }, { type: 'message', message: { role: 'user', content: ` ${long.toUpperCase()}\n` } }]);
  assert.deepEqual(same.map(s => [s.kind, s.detail]), [['restate', 'user message identical to the previous one']]);
  // a slash command, a skill or template, or a message the harness wrote is not a sentence the person typed: never compared, never the baseline
  const slash = '/cl-note the agent reran the whole suite again';
  const tagged = '<skill name="commit">a long body that is always the same</skill>';
  const bracket = '[Active goal] keep going until the done condition is met';
  assert.deepEqual(kinds([user(slash), user(slash), user(tagged), user(tagged), user(bracket), user(bracket)]), []);
  assert.deepEqual(kinds([user(long), assistant(), user(slash), user(bracket), user(long)]), ['restate']); // the baseline is the last typed message
});

test('similarity: 1 for the same text, 0 for nothing shared or nothing to compare', () => {
  assert.equal(similarity('abcdef', 'abcdef'), 1);
  assert.equal(similarity('abcdef', 'uvwxyz'), 0);
  assert.equal(similarity('', ''), 0);
  assert.equal(similarity('a', 'a'), 0); // no pair of characters
  assert.ok(similarity('abcdef', 'abcxyz') > 0 && similarity('abcdef', 'abcxyz') < 1);
});

test('backtrack: a git command that throws work away, by the agent or by the user; the detail names the subcommand only', () => {
  assert.deepEqual(['git restore src/a.ts', 'cd x && git -C /r reset --hard HEAD~1', 'git checkout -- a.ts', 'git checkout .', 'echo hi; git revert abc', '(git restore .)', 'true\ngit restore a'].map(undoCommand),
    ['restore', 'reset --hard', 'checkout --', 'checkout --', 'revert', 'restore', 'restore']);
  // however the command is led into: indentation, an assignment, sudo, a shell keyword, git's own options
  assert.deepEqual(['  git restore a', 'FOO=1 git restore a', 'sudo git restore a', 'if x; then git restore a; fi', 'git -c core.x=1 restore a', 'git --no-pager restore a', 'git -C "/a b" restore a'].map(undoCommand), Array(7).fill('restore'));
  assert.deepEqual(['git reset -q --hard', 'git reset HEAD~1 --hard', 'git checkout HEAD -- a.ts', 'git checkout -q -- a.ts', 'git checkout .; ls', '(git checkout .)', 'git restore --staged --worktree a'].map(undoCommand),
    ['reset --hard', 'reset --hard', 'checkout --', 'checkout --', 'checkout --', 'checkout --', 'restore']);
  // switching branches, a soft reset, stashing, unstaging and giving a revert up are not undoing
  assert.deepEqual(['git checkout main', 'git checkout -b x', 'git checkout ./a', 'git reset HEAD a', 'git stash', 'git restore --staged a.ts', 'git revert --abort', 'git restore-mtime', 'git revert-thing', undefined, 7].map(undoCommand), Array(11).fill(undefined));
  // nor are the words inside a quoted string or a heredoc, whatever separators they hold
  assert.deepEqual(['git commit -m "note: git restore was used"', 'echo git revert', 'git commit -m "line1\ngit reset --hard was wrong"', 'git commit -m "x (git restore y)"', "git commit -m 'a; git revert b'", 'grep -rE "foo|git restore" .',
    'git commit -F - <<\'EOF\'\nsubject\n\ngit restore . was wrong; git revert too\nEOF', 'cat > /tmp/m <<EOF\ngit reset --hard\nEOF\ngit status'].map(undoCommand), Array(8).fill(undefined));
  assert.equal(undoCommand('cat <<EOF\nbody\nEOF\ngit restore a'), 'restore'); // a command after the heredoc is still read

  const agent = bash('git restore secret/path.ts');
  const mine: SessionEntry = { type: 'message', id: id(), message: { role: 'bashExecution', command: 'git reset --hard HEAD~1' } };
  const smells = sessionSmells([user(), agent, result('bash'), mine, assistant([call('read', { path: 'git restore' })]), { type: 'message', id: id(), message: { role: 'bashExecution', command: 'ls' } }]);
  assert.deepEqual(smells.map(s => [s.kind, s.tool, s.detail, s.entry]), [['backtrack', 'bash', 'git restore run by the agent', agent.id], ['backtrack', undefined, 'git reset --hard run by the user', mine.id]]);
  assert.doesNotMatch(JSON.stringify(smells), /secret|HEAD~1/);
});

test('sessionInfo outcome: shipped when a commit or PR the agent ran succeeded; else how the last reply stopped', () => {
  const outcome = (entries: SessionEntry[]) => sessionInfo(entries).outcome;
  assert.equal(outcome([user(), bash('git add -A && git commit -q -m x', 'c1'), result('bash', false, 'c1'), assistant([], 0, 'aborted')]), 'shipped'); // shipped wins over a later abort
  assert.equal(outcome([user(), bash('gh pr create --fill', 'c2'), result('bash', false, 'c2')]), 'shipped');
  assert.equal(outcome([user(), bash('git commit -m x', 'c3'), result('bash', true, 'c3'), assistant()]), 'other'); // the commit failed
  assert.equal(outcome([user(), bash('git commit -m x', 'c4'), result('bash', false, 'other-call'), assistant()]), 'other'); // no result for that call
  assert.equal(outcome([user(), bash('echo "then run git commit"', 'c5'), result('bash', false, 'c5'), assistant()]), 'other'); // only mentioned
  assert.equal(outcome([user(), assistant([call('write', { command: 'git commit' }, 'c6')]), result('write', false, 'c6'), assistant()]), 'other'); // not bash
  assert.deepEqual(['git commit -m x', 'git add -A && git commit -q -m x', 'HUSKY=0 git commit -m x', 'git -c user.name=x -c user.email=y commit -m x', ' git commit -m x', 'sudo git commit', 'gh pr create --fill', 'git commit -F /tmp/m.txt && git push'].map(shipsCommand), Array(8).fill(true));
  assert.deepEqual(['git commit --dry-run', 'git commit --help', 'git commit-graph write', 'echo "x; git commit"', 'git log --grep="a|gh pr create"', 'gh pr view', 'gh pr', 'git', '', undefined].map(shipsCommand), Array(10).fill(false));
  // a commit the user ran with ! counts when it exited 0
  const mine = (command: string, exitCode: number | undefined): SessionEntry => ({ type: 'message', id: id(), message: { role: 'bashExecution', command, exitCode } });
  assert.equal(outcome([user(), assistant(), mine('git commit -m x', 0)]), 'shipped');
  assert.equal(outcome([user(), assistant(), mine('git commit -m x', 1), mine('git commit -m x', undefined), mine('git status', 0)]), 'other');
  assert.equal(outcome([user(), assistant(), user(), assistant([], 0, 'aborted')]), 'aborted');
  assert.equal(outcome([user(), assistant([], 0, 'aborted'), user(), assistant()]), 'other'); // an abort earlier on is not how it ended
  assert.equal(outcome([user(), assistant([], 0, 'error')]), 'error');
  assert.equal(outcome([user()]), 'other');
});

test('sessionInfo harness: the version most requests ran under; a version with no request after it still counts when it is the only one', () => {
  assert.equal(harnessLabel({ sha: 'abc', dirty: false }), 'abc');
  assert.equal(harnessLabel({ sha: 'abc', dirty: true }), 'abc-dirty');
  const harness = (entries: SessionEntry[]) => sessionInfo(entries).harness;
  assert.equal(harness([stamp('aaa'), user(), assistant(), stamp('bbb', true), user(), assistant(), assistant()]), 'bbb-dirty');
  assert.equal(harness([user(), assistant(), assistant(), stamp('aaa'), user(), assistant()]), 'aaa'); // requests before any version are not counted for one
  assert.equal(harness([stamp('aaa')]), 'aaa');
  assert.equal(harness([{ type: 'custom', customType: HARNESS_ENTRY, data: null }, { type: 'custom', customType: HARNESS_ENTRY, data: { sha: 7 } }, { type: 'custom', customType: 'other', data: { sha: 'zzz' } }, user(), assistant()]), 'unrecorded');
});
