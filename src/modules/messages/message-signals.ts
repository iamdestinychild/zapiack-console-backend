/**
 * What a reviewer wants to see first in a message they did not write: where it sends
 * people. Phishing and scam messages are almost always a link, so the links are lifted
 * out and the ones that hide their destination are marked.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+|\bwww\.[^\s<>"')\]]+/gi;

/** Services that hide where a link goes. A message made only of these is worth a look. */
const SHORTENERS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'cutt.ly',
  'rb.gy',
  'shorturl.at',
  'tiny.cc',
  'rebrand.ly',
]);

export interface MessageLink {
  url: string;
  host: string;
  shortener: boolean;
}

export function hostOf(url: string): string {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Distinct links in the text, in the order they appear. Trailing punctuation is not part of a link. */
export function extractLinks(...texts: Array<string | null | undefined>): MessageLink[] {
  const seen = new Set<string>();
  const links: MessageLink[] = [];
  for (const text of texts) {
    for (const match of text?.match(URL_PATTERN) ?? []) {
      const url = match.replace(/[.,;:!?]+$/, '');
      if (seen.has(url)) continue;
      seen.add(url);
      const host = hostOf(url);
      links.push({ url, host, shortener: SHORTENERS.has(host) });
    }
  }
  return links;
}

/** First part of a message for a list row, on one line. */
export function preview(text: string | null | undefined, length = 160): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}
