-- CreateEnum
CREATE TYPE "StaffStatus" AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "RiskFlagType" AS ENUM ('VOLUME_SPIKE', 'HIGH_FAILURE_RATE', 'MANY_DESTINATION_COUNTRIES', 'MANY_SIGNIN_COUNTRIES', 'SMS_PUMPING_SUSPECTED', 'PAYMENT_FAILURE_SPIKE', 'MANUAL');

-- CreateEnum
CREATE TYPE "RiskSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RiskSource" AS ENUM ('AUTOMATIC', 'MANUAL');

-- CreateEnum
CREATE TYPE "AdjustmentDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'APPLIED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReconciliationKind" AS ENUM ('PAYSTACK_SETTLEMENT', 'PROVIDER_INVOICE');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('OK', 'VARIANCE', 'FAILED');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SignInSurface" AS ENUM ('CUSTOMER_APP', 'ADMIN_CONSOLE');

-- CreateEnum
CREATE TYPE "SenderIdStatus" AS ENUM ('SUBMITTED', 'IN_REVIEW', 'CHANGES_REQUESTED', 'REJECTED', 'APPROVED', 'SUBMITTED_TO_OPERATORS', 'ACTIVE', 'OPERATOR_REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "AudienceKind" AS ENUM ('SINGLE_ACCOUNT', 'ACCOUNT_LIST', 'SEGMENT');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RecipientStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('HEALTHY', 'DEGRADED', 'OUTAGE');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[],
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "StaffStatus" NOT NULL DEFAULT 'ACTIVE',
    "roleId" TEXT NOT NULL,
    "extraPermissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "lastLoginIp" TEXT,
    "sessionEpoch" INTEGER NOT NULL DEFAULT 0,
    "emailNotificationPrefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_invites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_sessions" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "country" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absoluteExpiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_sessions" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "impersonation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorEmail" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER,
    "responseBody" JSONB,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_notes" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tags" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_flags" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" "RiskFlagType" NOT NULL,
    "severity" "RiskSeverity" NOT NULL DEFAULT 'MEDIUM',
    "source" "RiskSource" NOT NULL DEFAULT 'AUTOMATIC',
    "summary" TEXT NOT NULL,
    "evidence" JSONB,
    "raisedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_costs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "country" TEXT,
    "network" TEXT,
    "unitCostNgn" DECIMAL(19,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "margin_targets" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "targetMargin" DECIMAL(5,4) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "margin_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_adjustments" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" "AdjustmentDirection" NOT NULL,
    "amountNgn" DECIMAL(19,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "idempotencyKey" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedReason" TEXT,
    "ledgerTxnId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "credit_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_rollups" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "planId" TEXT,
    "country" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "provider" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "attempted" BIGINT NOT NULL DEFAULT 0,
    "succeeded" BIGINT NOT NULL DEFAULT 0,
    "failed" BIGINT NOT NULL DEFAULT 0,
    "units" BIGINT NOT NULL DEFAULT 0,
    "revenueNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "costNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "latencyP50Ms" INTEGER,
    "latencyP95Ms" INTEGER,
    "finalisedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usage_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_rollups" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "collectedNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "refundedNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "feesNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "paymentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_snapshots" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "subscriptionRevenueNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "creditLiabilityNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "mrrNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "activeAccounts" INTEGER NOT NULL DEFAULT 0,
    "newAccounts" INTEGER NOT NULL DEFAULT 0,
    "activatedAccounts" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "finance_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_rollups" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "hour" INTEGER NOT NULL,
    "accountId" TEXT,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "total" BIGINT NOT NULL DEFAULT 0,
    "clientErrors" BIGINT NOT NULL DEFAULT 0,
    "serverErrors" BIGINT NOT NULL DEFAULT 0,
    "latencyP50Ms" INTEGER,
    "latencyP95Ms" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "request_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rollup_watermarks" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "processedTo" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,

    CONSTRAINT "rollup_watermarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "kind" "ReconciliationKind" NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'OK',
    "expectedNgn" DECIMAL(19,4) NOT NULL,
    "actualNgn" DECIMAL(19,4) NOT NULL,
    "variancePct" DECIMAL(9,6) NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "containsPii" BOOLEAN NOT NULL DEFAULT false,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "rowCount" INTEGER,
    "objectKey" TEXT,
    "expiresAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "request_logs" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT,
    "apiKeyId" TEXT,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "requestId" TEXT,

    CONSTRAINT "request_logs_pkey" PRIMARY KEY ("id","occurredAt")
);

-- CreateTable
CREATE TABLE "signin_events" (
    "id" TEXT NOT NULL,
    "surface" "SignInSurface" NOT NULL,
    "accountId" TEXT,
    "userId" TEXT,
    "staffId" TEXT,
    "email" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "ip" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signin_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "destination_rollups" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "channel" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "network" TEXT,
    "attempted" BIGINT NOT NULL DEFAULT 0,
    "delivered" BIGINT NOT NULL DEFAULT 0,
    "costNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "destination_rollups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_id_reviews" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "status" "SenderIdStatus" NOT NULL DEFAULT 'SUBMITTED',
    "assigneeId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sender_id_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_id_review_events" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "fromStatus" "SenderIdStatus",
    "toStatus" "SenderIdStatus" NOT NULL,
    "actorId" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sender_id_review_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sender_id_checklist_items" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "passed" BOOLEAN,
    "note" TEXT,
    "checkedBy" TEXT,
    "checkedAt" TIMESTAMP(3),

    CONSTRAINT "sender_id_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filter" JSONB NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_templates" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "templateId" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "audienceKind" "AudienceKind" NOT NULL,
    "segmentId" TEXT,
    "accountIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "internalCostNgn" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_recipients" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "destination" TEXT,
    "status" "RecipientStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "failureReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "campaign_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_notifications" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "RiskSeverity" NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_health_samples" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "attempted" BIGINT NOT NULL DEFAULT 0,
    "delivered" BIGINT NOT NULL DEFAULT 0,
    "failed" BIGINT NOT NULL DEFAULT 0,
    "avgDlrLatencyMs" INTEGER,
    "errorRate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "status" "ProviderStatus" NOT NULL DEFAULT 'HEALTHY',

    CONSTRAINT "provider_health_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingested_events" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "EventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "ingested_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "roles_key_key" ON "roles"("key");

-- CreateIndex
CREATE UNIQUE INDEX "staff_email_key" ON "staff"("email");

-- CreateIndex
CREATE INDEX "staff_status_idx" ON "staff"("status");

-- CreateIndex
CREATE UNIQUE INDEX "staff_invites_tokenHash_key" ON "staff_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "staff_invites_email_idx" ON "staff_invites"("email");

-- CreateIndex
CREATE INDEX "staff_sessions_staffId_revokedAt_idx" ON "staff_sessions"("staffId", "revokedAt");

-- CreateIndex
CREATE INDEX "login_attempts_email_createdAt_idx" ON "login_attempts"("email", "createdAt");

-- CreateIndex
CREATE INDEX "impersonation_sessions_accountId_idx" ON "impersonation_sessions"("accountId");

-- CreateIndex
CREATE INDEX "audit_log_actorId_createdAt_idx" ON "audit_log"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_targetType_targetId_createdAt_idx" ON "audit_log"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_action_createdAt_idx" ON "audit_log"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_key_staffId_route_key" ON "idempotency_records"("key", "staffId", "route");

-- CreateIndex
CREATE INDEX "customer_notes_accountId_createdAt_idx" ON "customer_notes"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tags_accountId_tag_key" ON "customer_tags"("accountId", "tag");

-- CreateIndex
CREATE INDEX "risk_flags_accountId_resolvedAt_idx" ON "risk_flags"("accountId", "resolvedAt");

-- CreateIndex
CREATE INDEX "risk_flags_type_createdAt_idx" ON "risk_flags"("type", "createdAt");

-- CreateIndex
CREATE INDEX "provider_costs_channel_provider_effectiveFrom_idx" ON "provider_costs"("channel", "provider", "effectiveFrom");

-- CreateIndex
CREATE INDEX "margin_targets_channel_effectiveFrom_idx" ON "margin_targets"("channel", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "credit_adjustments_idempotencyKey_key" ON "credit_adjustments"("idempotencyKey");

-- CreateIndex
CREATE INDEX "credit_adjustments_accountId_createdAt_idx" ON "credit_adjustments"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "credit_adjustments_status_createdAt_idx" ON "credit_adjustments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "usage_rollups_date_channel_idx" ON "usage_rollups"("date", "channel");

-- CreateIndex
CREATE INDEX "usage_rollups_accountId_date_idx" ON "usage_rollups"("accountId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "usage_rollups_date_hour_channel_accountId_country_provider_key" ON "usage_rollups"("date", "hour", "channel", "accountId", "country", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "cash_rollups_date_key" ON "cash_rollups"("date");

-- CreateIndex
CREATE UNIQUE INDEX "finance_snapshots_date_key" ON "finance_snapshots"("date");

-- CreateIndex
CREATE INDEX "request_rollups_date_country_idx" ON "request_rollups"("date", "country");

-- CreateIndex
CREATE UNIQUE INDEX "request_rollups_date_hour_accountId_endpoint_method_country_key" ON "request_rollups"("date", "hour", "accountId", "endpoint", "method", "country");

-- CreateIndex
CREATE UNIQUE INDEX "rollup_watermarks_job_key" ON "rollup_watermarks"("job");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_runs_date_kind_key" ON "reconciliation_runs"("date", "kind");

-- CreateIndex
CREATE INDEX "export_jobs_requestedById_createdAt_idx" ON "export_jobs"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "request_logs_occurredAt_idx" ON "request_logs"("occurredAt");

-- CreateIndex
CREATE INDEX "request_logs_accountId_occurredAt_idx" ON "request_logs"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "request_logs_country_occurredAt_idx" ON "request_logs"("country", "occurredAt");

-- CreateIndex
CREATE INDEX "signin_events_accountId_occurredAt_idx" ON "signin_events"("accountId", "occurredAt");

-- CreateIndex
CREATE INDEX "signin_events_occurredAt_idx" ON "signin_events"("occurredAt");

-- CreateIndex
CREATE INDEX "destination_rollups_date_country_idx" ON "destination_rollups"("date", "country");

-- CreateIndex
CREATE UNIQUE INDEX "destination_rollups_date_channel_accountId_country_network_key" ON "destination_rollups"("date", "channel", "accountId", "country", "network");

-- CreateIndex
CREATE UNIQUE INDEX "sender_id_reviews_applicationId_key" ON "sender_id_reviews"("applicationId");

-- CreateIndex
CREATE INDEX "sender_id_reviews_status_slaDueAt_idx" ON "sender_id_reviews"("status", "slaDueAt");

-- CreateIndex
CREATE INDEX "sender_id_reviews_assigneeId_status_idx" ON "sender_id_reviews"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "sender_id_review_events_reviewId_createdAt_idx" ON "sender_id_review_events"("reviewId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sender_id_checklist_items_reviewId_key_key" ON "sender_id_checklist_items"("reviewId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "segments_name_key" ON "segments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "notification_templates_key_key" ON "notification_templates"("key");

-- CreateIndex
CREATE INDEX "campaigns_status_scheduledAt_idx" ON "campaigns"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "campaign_recipients_campaignId_status_idx" ON "campaign_recipients"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_recipients_campaignId_accountId_key" ON "campaign_recipients"("campaignId", "accountId");

-- CreateIndex
CREATE INDEX "staff_notifications_staffId_readAt_createdAt_idx" ON "staff_notifications"("staffId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "provider_health_samples_channel_windowStart_idx" ON "provider_health_samples"("channel", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "provider_health_samples_provider_channel_windowStart_key" ON "provider_health_samples"("provider", "channel", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "ingested_events_eventId_key" ON "ingested_events"("eventId");

-- CreateIndex
CREATE INDEX "ingested_events_status_receivedAt_idx" ON "ingested_events"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "ingested_events_type_receivedAt_idx" ON "ingested_events"("type", "receivedAt");

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_adjustments" ADD CONSTRAINT "credit_adjustments_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_adjustments" ADD CONSTRAINT "credit_adjustments_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_id_reviews" ADD CONSTRAINT "sender_id_reviews_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_id_review_events" ADD CONSTRAINT "sender_id_review_events_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "sender_id_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sender_id_checklist_items" ADD CONSTRAINT "sender_id_checklist_items_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "sender_id_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "notification_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_notifications" ADD CONSTRAINT "staff_notifications_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
