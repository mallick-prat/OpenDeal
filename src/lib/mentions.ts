/**
 * Pure helpers for @-mentions in the comment composer — caret query detection,
 * member matching, and splitting a body into plain / mention segments for
 * highlighting. No React or I/O, so they're unit-tested.
 */

export interface MentionMember {
  email: string;
  name: string;
  image: string | null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The @-query immediately before the caret, or null when the caret isn't in a
 * mention. The `@` must start a token (start of line, whitespace, or `(`), and
 * the query may contain spaces (names do), up to 30 chars.
 */
export function activeMentionQuery(value: string, caret: number): string | null {
  const before = value.slice(0, Math.max(0, caret));
  const m = before.match(/(?:^|[\s(])@([^@\n]{0,30})$/);
  return m ? m[1] : null;
}

/** Members whose name contains the query, earliest-match first. */
export function matchMembers(
  members: MentionMember[],
  query: string,
  limit = 6
): MentionMember[] {
  const q = query.toLowerCase().trim();
  return members
    .filter((m) => m.name)
    .map((m) => ({ m, idx: q === "" ? 0 : m.name.toLowerCase().indexOf(q) }))
    .filter((x) => q === "" || x.idx >= 0)
    .sort((a, b) => a.idx - b.idx || a.m.name.localeCompare(b.m.name))
    .slice(0, limit)
    .map((x) => x.m);
}

/** Split a body into plain / mention runs so the UI can highlight `@Name`. */
export function splitMentions(
  body: string,
  names: string[]
): { text: string; mention: boolean }[] {
  const valid = [...new Set(names.filter(Boolean))]
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length); // longest first so full names win
  if (valid.length === 0) return [{ text: body, mention: false }];
  const re = new RegExp(`@(?:${valid.join("|")})`, "gi");
  const out: { text: string; mention: boolean }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) out.push({ text: body.slice(last, m.index), mention: false });
    out.push({ text: m[0], mention: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // guard against zero-width loops
  }
  if (last < body.length) out.push({ text: body.slice(last), mention: false });
  return out;
}
