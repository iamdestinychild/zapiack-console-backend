/**
 * Fills the OpenAPI document with real response examples.
 *
 * The Swagger plugin derives request shapes from the DTOs, but handlers return plain
 * objects, so responses cannot be inferred. This signs in against a running service,
 * calls every safe GET, and writes what actually comes back into the document as an
 * example — which is the half the console team needs most.
 *
 *   npm run docs:generate
 *
 * Reads DOCS_EMAIL, DOCS_PASSWORD and DOCS_TOTP_SECRET. Writes openapi.json.
 */
import { writeFileSync } from 'node:fs';
import { generateSync } from 'otplib';
import { DateTime } from 'luxon';

const BASE = process.env.DOCS_BASE ?? 'http://localhost:3001';
const API = `${BASE}/admin/v1`;

/** Streaming and file-download routes cannot be sampled as JSON. */
const SKIP = [/\/geo\/live$/, /\/events$/, /documents\.zip$/, /\/docs/];

const jar = new Map<string, string>();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

function absorb(res: Response) {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

async function signIn() {
  const email = process.env.DOCS_EMAIL;
  const password = process.env.DOCS_PASSWORD;
  const secret = process.env.DOCS_TOTP_SECRET;
  if (!email || !password || !secret) {
    throw new Error('Set DOCS_EMAIL, DOCS_PASSWORD and DOCS_TOTP_SECRET');
  }

  let res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  absorb(res);

  res = await fetch(`${API}/auth/2fa/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie() },
    body: JSON.stringify({ code: generateSync({ secret }) }),
  });
  absorb(res);
  if (!res.ok)
    throw new Error(`Sign-in failed: ${res.status} ${await res.text()}`);
}

/** Real ids from the seeded data, so path parameters resolve to something. */
async function discoverIds() {
  const get = async (path: string) => {
    const res = await fetch(`${API}${path}`, { headers: { cookie: cookie() } });
    return res.ok
      ? ((await res.json()) as { data?: Record<string, unknown>[] })
      : null;
  };

  const [
    customers,
    senderIds,
    staff,
    roles,
    adjustments,
    campaigns,
    segments,
    templates,
    exports,
  ] = await Promise.all([
    get('/customers?limit=1'),
    get('/sender-ids?limit=1'),
    get('/staff?limit=1'),
    get('/roles'),
    get('/credit-adjustments?limit=1'),
    get('/campaigns?limit=1'),
    get('/segments'),
    get('/templates'),
    get('/exports?limit=1'),
  ]);

  const first = (
    page: { data?: Record<string, unknown>[] } | null,
    key = 'id',
  ) => page?.data?.[0]?.[key] as string | undefined;

  // Not every application carries documents, so scan for one that does rather than
  // assuming the first in the queue has them.
  const queue = await get('/sender-ids?limit=10');
  const reviewId = first(senderIds);
  let documentReviewId: string | undefined;
  let docId: string | undefined;

  for (const review of queue?.data ?? []) {
    const detail = (await get(
      `/sender-ids/${review.id as string}`,
    )) as unknown as {
      documents?: { id: string }[];
    } | null;
    if (detail?.documents?.length) {
      documentReviewId = review.id as string;
      docId = detail.documents[0].id;
      break;
    }
  }

  return {
    id: first(customers) ?? first(senderIds) ?? 'acc_1',
    accountId: first(customers) ?? 'acc_1',
    senderIdReviewId: reviewId,
    // The document routes need a review that actually has one.
    documentReviewId,
    docId,
    staffId: first(staff),
    roleId: first(roles),
    adjustmentId: first(adjustments),
    campaignId: first(campaigns),
    segmentId: first(segments),
    templateId: first(templates),
    exportId: first(exports),
    service: 'sms',
    flagId: undefined,
  } as Record<string, string | undefined>;
}

/** Substitutes {param} placeholders, and reports any it could not fill. */
function fillPath(path: string, ids: Record<string, string | undefined>) {
  const missing: string[] = [];
  const filled = path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const specific =
      name === 'id' && path.includes('/documents')
        ? (ids.documentReviewId ?? ids.senderIdReviewId)
        : name === 'id' && path.includes('/sender-ids/')
          ? ids.senderIdReviewId
          : name === 'id' && path.includes('/credit-adjustments/')
            ? ids.adjustmentId
            : name === 'id' && path.includes('/campaigns/')
              ? ids.campaignId
              : name === 'id' && path.includes('/exports/')
                ? ids.exportId
                : name === 'id' && path.includes('/staff/')
                  ? ids.staffId
                  : ids[name];
    if (!specific) missing.push(name);
    return specific ?? `{${name}}`;
  });
  return { filled, missing };
}

/** Query defaults that make a sampled response non-empty. */
function defaultQuery(path: string): string {
  const to = DateTime.now().setZone('Africa/Lagos').toISODate();
  const from = DateTime.now()
    .setZone('Africa/Lagos')
    .minus({ days: 30 })
    .toISODate();
  const needsRange = /overview|finance|services|geo|usage/.test(path);
  return needsRange ? `?from=${from}&to=${to}` : '';
}

/** Long arrays are trimmed: an example is for shape, not for bulk. */
function trim(value: unknown, depth = 0): unknown {
  if (Array.isArray(value))
    return value.slice(0, 2).map((v) => trim(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        trim(v, depth + 1),
      ]),
    );
  }
  return value;
}

/**
 * A readable table of every write endpoint's accepted fields, rendered from the same
 * document the service serves, so the two cannot disagree.
 */
function renderPayloadReference(spec: {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components?: { schemas?: Record<string, JsonSchema> };
}): string {
  const schemas = spec.components?.schemas ?? {};

  const resolve = (schema: JsonSchema): JsonSchema =>
    schema.$ref ? (schemas[schema.$ref.split('/').pop()!] ?? {}) : schema;

  const describe = (schema: JsonSchema): string[] => {
    const resolved = resolve(schema);
    const required = new Set(resolved.required ?? []);
    return Object.entries(resolved.properties ?? {}).map(([name, prop]) => {
      let type = `\`${prop.type ?? 'object'}\``;
      if (prop.enum) type = prop.enum.map((v) => `\`${v}\``).join(' \\| ');
      else if (prop.type === 'array') {
        const item = prop.items ?? {};
        const inner = item.$ref
          ? item.$ref.split('/').pop()!
          : (item.type ?? 'object');
        type = `\`${inner}[]\``;
      }
      const notes: string[] = [];
      if (prop.minLength !== undefined) notes.push(`min ${prop.minLength}`);
      if (prop.maxLength !== undefined) notes.push(`max ${prop.maxLength}`);
      if (prop.description) notes.push(prop.description.split('\n')[0].trim());
      const need = required.has(name) ? 'required' : 'optional';
      return `| \`${name}\` | ${type} | ${need} | ${notes.join(' · ')} |`;
    });
  };

  const byTag = new Map<string, string[]>();
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (!['post', 'patch', 'delete'].includes(method)) continue;
      const op = operation as {
        tags?: string[];
        requestBody?: { content: Record<string, { schema: JsonSchema }> };
      };
      if (!op.requestBody) continue;

      const rows = describe(op.requestBody.content['application/json'].schema);
      const heading = `**\`${method.toUpperCase()} ${path.replace('/admin/v1', '')}\`**`;
      const table = rows.length
        ? [
            '',
            '| Field | Type | | Notes |',
            '| --- | --- | --- | --- |',
            ...rows,
            '',
          ].join('\n')
        : '\n_No body._\n';

      const tag = op.tags?.[0] ?? 'Other';
      byTag.set(tag, [...(byTag.get(tag) ?? []), heading + table]);
    }
  }

  const header = [
    '# Request payloads',
    '',
    '<!-- Generated by `npm run docs:generate`. Do not edit by hand. -->',
    '',
    'Every write endpoint and the exact fields it accepts.',
    '',
    '**Unknown fields are rejected with `400`**, so send only what is listed. Money is a',
    'decimal string (`"5000"`, not `5000`). Dates are `YYYY-MM-DD` in Africa/Lagos.',
    '',
    'Two headers apply broadly and are not repeated per row:',
    '',
    '- `x-csrf-token` on every non-GET request, read from `/auth/me`.',
    '- `Idempotency-Key` on the idempotent write routes — one UUID per user intent,',
    '  reused on every retry of that intent.',
    '',
    'The browsable version is at `/admin/v1/docs`; `/admin/v1/docs-json` is the OpenAPI',
    'document to generate types from.',
    '',
  ].join('\n');

  const sections = [...byTag.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, entries]) => `## ${tag}\n\n${entries.join('\n')}`);

  return `${header}\n${sections.join('\n')}\n`;
}

