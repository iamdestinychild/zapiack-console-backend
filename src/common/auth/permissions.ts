/**
 * Granular permission strings grouped by module. Roles are bundles of these stored
 * in the Admin DB, so adding a role is data, not a deploy. This file is the catalogue
 * the seed and the staff UI read from; it is not the authority on who has what.
 */
export const PERMISSIONS = {
  metrics: ['metrics.read'],
  customers: [
    'customers.read',
    'customers.manage',
    'customers.suspend',
    'customers.notes',
    'customers.impersonate',
  ],
  credits: ['credits.adjust', 'credits.approve'],
  pii: ['pii.reveal'],
  plans: ['plans.manage', 'pricing.manage'],
  finance: ['finance.read', 'finance.export'],
  geo: ['geo.view'],
  senderid: ['senderid.review', 'senderid.documents.download'],
  notifications: [
    'notifications.send',
    'notifications.broadcast',
    'notifications.segments',
  ],
  staff: ['staff.manage'],
  audit: ['audit.read'],
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS][number];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS).flat();

/** Actions that cannot proceed without a written reason, recorded in the audit log. */
export const REASON_REQUIRED_ACTIONS = new Set([
  'customers.suspend',
  'customers.impersonate',
  'senderid.reject',
  'senderid.request_changes',
  'pii.reveal',
  'credits.adjust',
]);

/** Role bundles shipped with the system. Editable afterwards from the console. */
export const SYSTEM_ROLES: Record<
  string,
  { name: string; description: string; permissions: Permission[] }
> = {
  super_admin: {
    name: 'Super admin',
    description:
      'Founder, CTO. Everything, including staff management, roles and pricing.',
    permissions: ALL_PERMISSIONS,
  },
  finance: {
    name: 'Finance',
    description:
      'Revenue, profit, ledger, exports, credit adjustments above threshold, refunds.',
    permissions: [
      'metrics.read',
      'customers.read',
      'finance.read',
      'finance.export',
      'credits.adjust',
      'credits.approve',
      'plans.manage',
      'pricing.manage',
      'pii.reveal',
      'audit.read',
    ],
  },
  support: {
    name: 'Support',
    description:
      'View customers, reveal masked PII with a reason, small credit adjustments, single-account notifications.',
    permissions: [
      'metrics.read',
      'customers.read',
      'customers.manage',
      'customers.notes',
      'customers.impersonate',
      'credits.adjust',
      'pii.reveal',
      'notifications.send',
    ],
  },
  compliance: {
    name: 'Compliance',
    description:
      'Sender ID queue, document download, approve / reject / request changes, suspend for abuse.',
    permissions: [
      'metrics.read',
      'customers.read',
      'customers.notes',
      'customers.suspend',
      'senderid.review',
      'senderid.documents.download',
      'pii.reveal',
      'audit.read',
    ],
  },
  ops: {
    name: 'Ops / Engineering',
    description:
      "God's-eye map, request logs, channel health, provider status. Read-only on money.",
    permissions: ['metrics.read', 'customers.read', 'geo.view', 'finance.read'],
  },
  growth: {
    name: 'Growth',
    description:
      'Segments and notification campaigns. Aggregate metrics only, no PII reveal.',
    permissions: [
      'metrics.read',
      'notifications.send',
      'notifications.broadcast',
      'notifications.segments',
    ],
  },
  read_only: {
    name: 'Read-only',
    description:
      'Investors, auditors. Aggregate dashboards; no PII, no exports.',
    permissions: ['metrics.read', 'finance.read'],
  },
};
