# Segments and in-app campaigns: what the console sends and shows

A **campaign** is one message to an **audience**. For `IN_APP` it appears in each customer's
notification bell, and the bell updates live if they have the dashboard open.

All routes are under `/admin/v1`. Writes need the usual `x-csrf-token` and an `Idempotency-Key`.

## The flow

```
create (DRAFT) ──▶ [approve, only if the audience is large] ──▶ send now / schedule ──▶ SENDING ──▶ SENT
                                                                                                  └─▶ FAILED (nobody got it)
SENT or FAILED, with failures ──▶ retry ──▶ SCHEDULED ──▶ SENDING ──▶ SENT
```

| Step | Route | Permission |
|---|---|---|
| Create | `POST /campaigns` | `notifications.send` |
| Approve | `POST /campaigns/:id/approve` `{ "reason" }` | `notifications.broadcast`, super admin |
| Send now | `POST /campaigns/:id/send` | `notifications.send` |
| Schedule | `POST /campaigns/:id/schedule` `{ "scheduledAt": "<ISO time>" }` | `notifications.send` |
| Retry failures | `POST /campaigns/:id/retry` | `notifications.send` |
| Cancel | `POST /campaigns/:id/cancel` `{ "reason" }` | `notifications.send` |
| Read | `GET /campaigns`, `GET /campaigns/:id` | `notifications.send` |

**Approval.** A campaign reaching more than 1,000 accounts (`BROADCAST_APPROVAL_THRESHOLD`) has
`requiresApproval: true` and cannot be sent or scheduled until a super admin approves it. A
different super admin must approve it, unless the author is the **only** active super admin,
in which case they may approve their own (the audit log records `selfApproved`). Sending an
unapproved large campaign answers 403.

## Create a campaign

```jsonc
POST /campaigns
{
  "name": "October product update",          // internal name
  "channel": "IN_APP",                        // IN_APP | EMAIL | SMS
  "subject": "Hi {{account.businessName}}",   // the notification's title (required for EMAIL)
  "body": "We have added template review.",   // supports {{account.businessName}}
  "audienceKind": "SEGMENT",                  // SEGMENT | ACCOUNT_LIST | SINGLE_ACCOUNT
  "segmentId": "…"                            // for SEGMENT
  // "accountIds": ["…"]                      // for ACCOUNT_LIST / SINGLE_ACCOUNT
}
```

The response has `recipientCount` (who it would reach now) and `requiresApproval`. The audience
is resolved again at send time, so it reaches whoever matches then.

**Sending to everyone:** use the built-in segment **"All customers"** (`GET /segments`, it is
there from the start). **"Active customers"** is also built in. Both can be edited or renamed.

## Segments

`GET /segments` · `POST /segments` `{ name, description?, filter }` · `POST /segments/preview` *(the body is the filter itself)*

Every field is optional, fields combine with AND, and `{}` means every account.

| Field | Meaning |
|---|---|
| `statuses` | `ACTIVE`, `PAST_DUE`, `PROBATION`, `SUSPENDED`, `CANCELED`, `BANNED` |
| `countries` | account country codes, e.g. `["NG","GH"]` |
| `planIds` | accounts on any of these plans (active subscriptions) |
| `creditsBelow` | credit balance below this many **credits** (not naira) |
| `inactiveForDays` | nothing sent in this many days; includes accounts that never sent |
| `usedChannel` | has sent on `EMAIL`, `SMS`, `WHATSAPP`, `VOICE` or `AUDIO` |
| `emailVerified` | the owner's email is verified, `true` or `false` |

Not supported, and refused with a message: **`kycVerified`** (the product records no KYC; use
`emailVerified`), and a `status` outside the list above (there is no `CLOSED`).
`balanceBelowNgn` still works as an old name for `creditsBelow`; the balance is in credits.

`POST /segments/preview` returns `{ "estimatedSize": 5, "sample": [ { accountId, businessName, email (masked), phone } ] }`.
Show the size before anyone sends.

## What the customer gets

A row in their notification bell: type `NEWS`, severity `INFO`, the `subject` as the title and the
`body` as the text, unread, with `{{account.businessName}}` filled in. It is not clickable.
It reaches the **account owner**; teammates on the account do not receive it.

## Reading a campaign

`GET /campaigns/:id` has `status`, `recipientCount`, `sentCount`, `failedCount` and `delivery`
(a count per recipient status: `PENDING`, `SENT`, `FAILED`).

- `SENT` with `failedCount > 0`: it went out, but some recipients failed. Offer **Retry**.
- `FAILED`: it reached nobody. Offer **Retry** once the cause is fixed.
- Counts are recounted from the recipients, so they stay right after a retry.

## Errors worth handling

| Status | When |
|---|---|
| 400 | a segment filter with an unknown or unsupported field (the message says which) |
| 403 | large audience not yet approved; or approving your own campaign when another super admin exists |
| 409 | retry when nothing failed, or when the campaign is not finished; scheduling a campaign that already started |
| 429 | too many requests in a minute: back off, do not poll faster than every couple of seconds |

## Other channels

- **EMAIL** campaigns send through AWS SES and fail until the AWS credentials are set on admin-core.
- **SMS** campaigns cannot be addressed: the product stores no phone number for an account.
