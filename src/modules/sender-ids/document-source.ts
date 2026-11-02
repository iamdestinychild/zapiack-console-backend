/** Where a stored document can be read from. */
export type DocumentSource =
  { kind: 's3'; key: string } | { kind: 'cdn'; url: string };

/**
 * Works out how to read a sender ID document from the address the product stored for it.
 *
 * The address is written by api-core, never by a person, but it is still checked: only the CDN the documents are served
 * from is ever fetched, so a bad row cannot make admin-core request an arbitrary address. When the object sits under the
 * configured bucket prefix it is read straight from S3, which needs no public route to the file at all.
 */
export function documentSource(
  fileUrl: string,
  cfg: { cdnBaseUrl: string; senderIdBucket: string; senderIdPrefix: string },
): DocumentSource | null {
  let url: URL;
  let cdn: URL;
  try {
    url = new URL(fileUrl);
    cdn = new URL(cfg.cdnBaseUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.origin !== cdn.origin) return null;

  let key: string;
  try {
    key = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!key || key.split('/').includes('..')) return null;

  if (
    cfg.senderIdBucket &&
    cfg.senderIdPrefix &&
    key.startsWith(cfg.senderIdPrefix)
  ) {
    return { kind: 's3', key };
  }
  return { kind: 'cdn', url: url.toString() };
}
