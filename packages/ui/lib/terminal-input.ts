const specials: Record<number, string> = {
  27: '\x1b', 13: '\r', 9: '\t', 127: '\x7f',
  57348: '\x1b[2~', 57349: '\x1b[3~',
  57350: '\x1b[D', 57351: '\x1b[C', 57352: '\x1b[A', 57353: '\x1b[B',
  57354: '\x1b[5~', 57355: '\x1b[6~', 57356: '\x1b[H', 57357: '\x1b[F',
  57364: '\x1bOP', 57365: '\x1bOQ', 57366: '\x1bOR', 57367: '\x1bOS',
  57368: '\x1b[15~', 57369: '\x1b[17~', 57370: '\x1b[18~', 57371: '\x1b[19~',
  57372: '\x1b[20~', 57373: '\x1b[21~', 57374: '\x1b[23~', 57375: '\x1b[24~',
};
const shifted: Record<string, string> = Object.fromEntries([..."`1234567890-=[]\\;',./"].map((key, i) => [key, '~!@#$%^&*()_+{}|:"<>?'[i]]));

export interface TerminalInputModes {
  bracketedPasteMode?: boolean;
  applicationCursorKeysMode?: boolean;
}

// The outer terminal uses Pi's Kitty keyboard protocol; the inner PTY advertises xterm-256color.
export function terminalInput(data: string, modes: TerminalInputModes = {}): string {
  if (data.includes('\x1b[200~') || data.includes('\x1b[201~')) {
    return modes.bracketedPasteMode ? data : data.replaceAll('\x1b[200~', '').replaceAll('\x1b[201~', '');
  }
  // CSI code[:shifted[:base]][;mods[:event]][;text]u — fields may be empty, e.g. IME jamo
  // release events arrive as \x1b[12609::97;1:3u (ㅁ with base key 'a', no shifted key).
  const kitty = /^\x1b\[(\d+)(?::(\d*))?(?::(\d*))?(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u$/.exec(data);
  if (kitty) {
    if (kitty[5] === '3') return ''; // release
    const code = Number(kitty[1]);
    const mod = (Number(kitty[4] || 1) - 1) & ~(64 | 128); // Caps Lock / Num Lock are not modifiers here
    if (mod & ~7) return ''; // Super/Hyper/etc have no legacy equivalent.
    let text = specials[code];
    if (text === undefined && code >= 32 && code <= 0x10ffff && (code < 57344 || code > 63743)) {
      text = String.fromCodePoint((mod & 1) && kitty[2] ? Number(kitty[2]) : code);
      if ((mod & 1) && !kitty[2]) text = shifted[text] || text.toUpperCase();
    }
    if (text === undefined) return '';
    if (mod && /^\x1b\[[ABCDHF]$/.test(text)) return `\x1b[1;${mod + 1}${text.at(-1)}`;
    if (mod && /^\x1b\[\d+~$/.test(text)) return text.replace('~', `;${mod + 1}~`);
    if (mod && /^\x1bO[PQRS]$/.test(text)) return `\x1b[1;${mod + 1}${text.at(-1)}`;
    if ((mod & 4) && text.length === 1) {
      const n = text.toUpperCase().charCodeAt(0);
      const controls: Record<string, string> = { ' ': '\0', '2': '\0', '3': '\x1b', '4': '\x1c', '5': '\x1d', '6': '\x1e', '7': '\x1f', '8': '\x7f', '\x7f': '\x08' };
      text = n >= 64 && n <= 95 ? String.fromCharCode(n - 64) : (controls[text] ?? text);
    }
    if ((mod & 1) && code === 9) text = '\x1b[Z';
    if (mod & 2) text = `\x1b${text}`;
    data = text;
  }
  // Never forward a Kitty key event we could not decode: the inner program (e.g. Vim)
  // would interpret it as a keypress of its own.
  else if (/^\x1b\[[\d:;]*u$/.test(data)) return '';
  // Kitty release/repeat forms for legacy navigation sequences.
  if (/^\x1b\[[\d;]*:\d+[A-Za-z~]$/.test(data)) {
    if (/:3[A-Za-z~]$/.test(data)) return '';
    data = data.replace(/:[12]([A-Za-z~])$/, '$1');
  }
  // "No modifier" written explicitly (CSI 1;1B, CSI 3;1~) → plain legacy form.
  data = data.replace(/^\x1b\[1;1([ABCDHF])$/, '\x1b[$1').replace(/^\x1b\[(\d+);1~$/, '\x1b[$1~');
  if (modes.applicationCursorKeysMode && /^\x1b\[[ABCDHF]$/.test(data)) return data.replace('[', 'O');
  return data;
}

// Key names for keys the overlay itself handles (pane focus, closing). Press/repeat only;
// releases return null and are dropped by terminalInput() anyway.
export function keyName(data: string): string | null {
  const legacy: Record<string, string> = { '\r': 'enter', '\x1b': 'escape', '\t': 'tab', '\x1b[Z': 'shift+tab', '\x03': 'ctrl+c' };
  const named = legacy[data];
  if (named) return named;
  const kitty = /^\x1b\[(\d+)(?::\d*)?(?::\d*)?(?:;(\d*)(?::(\d+))?)?(?:;[\d:]*)?u$/.exec(data);
  if (!kitty || kitty[3] === '3') return null;
  const code = Number(kitty[1]);
  const mod = (Number(kitty[2] || 1) - 1) & ~(64 | 128); // ignore Caps/Num Lock
  if (mod === 0) return ({ 13: 'enter', 27: 'escape', 9: 'tab' } as Record<number, string | undefined>)[code] ?? null;
  if (mod === 1 && code === 9) return 'shift+tab';
  if (mod === 4 && code === 99) return 'ctrl+c';
  return null;
}
