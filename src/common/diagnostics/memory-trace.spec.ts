import {
  everyNth,
  resetTrace,
  traceEnabled,
  traceSummary,
  traced,
} from './memory-trace';

describe('memory trace', () => {
  const saved = process.env['MEMORY_TRACE'];
  afterEach(() => {
    if (saved === undefined) delete process.env['MEMORY_TRACE'];
    else process.env['MEMORY_TRACE'] = saved;
    resetTrace();
  });

  it('is off unless MEMORY_TRACE is true', () => {
    expect(traceEnabled({})).toBe(false);
    expect(traceEnabled({ MEMORY_TRACE: 'false' })).toBe(false);
    expect(traceEnabled({ MEMORY_TRACE: '1' })).toBe(false);
    expect(traceEnabled({ MEMORY_TRACE: 'TRUE' })).toBe(true);
  });

  it('returns the result unchanged when off, and records nothing', async () => {
    delete process.env['MEMORY_TRACE'];
    await expect(traced('job', async () => 42)).resolves.toBe(42);
    expect(traceSummary()).toBe('');
  });

  it('returns the result unchanged when on', async () => {
    process.env['MEMORY_TRACE'] = 'true';
    await expect(traced('job', async () => 'done')).resolves.toBe('done');
  });

  it('still fails when the work fails, and still measures it', async () => {
    process.env['MEMORY_TRACE'] = 'true';
    await expect(
      traced('job', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });

  it('adds up what a label keeps alive, so the largest holder tops the summary', async () => {
    process.env['MEMORY_TRACE'] = 'true';
    const kept: unknown[] = [];

    for (let i = 0; i < 3; i++) {
      await traced('leaky', async () => {
        // Objects on the V8 heap (a Buffer's bytes are outside it), held by something outside the job.
        kept.push(Array.from({ length: 150_000 }, (_, n) => ({ n, tag: 'x' })));
      });
    }
    await traced('tidy', async () => undefined);

    expect(traceSummary()).toMatch(/^leaky=\+/);
    expect(kept).toHaveLength(3);
  });

  it('samples one call in N', () => {
    const counter = { n: 0 };
    const hits = Array.from({ length: 10 }, () => everyNth(counter, 5));
    expect(hits.filter(Boolean)).toHaveLength(2);
    expect(hits[4]).toBe(true);
    expect(hits[9]).toBe(true);
  });
});
