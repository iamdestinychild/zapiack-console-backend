/**
 * The product lines the product database can actually report on: LogEventChannel is
 * EMAIL, SMS, WHATSAPP, VOICE and AUDIO. In-app notifications, face liveness, video
 * and mapping have no channel yet, so they are absent rather than listed as empty.
 *
 * One metrics module covers every product line, so a new service plugs in as a row
 * here rather than as a new screen. `channel` matches ChannelType in the Zapiack DB;
 * `specificMetrics` names what the service page shows beside the common figures.
 *
 * Common to every service: volume, success rate, failure reasons, latency p50/p95,
 * revenue, cost and profit.
 */
export interface ServiceDefinition {
  key: string;
  channel: string;
  label: string;
  unit: string;
  /** Computed from the `attributes` JSON on each usage row. */
  specificMetrics: {
    key: string;
    label: string;
    kind: 'sum' | 'avg' | 'rate';
    attribute?: string;
  }[];
  /** False until the service launches; the page renders as "not live yet". */
  live: boolean;
}

export const SERVICES: ServiceDefinition[] = [
  {
    key: 'sms',
    channel: 'SMS',
    label: 'SMS',
    unit: 'message',
    live: true,
    specificMetrics: [
      { key: 'delivered', label: 'Delivered', kind: 'sum' },
      {
        key: 'pages',
        label: 'Pages per message',
        kind: 'avg',
        attribute: 'pages',
      },
      {
        key: 'dlrLatencyMs',
        label: 'DLR latency',
        kind: 'avg',
        attribute: 'dlrLatencyMs',
      },
      {
        key: 'deliveryRateByNetwork',
        label: 'Delivery rate by network',
        kind: 'rate',
      },
    ],
  },
  {
    key: 'email',
    channel: 'EMAIL',
    label: 'Email',
    unit: 'message',
    live: true,
    specificMetrics: [
      {
        key: 'hardBounces',
        label: 'Hard bounces',
        kind: 'sum',
        attribute: 'hardBounce',
      },
      {
        key: 'softBounces',
        label: 'Soft bounces',
        kind: 'sum',
        attribute: 'softBounce',
      },
      {
        key: 'complaints',
        label: 'Complaint rate',
        kind: 'rate',
        attribute: 'complaint',
      },
      {
        key: 'opens',
        label: 'Open rate where tracked',
        kind: 'rate',
        attribute: 'opened',
      },
    ],
  },
  {
    key: 'whatsapp',
    channel: 'WHATSAPP',
    label: 'WhatsApp',
    unit: 'conversation',
    live: false,
    specificMetrics: [
      {
        key: 'category',
        label: 'Conversations by category',
        kind: 'sum',
        attribute: 'category',
      },
      { key: 'read', label: 'Read', kind: 'sum', attribute: 'read' },
      {
        key: 'templateApprovalRate',
        label: 'Template approval rate',
        kind: 'rate',
        attribute: 'templateApproved',
      },
    ],
  },
  {
    key: 'voice',
    channel: 'VOICE',
    label: 'Voice and audio',
    unit: 'call',
    live: false,
    specificMetrics: [
      {
        key: 'answeredRate',
        label: 'Answered rate',
        kind: 'rate',
        attribute: 'answered',
      },
      {
        key: 'billedMinutes',
        label: 'Billed minutes',
        kind: 'sum',
        attribute: 'billedMinutes',
      },
      {
        key: 'avgDurationSeconds',
        label: 'Average call duration',
        kind: 'avg',
        attribute: 'durationSeconds',
      },
      {
        key: 'ttsCharacters',
        label: 'TTS characters',
        kind: 'sum',
        attribute: 'ttsCharacters',
      },
    ],
  },
  {
    key: 'audio',
    channel: 'AUDIO',
    label: 'Video',
    unit: 'session',
    live: false,
    specificMetrics: [
      {
        key: 'participantMinutes',
        label: 'Participant minutes',
        kind: 'sum',
        attribute: 'participantMinutes',
      },
      {
        key: 'avgSessionSeconds',
        label: 'Average session length',
        kind: 'avg',
        attribute: 'durationSeconds',
      },
      {
        key: 'failedJoins',
        label: 'Failed joins',
        kind: 'sum',
        attribute: 'failedJoins',
      },
    ],
  },
];

export const SERVICE_BY_KEY = new Map(SERVICES.map((s) => [s.key, s]));
