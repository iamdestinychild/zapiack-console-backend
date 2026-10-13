#!/usr/bin/env node
/**
 * A stand-in for api-core's template review routes, for developing the console locally.
 *
 *   npm run dev:fake-templates
 *
 * It answers the same three routes as the real `admin/templates` controller, behind the
 * same `x-admin-key` check, with six sample templates covering every status. Decisions
 * are kept in memory and reset when it stops. Nothing here touches a real database, so
 * you can approve, reject and revoke freely without affecting a customer.
 *
 * Point admin-core at it in your local .env, then restart admin-core:
 *
 *   API_CORE_ADMIN_KEY=dev-admin-key
 *   API_CORE_ADMIN_BASE_URL=http://localhost:3099/v1
 *
 * Like the real api-core's decide(), it does not check the current status; admin-core
 * enforces the lifecycle before it ever calls.
 */
const http = require('node:http');

const KEY = process.env.API_CORE_ADMIN_KEY || 'dev-admin-key';
const PORT = Number(process.env.FAKE_API_CORE_PORT || 3099);
const now = new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

const template = (id, status, extra = {}) => ({
  id,
  templateId: `tpl_${id}`,
  name: `Template ${id}`,
  slug: `template-${id}`,
  category: 'TRANSACTIONAL',
  subject: `Subject for ${id}`,
  projectId: 'proj-1',
  variables: { name: 'string' },
  status,
  rejectionReason: null,
  reviewNotes: null,
  submittedAt: status === 'DRAFT' ? null : daysAgo(2),
  reviewedAt: null,
  createdAt: daysAgo(5),
  updatedAt: now,
  accountId: 'acc-demo-1',
  project: { id: 'proj-1', name: 'Demo shop' },
  html: '<h1>Hello {{name}}</h1><p>Thanks for your order.</p>',
  ...extra,
});

const db = [
  template('draft-ok', 'DRAFT'),
  template('draft-empty', 'DRAFT', { html: null }),
  template('submitted', 'SUBMITTED'),
  template('flagged', 'IN_REVIEW', {
    reviewNotes: 'Uses a link shortener, which hides the destination\nNo variables found; check the template is complete',
    html: '<p>Claim your prize: <a href="https://bit.ly/abc">https://example.com/win</a></p>',
  }),
  template('approved', 'APPROVED', { reviewedAt: daysAgo(1) }),
  template('rejected', 'REJECTED', {
    rejectionReason: 'Contains a <script> tag',
    reviewedAt: daysAgo(1),
  }),
];

const withoutBody = ({ html, ...rest }) => rest;

http
  .createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://localhost');

    if (req.headers['x-admin-key'] !== KEY) {
      return send(403, { message: 'Invalid admin credentials', error: 'Forbidden', statusCode: 403 });
    }

    if (req.method === 'GET' && url.pathname === '/v1/admin/templates/queue') {
      const status = url.searchParams.get('status') || 'IN_REVIEW';
      return send(200, db.filter((t) => t.status === status).map(withoutBody));
    }

    let m = url.pathname.match(/^\/v1\/admin\/templates\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const t = db.find((x) => x.id === m[1] || x.templateId === m[1]);
      return t ? send(200, t) : send(404, { message: 'Template not found', statusCode: 404 });
    }

    m = url.pathname.match(/^\/v1\/admin\/templates\/([^/]+)\/decision$/);
    if (req.method === 'POST' && m) {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const t = db.find((x) => x.id === m[1] || x.templateId === m[1]);
        if (!t) return send(404, { message: 'Template not found', statusCode: 404 });
        const { approve, reason } = JSON.parse(raw || '{}');
        if (!approve && !reason) return send(400, { message: 'A reason is required when rejecting', statusCode: 400 });
        t.status = approve ? 'APPROVED' : 'REJECTED';
        t.rejectionReason = approve ? null : reason;
        t.reviewedAt = new Date().toISOString();
        t.reviewedBy = url.searchParams.get('reviewer');
        t.updatedAt = t.reviewedAt;
        send(201, withoutBody(t));
      });
      return;
    }

    send(404, { message: 'No such route', statusCode: 404 });
  })
  .listen(PORT, () => {
    console.log(`fake api-core listening on http://localhost:${PORT}/v1  (admin key: ${KEY})`);
    console.log(`${db.length} sample templates: ${db.map((t) => t.id + '=' + t.status).join(', ')}`);
  });
