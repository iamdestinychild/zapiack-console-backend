import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { ZapiackPrismaService } from '../../common/prisma/zapiack-prisma.service';
import { S3Service } from '../../integrations/s3/s3.service';
import { maskEmail, maskPhone } from '../../common/http/masking';
import { toDisplayString } from '../../common/http/stringify';
import { lagosDateOnly, resolveRange } from '../../common/time/lagos';
import { JOBS, QUEUES, type ExportJobData } from './queues';

/** Hard cap so one export cannot pull the whole database into memory. */
const MAX_ROWS = 200_000;

/**
 * Generates an export as a background job and parks it in S3. The download link is
 * minted separately, short-lived, and audited each time it is fetched.
 */
@Processor(QUEUES.exports, { concurrency: 1 })
export class ExportsProcessor extends WorkerHost {
  private readonly logger = new Logger(ExportsProcessor.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly zapiack: ZapiackPrismaService,
    private readonly s3: S3Service,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (job.name !== JOBS.runExport) return null;

    const { exportId } = job.data as ExportJobData;
    const record = await this.admin.exportJob.findUnique({
      where: { id: exportId },
    });
    if (!record) return { skipped: 'export row missing' };

    await this.admin.exportJob.update({
      where: { id: exportId },
      data: { status: 'RUNNING' },
    });

    try {
      const params = record.params as Record<string, string>;
      const { start, end } = resolveRange(params.from, params.to, 30);
      const rows = await this.rowsFor(record.kind, start, end, params);

      const csv = toCsv(rows);
      const objectKey = await this.s3.putExport(`${exportId}.csv`, csv);

      await this.admin.exportJob.update({
        where: { id: exportId },
        data: {
          status: 'READY',
          objectKey,
          rowCount: rows.length,
          completedAt: new Date(),
        },
      });

      this.logger.log(
        `Export ${exportId} (${record.kind}) ready with ${rows.length} rows`,
      );
      return { rows: rows.length };
    } catch (err) {
      await this.admin.exportJob.update({
        where: { id: exportId },
        data: { status: 'FAILED', error: (err as Error).message.slice(0, 500) },
      });
      throw err;
    }
  }

  private async rowsFor(
    kind: string,
    start: Date,
    end: Date,
    params: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    const dateWindow = { gte: lagosDateOnly(start), lte: lagosDateOnly(end) };

    switch (kind) {
      case 'revenue':
      case 'profit': {
        const rows = await this.admin.usageRollup.groupBy({
          by: ['date', 'channel', 'provider'],
          where: {
            hour: -1,
            date: dateWindow,
            ...(params.channel ? { channel: params.channel } : {}),
          },
          _sum: {
            attempted: true,
            succeeded: true,
            revenueNgn: true,
            costNgn: true,
          },
          orderBy: [{ date: 'asc' }, { channel: 'asc' }],
        });
        return rows.map((r) => ({
          date: r.date.toISOString().slice(0, 10),
          channel: r.channel,
          provider: r.provider,
          attempted: Number(r._sum.attempted ?? 0),
          succeeded: Number(r._sum.succeeded ?? 0),
          revenueNgn: r._sum.revenueNgn?.toString() ?? '0',
          providerCostNgn: r._sum.costNgn?.toString() ?? '0',
          contributionNgn: (
            Number(r._sum.revenueNgn ?? 0) - Number(r._sum.costNgn ?? 0)
          ).toFixed(2),
        }));
      }

      case 'cash': {
        const rows = await this.admin.cashRollup.findMany({
          where: { date: dateWindow },
          orderBy: { date: 'asc' },
        });
        return rows.map((r) => ({
          date: r.date.toISOString().slice(0, 10),
          collectedNgn: r.collectedNgn.toString(),
          refundedNgn: r.refundedNgn.toString(),
          feesNgn: r.feesNgn.toString(),
          payments: r.paymentCount,
          failed: r.failedCount,
        }));
      }

      case 'usage': {
        const rows = await this.admin.usageRollup.findMany({
          where: {
            hour: -1,
            date: dateWindow,
            ...(params.accountId ? { accountId: params.accountId } : {}),
          },
          orderBy: [{ date: 'asc' }],
          take: MAX_ROWS,
        });
        return rows.map((r) => ({
          date: r.date.toISOString().slice(0, 10),
          accountId: r.accountId,
          channel: r.channel,
          country: r.country,
          attempted: Number(r.attempted),
          succeeded: Number(r.succeeded),
          failed: Number(r.failed),
          revenueNgn: r.revenueNgn.toString(),
          costNgn: r.costNgn.toString(),
        }));
      }

      case 'ledger': {
        const rows = await this.zapiack.read.tabTransaction.findMany({
          where: {
            createdAt: { gte: start, lte: end },
            ...(params.accountId ? { accountId: params.accountId } : {}),
          },
          orderBy: { createdAt: 'asc' },
          take: MAX_ROWS,
        });
        return rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          accountId: r.accountId,
          type: r.type,
          amountNgn: r.amountNgn.toString(),
          balanceAfter: r.balanceAfter.toString(),
          reference: r.reference,
          description: r.description,
        }));
      }

      case 'customers': {
        const rows = await this.zapiack.read.account.findMany({
          where: { createdAt: { lte: end } },
          orderBy: { createdAt: 'asc' },
          take: MAX_ROWS,
        });
        // Even a Finance export keeps contact details masked; a reveal is a separate,
        // separately-audited action.
        return rows.map((r) => ({
          id: r.id,
          businessName: r.businessName,
          email: maskEmail(r.email),
          phone: maskPhone(r.phone),
          status: r.status,
          country: r.country,
          balanceNgn: r.balance.toString(),
          kycVerified: r.kycVerified,
          createdAt: r.createdAt.toISOString(),
        }));
      }

      case 'audit': {
        const rows = await this.admin.auditLog.findMany({
          where: { createdAt: { gte: start, lte: end } },
          orderBy: { createdAt: 'asc' },
          take: MAX_ROWS,
          include: { actor: { select: { email: true } } },
        });
        return rows.map((r) => ({
          createdAt: r.createdAt.toISOString(),
          actor: r.actor?.email ?? r.actorEmail ?? 'system',
          action: r.action,
          targetType: r.targetType,
          targetId: r.targetId,
          reason: r.reason,
          ip: r.ip,
        }));
      }

      default:
        throw new Error(`Unsupported export kind ${kind}`);
    }
  }
}

/** RFC 4180 quoting, and a guard against spreadsheet formula injection. */
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    // Every cell here is a scalar pulled from a column; objects would signal a bug
    // in the row builder rather than something to stringify.
    let text = toDisplayString(value);
    // A cell starting with =, +, - or @ is executed as a formula by Excel and Sheets.
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };

  return [
    headers.map(escape).join(','),
    ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
  ].join('\n');
}
