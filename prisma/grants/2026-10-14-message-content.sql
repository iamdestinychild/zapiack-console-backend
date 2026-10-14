-- Run once on the live product database, as the owner, to let the console's Messages
-- screen read what customers send. (A fresh install gets this from zapiack-roles.sql.)

GRANT SELECT (content, recipient) ON log_events TO admin_reader;

GRANT SELECT (id, "accountId", "projectId", "from", "replyTo", subject, html, text,
              "templateId", variables, status, "createdAt")
  ON mail_events TO admin_reader;

GRANT SELECT (id, "accountId", "projectId", name, "verificationStatus")
  ON templates TO admin_reader;
