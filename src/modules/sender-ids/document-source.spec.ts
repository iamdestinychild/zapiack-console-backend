import { documentSource } from './document-source';

const cfg = { cdnBaseUrl: 'https://cdn.zapiack.com', senderIdBucket: '', senderIdPrefix: 'sms-documents/' };

describe('documentSource', () => {
  it('reads a document from the CDN it is served from', () => {
    expect(documentSource('https://cdn.zapiack.com/sms-documents/p1/letterhead-mtn.pdf', cfg)).toEqual({
      kind: 'cdn',
      url: 'https://cdn.zapiack.com/sms-documents/p1/letterhead-mtn.pdf',
    });
  });

  it('reads straight from S3 once a bucket is set and the object is under the prefix', () => {
    const withBucket = { ...cfg, senderIdBucket: 'docs' };
    expect(documentSource('https://cdn.zapiack.com/sms-documents/p1/cac.pdf', withBucket)).toEqual({
      kind: 's3',
      key: 'sms-documents/p1/cac.pdf',
    });
    expect(documentSource('https://cdn.zapiack.com/other/cac.pdf', withBucket)).toMatchObject({ kind: 'cdn' });
  });

  it.each([
    ['another host', 'https://evil.example.com/sms-documents/a.pdf'],
    ['plain http', 'http://cdn.zapiack.com/sms-documents/a.pdf'],
    ['a look-alike host', 'https://cdn.zapiack.com.evil.example/a.pdf'],
    ['no path', 'https://cdn.zapiack.com/'],
    ['not an address', 'sms-documents/a.pdf'],
  ])('refuses %s', (_label, url) => {
    expect(documentSource(url, { ...cfg, senderIdBucket: 'docs' })).toBeNull();
  });

  it('cannot be walked out of the prefix: dot segments are resolved before anything is read', () => {
    const withBucket = { ...cfg, senderIdBucket: 'docs' };
    // The address is normalised on the same host, so this is an ordinary CDN path outside the prefix, not an S3 read.
    expect(documentSource('https://cdn.zapiack.com/sms-documents/%2e%2e/%2e%2e/etc/passwd', withBucket)).toEqual({
      kind: 'cdn',
      url: 'https://cdn.zapiack.com/etc/passwd',
    });
  });

  it('refuses everything when the CDN is not configured properly', () => {
    expect(documentSource('https://cdn.zapiack.com/a.pdf', { ...cfg, cdnBaseUrl: '' })).toBeNull();
  });
});
