export type SameSite = 'strict' | 'lax' | 'none';

export interface CookieSettings {
  /** Configured parent domain, if any. */
  domain?: string;
  /** Explicit choice, or 'auto' to work it out from the request. */
  sameSite: SameSite | 'auto';
  secure: boolean;
}

/** Hosts where every subdomain belongs to a different customer, so they never share a site. */
const SHARED_SUFFIXES = [
  'onrender.com',
  'netlify.app',
  'vercel.app',
  'pages.dev',
  'github.io',
  'herokuapp.com',
];

/** Approximate registrable domain: the shared suffix plus one label, else the last two. */
function siteOf(hostname: string): string {
  const host = hostname.toLowerCase();
  for (const suffix of SHARED_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) {
      const label = host
        .slice(0, -suffix.length - 1)
        .split('.')
        .pop();
      return label ? `${label}.${suffix}` : suffix;
    }
  }
  return host.split('.').slice(-2).join('.');
}

export function hostOf(origin?: string | null): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}

/**
 * The Domain and SameSite a session cookie should carry for this request.
 *
 * Both depend on where the console and the API actually are, which is easy to get
 * wrong in configuration and impossible to debug from the browser: a cookie the
 * browser refuses is dropped without a word, and sign-in then fails at the next step.
 *  - Domain applies only when the API host really sits under it. Otherwise the
 *    browser rejects the whole cookie.
 *  - SameSite=Strict needs the console and API on one site. When the request comes
 *    from another site (and the cookie is Secure) it has to be None to be sent at all.
 * Origin is only ever an origin CORS has already accepted, and writes still require the
 * double-submit CSRF token.
 */
export function cookieScope(
  settings: CookieSettings,
  apiHost: string,
  origin?: string | null,
): { domain?: string; sameSite: SameSite } {
  const host = apiHost.toLowerCase().split(':')[0];
  const parent = settings.domain?.replace(/^\./, '').toLowerCase();
  const domain =
    parent && (host === parent || host.endsWith(`.${parent}`))
      ? settings.domain
      : undefined;

  if (settings.sameSite !== 'auto')
    return { domain, sameSite: settings.sameSite };

  const consoleHost = hostOf(origin);
  const crossSite = consoleHost ? siteOf(consoleHost) !== siteOf(host) : false;
  return { domain, sameSite: crossSite && settings.secure ? 'none' : 'strict' };
}
