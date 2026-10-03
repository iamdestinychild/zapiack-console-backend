import { cookieScope } from './cookie-scope';

const auto = { sameSite: 'auto' as const, secure: true };

describe('cookieScope', () => {
  it('uses Domain and Strict when console and API share a site', () => {
    expect(
      cookieScope(
        { ...auto, domain: 'zapiack.com' },
        'admin-api.zapiack.com',
        'https://console.zapiack.com',
      ),
    ).toEqual({ domain: 'zapiack.com', sameSite: 'strict' });
  });

  it('drops Domain when the API is not under it, instead of having the browser reject the cookie', () => {
    const scope = cookieScope(
      { ...auto, domain: 'zapiack.com' },
      'zapiack-console-backend.onrender.com',
      'https://console.zapiack.com',
    );
    expect(scope.domain).toBeUndefined();
  });

  it('switches to None when the console is on another site', () => {
    expect(
      cookieScope(
        auto,
        'zapiack-console-backend.onrender.com',
        'https://console.zapiack.com',
      ).sameSite,
    ).toBe('none');
  });

  it('treats two onrender.com services as different sites', () => {
    expect(
      cookieScope(auto, 'api.onrender.com', 'https://console.onrender.com')
        .sameSite,
    ).toBe('none');
  });

  it('stays Strict when not Secure, since None would be refused', () => {
    expect(
      cookieScope(
        { sameSite: 'auto', secure: false },
        'localhost',
        'http://127.0.0.1:5173',
      ).sameSite,
    ).toBe('strict');
  });

  it('honours an explicit SameSite', () => {
    expect(
      cookieScope(
        { sameSite: 'lax', secure: true },
        'a.onrender.com',
        'https://console.zapiack.com',
      ).sameSite,
    ).toBe('lax');
  });
});
