/**
 * What each kind of reconciliation actually checks, in words a person can act on.
 *
 * The stored `kind` is a stable key and is not changed: renaming a database enum value
 * to fix a label would force a migration for no behavioural gain, and anything that
 * matches on the key would break. The label and description are what to display.
 */
export interface ReconciliationKindInfo {
  label: string;
  description: string;
}

const KINDS: Record<string, ReconciliationKindInfo> = {
  // The key still says Paystack because it was named for what the check was meant to
  // do. What it does is compare two of our own figures, and nothing outside.
  PAYSTACK_SETTLEMENT: {
    label: 'Payments check',
    description:
      'The successful payments recorded in the product for the day, against the console’s own cash total for the same day. It confirms the console’s figures match your database. It does not check Paystack or your bank.',
  },
  PROVIDER_INVOICE: {
    label: 'Provider invoice check',
    description:
      'Recorded provider cost against the price book. Not running yet: the product does not record provider cost per send.',
  },
};

export function reconciliationKindInfo(kind: string): ReconciliationKindInfo {
  return (
    KINDS[kind] ?? {
      label: kind.replace(/_/g, ' ').toLowerCase(),
      description: '',
    }
  );
}
