# Template review: endpoints for the console

Customers write email templates and submit them. A template can only be **sent** once it is
`APPROVED`, so the review queue is a list of customers waiting.

```
DRAFT ──customer submits──▶ SUBMITTED ──automated checks──▶ APPROVED      (clean)
                                          │                  IN_REVIEW     (flagged: a person decides)
                                          └─────────────────▶ REJECTED     (hard fail, e.g. a <script> tag)
IN_REVIEW / DRAFT ──reviewer──▶ APPROVED or REJECTED
APPROVED ──reviewer revokes──▶ REJECTED
```

All routes are under `/admin/v1/templates`, need the **`templates.review`** permission, and use
the usual session cookie. Writes also need the `x-csrf-token` header and an `Idempotency-Key`
(one per button press, reused on retry).

## List

`GET /templates?status=PENDING&q=&limit=50&cursor=`

| `status` | Shows |
|---|---|
| `PENDING` (default) | `SUBMITTED` and `IN_REVIEW`, **oldest submission first** |
| `DRAFT` | templates customers have not submitted yet |
| `APPROVED`, `REJECTED`, `SUBMITTED`, `IN_REVIEW` | that status, newest first |
| `ALL` | everything |

`q` matches name, slug, subject, template id, account id and project name.

```jsonc
{
  "counts": { "DRAFT": 4, "SUBMITTED": 1, "IN_REVIEW": 3, "APPROVED": 120, "REJECTED": 9, "PENDING": 4 },
  "countsCapped": [],            // statuses whose count hit 200: show "200+" for these
  "data": [
    {
      "id": "…", "templateId": "…", "name": "Welcome", "slug": "welcome",
      "category": "TRANSACTIONAL",            // TRANSACTIONAL | MARKETING | AUTHENTICATION
      "subject": "Hello {{name}}",
      "status": "IN_REVIEW",
      "accountId": "…", "project": { "id": "…", "name": "Shop" },
      "flags": ["Uses a link shortener, which hides the destination"],   // what the automated check found
      "rejectionReason": null,
      "submittedAt": "…", "reviewedAt": null, "createdAt": "…", "updatedAt": "…"
    }
  ],
  "hasMore": false, "nextCursor": null
}
```

Use `counts` for the tab badges. `PENDING` is the sum of `SUBMITTED` and `IN_REVIEW`.

## One template

`GET /templates/:id` (the `id`, or the customer-facing `templateId`)

Everything above, plus:

| Field | Meaning |
|---|---|
| `html` | the customer's template body, or `null` if they have not written one |
| `variables` | the `{{placeholders}}` the body expects |
| `hasContent` | `html` is non-empty |
| `allowedActions` | **offer exactly these buttons**: any of `"approve"`, `"reject"`, `"revoke"` |
| `approvalSkipsChecks` | `true` for a draft: approving it skips the customer's own submit and the automated checks. Show a confirmation saying so. |

> **`html` is untrusted customer input.** Render it only in a sandboxed iframe:
> `<iframe sandbox="" srcDoc={html} />`. Never inject it into the page with
> `dangerouslySetInnerHTML`, and never relax `sandbox`. The `{{placeholders}}` appear as
> literal text, which is correct for a review.

## Decide

All three take `{ "reason": "…" }` (8 to 1000 characters, always required, written to the audit log).

| Route | Allowed when | Effect |
|---|---|---|
| `POST /templates/:id/approve` | `DRAFT`, `SUBMITTED`, `IN_REVIEW`, or `REJECTED` (overturns it), and the template has a body | customer can now send it |
| `POST /templates/:id/reject` | `DRAFT`, `SUBMITTED` or `IN_REVIEW` | refused; **the reason is shown to the customer** |
| `POST /templates/:id/revoke` | `APPROVED` only | approval withdrawn; **the reason is shown to the customer** |

```jsonc
{ "id": "…", "templateId": "…", "status": "REJECTED", "previousStatus": "IN_REVIEW",
  "rejectionReason": "Asks customers to verify their card number", "reviewedAt": "…" }
```

For reject and revoke, write the reason for the customer, not for staff. For approve it is
kept in the audit log only.

After a decision the customer's dashboard updates by itself. Refetch the list and the counts.

## Errors the screen should handle

| Status | When | Show |
|---|---|---|
| 400 | reason too short; approving a draft with no body | the `message` |
| 409 | already approved / already rejected / `reject` on an approved template (use revoke) / `revoke` on one that is not approved | the `message`, then refetch: someone else may have just decided |
| 404 | template deleted by the customer meanwhile | the `message`, then drop the row |
| 403 | the staff member lacks `templates.review` | hide the screen (check `permissions` from `/auth/me`) |
| 502 / 503 | api-core unreachable or not configured | "Review is temporarily unavailable" |

## Who can review

`templates.review` is on the **super admin** role automatically, and on **Compliance** for new
installs. To give it to an existing role, add it in the console under Staff → Roles, or as an
extra permission on one staff member.

## Operator notes

admin-core makes these calls to api-core's `admin/templates` routes with a shared key.
Set on admin-core, matching the main app's `ADMIN_API_KEY`:

```
API_CORE_ADMIN_KEY=<the same value as ADMIN_API_KEY in the main app>
API_CORE_ADMIN_BASE_URL=http://api-core:3001/v1      # the default on the droplet
```

Without the key the endpoints answer 503 and nothing else is affected. The list shows up to
200 templates per status (api-core's page size); `countsCapped` says when a count is a floor.
