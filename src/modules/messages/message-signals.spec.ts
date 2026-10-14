import { extractLinks, hostOf, preview } from './message-signals';

describe('links in a message', () => {
  it('lifts them out in order, once each, without trailing punctuation', () => {
    const links = extractLinks('Verify at https://acme-bank.example/login, or www.acme.example. Again https://acme-bank.example/login');
    expect(links.map((l) => l.url)).toEqual(['https://acme-bank.example/login', 'www.acme.example']);
    expect(links.map((l) => l.host)).toEqual(['acme-bank.example', 'acme.example']);
  });

  it('marks the ones that hide where they go', () => {
    expect(extractLinks('Claim now http://bit.ly/3xYz')[0]).toMatchObject({ host: 'bit.ly', shortener: true });
    expect(extractLinks('https://zapiack.com')[0].shortener).toBe(false);
  });

  it('reads several texts, and finds none in plain words', () => {
    expect(extractLinks('no link here', null, undefined)).toEqual([]);
    expect(extractLinks('a https://one.example', 'b https://two.example').map((l) => l.host)).toEqual(['one.example', 'two.example']);
  });

  it('gives the host of a url, or nothing for rubbish', () => {
    expect(hostOf('https://WWW.Example.com/a?b=1')).toBe('example.com');
    expect(hostOf('http://')).toBe('');
  });
});

describe('a preview', () => {
  it('is one line and cut with an ellipsis', () => {
    expect(preview('Hello\n\n  world')).toBe('Hello world');
    expect(preview('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(preview(null)).toBe('');
  });
});