interface JsonSchema {
  $ref?: string;
  type?: string;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema & { description?: string }>;
  required?: string[];
  minLength?: number;
  maxLength?: number;
  description?: string;
}

async function main() {
  await signIn();
  const ids = await discoverIds();

  const spec = (await (await fetch(`${API}/docs-json`)).json()) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };

  let captured = 0;
  let skipped = 0;
  const unfilled = new Set<string>();

  for (const [path, methods] of Object.entries(spec.paths)) {
    const operation = methods.get;
    if (!operation) continue;
    if (SKIP.some((re) => re.test(path))) {
      skipped += 1;
      continue;
    }

    const apiPath = path.replace('/admin/v1', '');
    const { filled, missing } = fillPath(apiPath, ids);
    if (missing.length) {
      missing.forEach((m) => unfilled.add(`${apiPath} (${m})`));
      skipped += 1;
      continue;
    }

    const res = await fetch(`${API}${filled}${defaultQuery(filled)}`, {
      headers: { cookie: cookie() },
    });
    if (!res.ok) {
      skipped += 1;
      continue;
    }

    const body: unknown = await res.json();
    const responses = (operation.responses ??= {}) as Record<string, unknown>;
    responses['200'] = {
      description: 'Success',
      content: { 'application/json': { example: trim(body) } },
    };
    captured += 1;
  }

  writeFileSync('openapi.json', JSON.stringify(spec, null, 2));
  writeFileSync('docs/api-payloads.md', renderPayloadReference(spec));
  console.log(`Captured ${captured} response examples, skipped ${skipped}.`);
  if (unfilled.size) {
    console.log('No id available for:', [...unfilled].join(', '));
  }
  console.log('Wrote openapi.json');
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
