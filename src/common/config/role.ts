import type { ProcessRole } from './configuration';

/**
 * Read straight from the environment rather than from ConfigService, because module
 * imports are decided before the DI container exists.
 */
export function processRole(): ProcessRole {
  const role = process.env.ADMIN_ROLE;
  return role === 'web' || role === 'worker' ? role : 'all';
}

export const runsHttp = () => processRole() !== 'worker';

/** Schedulers, queue processors and the request-ingest loop. */
export const runsBackgroundWork = () => processRole() !== 'web';
