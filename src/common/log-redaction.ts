import { inspect } from 'node:util';

/** Environment variables that hold a credential outright. */
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|ACCESS_KEY)/i;
/** Variables that are connection strings: the password inside them is the secret. */
const URL_NAME = /_URL$/;

const MIN_LENGTH = 6;

/**
 * Every credential this process was configured with, in the forms it might be printed:
 * as given, and URL-encoded (a `:` or `@` in a password is percent-encoded inside a URL,
 * and ioredis prints the decoded form while a connection string shows the encoded one).
 */
export function collectSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const found = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value || value.length < MIN_LENGTH) return;
    found.add(value);
    found.add(encodeURIComponent(value));
  };

  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (URL_NAME.test(name)) {
      try {
        const url = new URL(value.trim());
        if (url.password) {
          add(url.password);
          try {
            add(decodeURIComponent(url.password));
          } catch {
            /* a stray % is not a reason to stop scrubbing */
          }
        }
      } catch {
        // Not a parseable URL. It may still be a credential someone pasted wrongly, so
        // treat the whole value as secret rather than risk printing it.
        add(value);
      }
    } else if (SECRET_NAME_MATCH(name)) {
      add(value);
    }
  }

  // Longest first, so a secret that contains another is replaced whole.
  return [...found].sort((a, b) => b.length - a.length);
}

function SECRET_NAME_MATCH(name: string): boolean {
  return SECRET_NAME.test(name);
}

export function createRedactor(secrets: string[]): (text: string) => string {
  return (text) => {
    let out = text;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join('[redacted]');
    }
    return out;
  };
}

/**
 * Scrubs configured secrets from everything libraries write through `console`.
 *
 * Several of them print whole error objects, and a rejected login carries the command
 * that failed: BullMQ's `queue-base` calls `console.error(err)`, and an ioredis ReplyError
 * holds `AUTH <user> <password>`. Listeners can be attached one library at a time, but
 * the next dependency prints something new; this closes the whole class.
 *
 * Objects are rendered with `util.inspect` first, so a secret nested inside one is found.
 */
export function installLogRedaction(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const secrets = collectSecrets(env);
  if (!secrets.length) return 0;
  const redact = createRedactor(secrets);

  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[method].bind(console) as (
      ...args: unknown[]
    ) => void;
    console[method] = (...args: unknown[]) =>
      original(
        ...args.map((arg) =>
          redact(typeof arg === 'string' ? arg : inspect(arg, { depth: 6 })),
        ),
      );
  }
  return secrets.length;
}
