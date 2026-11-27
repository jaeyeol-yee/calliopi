// /cl-note: a one-line note about this session, for the person who later decides what to improve.
// The note goes to the notes file (@calliopi/core/notes) and into the session as a custom entry, which
// marks where in the session it was written. Neither is sent to a model, and no turn starts.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { appendNote, noteLine, readNotes } from '@calliopi/core/notes';

export const NOTE_ENTRY = 'calliopi-note';
/** How many notes `/cl-note` without text shows. */
export const RECENT = 5;

export function installNotes(pi: ExtensionAPI, deps: { file: () => string; now?: () => number }): void {
  pi.registerCommand('cl-note', {
    description: '이 세션에 대한 한 줄 메모를 남깁니다(에이전트가 헛돌았거나 교정해야 했을 때). 모델에게는 보내지 않습니다. 인자 없이 쓰면 최근 메모를 봅니다. 모아 보기: npm run signals',
    handler: async (args, ctx) => {
      const file = deps.file();
      if (!args.trim()) {
        const notes = readNotes(file);
        if (!notes.length) return ctx.ui.notify('메모가 없습니다. 사용법: /cl-note <한 줄 메모>', 'info');
        return ctx.ui.notify([`메모 ${notes.length}개 중 최근 ${Math.min(RECENT, notes.length)}개:`, ...notes.slice(-RECENT).reverse().map(noteLine)].join('\n'), 'info');
      }
      const session = ctx.sessionManager.getSessionId();
      let note;
      try {
        note = appendNote(file, {
          at: (deps.now ?? Date.now)(), text: args, session, sessionFile: ctx.sessionManager.getSessionFile() ?? undefined, cwd: ctx.cwd,
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        });
      } catch (error) {
        return ctx.ui.notify(`메모를 쓰지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
      if (!note) return;
      pi.appendEntry(NOTE_ENTRY, { text: note.text, at: note.at });
      const all = readNotes(file);
      ctx.ui.notify(`메모했습니다 (이 세션 ${all.filter(n => n.session === session).length}개, 전체 ${all.length}개).`, 'info');
    },
  });
}
