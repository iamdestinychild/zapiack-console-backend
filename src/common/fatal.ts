import { Logger } from '@nestjs/common';

/**
 * Last-resort handlers that log the MESSAGE of a fatal error and nothing else.
 *
 * Node prints an uncaught error with `util.inspect`, which walks every property. An
 * ioredis ReplyError carries the command that failed, and for a rejected login that
 * command is `AUTH <username> <password>` — so a wrong Redis password was being written
 * to the logs in full. A pg error can carry the connection string in the same way.
 *
 * Exiting is still right: with Redis or the database unreachable the service cannot do
 * its job, and the platform restarts it. This only decides what ends up in the log.
 */
export function installFatalHandlers(logger = new Logger('fatal')): void {
  const describe = (reason: unknown): string => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const name = reason instanceof Error ? reason.constructor.name : 'Error';
    return `${name}: ${message}`;
  };

  process.on('unhandledRejection', (reason) => {
    logger.error(`Unhandled rejection - ${describe(reason)}`);
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.error(`Uncaught exception - ${describe(error)}`);
    process.exit(1);
  });
}
