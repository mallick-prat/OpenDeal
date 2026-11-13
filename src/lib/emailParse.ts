/**
 * ── Gmail message parsing (pure) ─────────────────────────────────────────────
 * Turns a Gmail `format=full` payload into the bits the ingestion pipeline
 * needs: sender, plain-text body, deck-share links, and downloadable deck
 * attachments. No I/O — kept pure so it's unit-testable.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DeckLink {
  url: string;
  kind: DeckKind;
}
export type DeckKind =
  | "docsend"
  | "drive"
  | "pitch"
  | "papermark"
  | "dropbox"
  | "box"
  | "notion"
  | "figma"
  | "canva"
  | "other";

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface ParsedEmail {
  from: { name: string; email: string };
  subject: string;
  bodyText: string;
  deckLinks: DeckLink[];
  attachments: AttachmentMeta[];
}

export function headerValue(payload: any, name: string): string {
  const h = (payload?.headers ?? []).find(
    (x: any) => x?.name?.toLowerCase() === name.toLowerCase()
  );
  return String(h?.value ?? "");
}

/** "Ada Lovelace <ada@x.com>" → {name, email}; bare address ok. */
export function parseFrom(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? "").trim(), email: m[2].trim().toLowerCase() };
  const bare = raw.trim();
  return { name: "", email: bare.includes("@") ? bare.toLowerCase() : "" };
}

function decodeB64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

/** Strip tags/entities from an HTML body into rough plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const DOWNLOADABLE = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // pptx
  "application/vnd.ms-powerpoint", // ppt
]);
// Skip inline signature logos / tracking pixels masquerading as attachments.
const MIN_ATTACHMENT_BYTES = 20 * 1024;

/** Walk the MIME tree, collecting text bodies and downloadable attachments. */
function walk(
  part: any,
  out: { text: string[]; html: string[]; attachments: AttachmentMeta[] }
): void {
  if (!part) return;
  const mime = String(part.mimeType ?? "");
  const filename = String(part.filename ?? "");
  const body = part.body ?? {};

  if (filename && body.attachmentId) {
    const size = Number(body.size ?? 0);
    if (DOWNLOADABLE.has(mime) || /\.(pdf|pptx?|key)$/i.test(filename)) {
      if (size >= MIN_ATTACHMENT_BYTES) {
        out.attachments.push({
          filename,
          mimeType: mime || "application/octet-stream",
          attachmentId: body.attachmentId,
          size,
        });
      }
    }
  } else if (mime === "text/plain" && body.data) {
    out.text.push(decodeB64Url(body.data));
  } else if (mime === "text/html" && body.data) {
    out.html.push(decodeB64Url(body.data));
  }

  for (const child of part.parts ?? []) walk(child, out);
}

const DECK_HOSTS: [RegExp, DeckKind][] = [
  [/docsend\.com/i, "docsend"],
  [/(?:docs|drive)\.google\.com/i, "drive"],
  [/pitch\.com/i, "pitch"],
  [/papermark\.(?:io|com)/i, "papermark"],
  [/dropbox\.com/i, "dropbox"],
  [/(?:app\.)?box\.com/i, "box"],
  [/notion\.(?:so|site)/i, "notion"],
  [/figma\.com/i, "figma"],
  [/canva\.com/i, "canva"],
];

/** Pull deck-share links out of raw text, deduped, classified by host. */
export function findDeckLinks(text: string): DeckLink[] {
  const urls = text.match(/https?:\/\/[^\s<>()"']+/gi) ?? [];
  const seen = new Set<string>();
  const links: DeckLink[] = [];
  for (const raw of urls) {
    const url = raw.replace(/[.,;:)\]}>"']+$/, "");
    const kind = DECK_HOSTS.find(([re]) => re.test(url))?.[1];
    if (!kind) continue;
    // Drive/Dropbox root or generic folder listings aren't decks.
    if (kind === "drive" && !/\/(file|presentation|d)\//i.test(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ url, kind });
    if (links.length >= 12) break;
  }
  return links;
}

export function parseGmailMessage(msg: {
  payload: any;
  snippet?: string;
}): ParsedEmail {
  const out = { text: [] as string[], html: [] as string[], attachments: [] as AttachmentMeta[] };
  walk(msg.payload, out);

  const bodyText =
    (out.text.join("\n\n").trim() ||
      htmlToText(out.html.join("\n\n")) ||
      String(msg.snippet ?? "")).slice(0, 40_000);

  const from = parseFrom(headerValue(msg.payload, "From"));
  const subject = headerValue(msg.payload, "Subject").slice(0, 400);
  // Search both body and subject for deck links.
  const deckLinks = findDeckLinks(`${subject}\n${bodyText}`);

  return { from, subject, bodyText, deckLinks, attachments: out.attachments.slice(0, 10) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
