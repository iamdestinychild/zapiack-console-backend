# Sender ID review: statuses and endpoints for the console

A sender ID application has **four statuses**, the same four the customer app uses. The console
shows exactly these and nothing else.

| Status | Meaning | Reviewer can |
|---|---|---|
| `DRAFT` | The customer started it and has not submitted | nothing (read-only) |
| `PENDING_REVIEW` | Submitted and waiting | approve or reject |
| `APPROVED` | The project sends under its own sender ID | reject (withdraws the approval) |
| `REJECTED` | Refused, with a reason. The customer can edit it and submit again | approve (overturns the refusal) |

There is no "submitted", "in review", "changes requested" or "active". A reviewer picking an
application up is the **assignee**, not a status. "Changes requested" is a rejection whose reason
says what to change; the customer can already edit and resubmit a rejected application.

## The queue

`GET /sender-ids?status=PENDING_REVIEW&q=&assigneeId=&overdueOnly=&limit=50&cursor=`

`status` is `PENDING_REVIEW`, `APPROVED`, `REJECTED` or `DRAFT`. Leave it out for everything with a
review (not drafts). The old `SUBMITTED` and `IN_REVIEW` are still accepted and mean `PENDING_REVIEW`.

```jsonc
{
  "counts": { "PENDING_REVIEW": 9, "APPROVED": 4, "REJECTED": 2, "DRAFT": 6, "OVERDUE": 3 },
  "data": [{
    "id": "…",                      // the review id; open it with GET /sender-ids/:id
    "applicationId": "…", "accountId": "…", "senderId": "KANOLOG",
    "status": "PENDING_REVIEW",
    "assignee": { "id": "…", "name": "…" },   // null when nobody has picked it up
    "submittedAt": "…", "slaDueAt": "…",
    "overdue": false,                // only a waiting application can be overdue
    "hoursRemaining": 18             // null once decided
  }],
  "hasMore": false, "nextCursor": null
}
```

Use `counts` for the tab badges. **To separate pending from the rest, filter on `status`.**
`OVERDUE` is waiting applications past their 24-hour target.

### Drafts

`GET /sender-ids?status=DRAFT` (also `GET /sender-ids/drafts`). A draft has no review, so `id` is
`null` and there is nothing to open or decide:

```jsonc
{ "id": null, "applicationId": "…", "senderId": "KANOOPS", "businessName": "…",
  "status": "DRAFT", "category": "TRANSACTIONAL", "companyType": "COMPANY",
  "cacStatus": "UNVERIFIED", "createdAt": "…", "updatedAt": "…" }
```

## One application

`GET /sender-ids/:id`

| Block | Contents |
|---|---|
| `review` | `status`, `assignee`, `assigned`, `submittedAt`, `slaDueAt`, `overdue`, `decidedAt`, `decisionReason`, **`allowedDecisions`** (offer exactly these buttons) |
| `application` | `senderId`, `status`, `businessName`, `cacRegNo`, `rejectionReason`, `project`, plus what the applicant declared: `category`, `companyType`, `businessActivity`, `applicantName`, `designation`, `messageExamples`, `companyAddress`, `incorporatedAt`, `attestedAt`, `lettersGeneratedAt` |
| `application.cac` | what CAC's registry said: `status`, `verifiedAt`, `attempts`, `failureReason`, `data` |
| `account` | owner name, status, credit balance |
| `documents` | metadata only; fetch a file through the document URL endpoint |
| `checklist`, `history`, `otherApplications` | statuses inside are the same four |

**CAC status** (`application.cac.status`): `VERIFIED` (company and signatory confirmed),
`NEEDS_REVIEW` (company found but the name or signatory did not match: the reviewer decides),
`FAILED` (no such registration, see `failureReason`), `UNVERIFIED`. Highlight `NEEDS_REVIEW`.

## Decide

`POST /sender-ids/:id/decision` with `{ "status": "APPROVED" | "REJECTED", "reason": "…" }`

- **Reject needs a `reason`** (8 to 1000 characters). The customer is shown it.
- **Approve needs the checklist complete.** `POST /sender-ids/:id/checklist` with `{ items: [{ key, passed, note? }] }`.
- `status: "CHANGES_REQUESTED"` is still accepted and is recorded as a rejection ("Changes requested: …").

Approving takes effect straight away: the customer's project switches to its own sender ID, and
their notification bell updates live. Rejecting tells them why, in the same moment.

| Status | When |
|---|---|
| 400 | reject without a reason; approve with the checklist incomplete or failed |
| 409 | already approved / already rejected; **or the customer changed it since the screen loaded** (for example they resubmitted). Refetch and review again |

**Resubmission.** When a customer edits a rejected application and submits it again, it returns to
`PENDING_REVIEW` within ten minutes with a fresh 24-hour clock, nobody assigned and a reset
checklist, and the history records "Resubmitted by the customer".

## Assigning

`POST /sender-ids/:id/assign` with `{ "assigneeId"? }` (omit to take it yourself). This is only the
console's own bookkeeping; it does not change the application's status anywhere.
