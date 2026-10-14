-- Least-privilege roles for admin-core on the PRODUCT database.
--
-- Run once, as the database owner, against the Zapiack product database (on Neon: the
-- SQL Editor, or psql with the owner's connection string). It creates two roles:
--
--   admin_reader  SELECT on only the tables and columns the console reads
--   admin_writer  everything admin_reader can do, plus the narrow writes the console makes
--
-- Replace the two passwords before running. Then build the connection strings:
--   ZAPIACK_READ_DATABASE_URL  = postgresql://admin_reader:<pw>@<host>/<db>?sslmode=require
--   ZAPIACK_WRITE_DATABASE_URL = postgresql://admin_writer:<pw>@<host>/<db>?sslmode=require
--
-- What is deliberately NOT granted, and why:
--   api_keys."keyHash"            the console shows a key's prefix, never its hash
--   (log_events."content"/recipient and mail_events were withheld at first. They are now
--   granted below, for the Messages screen: compliance has to see what a template is
--   really used to send. The console masks the recipient and audits each body it opens.)
--   transactions metadata/gatewayResponse/idempotencyKey/cardId/fx*   gateway internals
--   tab_transactions / transactions writes   the credit ledger belongs to api-core
--   cards, domains, otps, whatsapp_connections, webhook_events, sns_events,
--   email_verification_tokens, user_auth_providers   nothing in the console reads them
--
-- If the product schema gains a column the console starts to need, grant it here rather
-- than widening to the whole table.

CREATE ROLE admin_reader LOGIN PASSWORD 'CHANGE_ME_READER' NOINHERIT;
CREATE ROLE admin_writer LOGIN PASSWORD 'CHANGE_ME_WRITER' INHERIT;

GRANT USAGE ON SCHEMA public TO admin_reader, admin_writer;

-- ---------------------------------------------------------------- reads
GRANT SELECT ON
  users, accounts, projects, plans, subscriptions, account_billing, usage_buffer,
  products, product_pricing, tab_transactions, api_activity_logs,
  sender_id_applications, sender_id_documents, user_notifications
TO admin_reader;

GRANT SELECT (id, "accountId", "userId", "projectId", name, permission, "usageCount",
              "keyPrefix", "isActive", "isDeleted", "lastUsedAt", "expiresAt", "createdAt")
  ON api_keys TO admin_reader;

GRANT SELECT (id, "accountId", "projectId", channel, status, "requestId", "tabTransactionId",
              error, attempts, "senderId", operator, "countryCode", cost, metadata,
              content, recipient, "createdAt", "updatedAt")
  ON log_events TO admin_reader;

-- What an email was and what it said, for the Messages screen. Bodies are cleared by
-- api-core's retention job after RETENTION_EMAIL_BODY_DAYS.
GRANT SELECT (id, "accountId", "projectId", "from", "replyTo", subject, html, text,
              "templateId", variables, status, "createdAt")
  ON mail_events TO admin_reader;
GRANT SELECT (id, "accountId", "projectId", name, "verificationStatus")
  ON templates TO admin_reader;

GRANT SELECT (id, "accountId", "subscriptionId", type, amount, currency, status,
              description, reference, "createdAt", "creditedAt", "updatedAt")
  ON transactions TO admin_reader;

-- ---------------------------------------------------------------- writes
-- The writer reads through membership in the reader role, so it can never read more.
GRANT admin_reader TO admin_writer;

-- Catalogue: products, per-country credit cost, plans.
GRANT INSERT, UPDATE ON products, product_pricing, plans TO admin_writer;

-- Account status. Column-level, so the writer cannot touch creditBalance even if the
-- application were made to try. "updatedAt" is included because Prisma sets it on update.
GRANT UPDATE ("accountStatus", "updatedAt") ON accounts TO admin_writer;

GRANT UPDATE ("isActive")                  ON api_keys TO admin_writer;
GRANT UPDATE ("isDeleted", "updatedAt")    ON projects TO admin_writer;

-- Sender ID decisions, and the in-app notification that tells the applicant.
GRANT UPDATE (status, "rejectionReason", "reviewedAt", "updatedAt")
  ON sender_id_applications TO admin_writer;
GRANT INSERT ON user_notifications TO admin_writer;

-- Note: there is no INSERT or UPDATE on tab_transactions, transactions or
-- accounts."creditBalance". Credit adjustments go through api-core.

-- ---------------------------------------------------------------- website forms
-- What visitors typed into the contact, waitlist and newsletter forms on zapiack.com (table form_submissions, added by
-- zapiack-backend migration 20261013100000_form_submissions). The console lists them and triages them. The writer can
-- change only the status and the team's note, never the visitor's own words. Every value is written by a stranger, so the
-- console must show it as text.
GRANT SELECT ON form_submissions TO admin_reader;
GRANT UPDATE (status, note, "updatedAt") ON form_submissions TO admin_writer;
