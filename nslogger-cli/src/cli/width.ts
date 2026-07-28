/** Terminal column width of a string. CJK and emoji occupy two columns; miscounting
 *  them makes lines wrap and breaks the fixed-height TUI layout. */
export function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue; // control chars occupy nothing
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) ||   // CJK radicals through Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||   // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) ||   // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f9ff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK extension B+
  );
}

/** Cut to at most `width` columns, appending … when anything was dropped. */
export function truncateToWidth(s: string, width: number): string {
  if (stringWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** Right-pad with spaces to exactly `width` columns (no-op if already wider). */
export function padToWidth(s: string, width: number): string {
  const pad = width - stringWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}
