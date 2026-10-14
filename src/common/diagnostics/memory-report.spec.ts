import { formatMemory } from './memory-report';

const MB = 1024 * 1024;

describe('the memory line', () => {
  it('says where the memory is, in megabytes', () => {
    const line = formatMemory(
      {
        rss: 525 * MB,
        heapUsed: 300 * MB,
        heapTotal: 340 * MB,
        external: 70 * MB,
        arrayBuffers: 65 * MB,
      },
      [],
      600,
    );
    expect(line).toBe(
      'memory rss=525MB heapUsed=300MB heapTotal=340MB external=70MB arrayBuffers=65MB uptime=10min',
    );
  });

  it('counts open handles by kind, most common first', () => {
    const line = formatMemory(
      { rss: MB, heapUsed: MB, heapTotal: MB, external: 0, arrayBuffers: 0 },
      ['Timeout', 'TCPSocketWrap', 'Timeout', 'Timeout', 'TCPSocketWrap'],
    );
    expect(line).toContain('handles: Timeout=3 TCPSocketWrap=2');
  });
});
