/** Queue and job names shared by the schedulers and the processors. */
export const QUEUES = {
  rollups: 'admin.rollups',
  events: 'admin.events',
  campaigns: 'admin.campaigns',
  exports: 'admin.exports',
  maintenance: 'admin.maintenance',
} as const;

export const JOBS = {
  rollUsageCurrentDay: 'roll-usage-current-day',
  finalisePreviousDay: 'finalise-previous-day',
  rollRequests: 'roll-requests',
  reconcile: 'reconcile',
  providerHealth: 'provider-health',
  riskScan: 'risk-scan',
  slaSweep: 'sla-sweep',
  retention: 'retention',
  partitions: 'ensure-partitions',
  geoipRefresh: 'geoip-refresh',
  eventSweep: 'event-sweep',
  processEvent: 'process-event',
  sendCampaign: 'send-campaign',
  runExport: 'run-export',
} as const;

/**
 * Deterministic job ids are used to deduplicate work across instances. BullMQ
 * reserves ':' for its own Redis keys and rejects it in a custom id, so build these
 * ids with '-' only.
 */

/** Defaults every job inherits: bounded retries with backoff, and a tidy queue. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Payloads the processors receive. BullMQ types `job.data` as `any` on its own. */
export interface DayJobData {
  /** ISO date (yyyy-mm-dd) of the Africa/Lagos day to process. */
  day: string;
}

export interface WindowJobData {
  windowMinutes?: number;
}

export interface EventJobData {
  eventId: string;
}

export interface CampaignJobData {
  campaignId: string;
}

export interface ExportJobData {
  exportId: string;
}
