import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { DateTime } from 'luxon';
import { Prisma } from '../../generated/admin/client';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { S3Service } from '../../integrations/s3/s3.service';
import { DEFAULT_JOB_OPTIONS, JOBS, QUEUES } from '../jobs/queues';
import type { AdminConfig } from '../../common/config/configuration';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import type { CreateExportDto } from './dto/finance.dto';

/** Export kinds that contain personal data, and are therefore restricted further. */
const PII_KINDS = new Set(['customers', 'ledger', 'audit']);
const PII_ROLES = new Set(['finance', 'super_admin']);

/**
 * Exports run as background jobs and are delivered as short-lived download links.
 * Every export is audited, and anything containing PII is limited to Finance and
 * Super admin and expires after 24 hours.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);
  private readonly ttlHours: number;

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly audit: AuditService,
    private readonly s3: S3Service,
    @InjectQueue(QUEUES.exports) private readonly queue: Queue,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.ttlHours = config.get('admin', { infer: true }).limits.exportTtlHours;
  }

  async create(actor: StaffPrincipal, dto: CreateExportDto) {
    const containsPii = PII_KINDS.has(dto.kind);

    if (containsPii && !PII_ROLES.has(actor.roleKey)) {
      throw new ForbiddenException(
        'Exports containing personal data are limited to Finance and Super admin',
      );
    }

    const job = await this.admin.exportJob.create({
      data: {
        requestedById: actor.id,
        kind: dto.kind,
        params: dto as unknown as Prisma.InputJsonValue,
        containsPii,
        expiresAt: DateTime.now().plus({ hours: this.ttlHours }).toJSDate(),
      },
    });

    await this.queue.add(
      JOBS.runExport,
      { exportId: job.id },
      DEFAULT_JOB_OPTIONS,
    );

    await this.audit.record({
      actor,
      action: 'finance.export_requested',
      targetType: 'export_job',
      targetId: job.id,
      metadata: { kind: dto.kind, containsPii, params: dto },
    });

    return { id: job.id, status: job.status, expiresAt: job.expiresAt };
  }

  async list(actor: StaffPrincipal) {
    return this.admin.exportJob.findMany({
      // Staff see their own exports; an export is tied to the reason its requester had.
      where: { requestedById: actor.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** The only way to the file. Generates a fresh short-lived link and audits the fetch. */
  async download(actor: StaffPrincipal, exportId: string) {
    const job = await this.admin.exportJob.findUnique({
      where: { id: exportId },
    });
    if (!job) throw new NotFoundException('Export not found');
    if (job.requestedById !== actor.id && actor.roleKey !== 'super_admin') {
      throw new ForbiddenException(
        'Exports are downloadable only by the staff member who ran them',
      );
    }
    if (job.status !== 'READY' || !job.objectKey) {
      throw new NotFoundException(`Export is ${job.status}`);
    }
    if (job.expiresAt && job.expiresAt < new Date()) {
      await this.admin.exportJob.update({
        where: { id: exportId },
        data: { status: 'EXPIRED' },
      });
      throw new NotFoundException('Export has expired; run it again');
    }

    const link = await this.s3.presignExport(
      job.objectKey,
      `${job.kind}-${job.createdAt.toISOString().slice(0, 10)}.csv`,
      15 * 60,
    );

    await this.audit.record({
      actor,
      action: 'finance.export_downloaded',
      targetType: 'export_job',
      targetId: exportId,
      metadata: { kind: job.kind, containsPii: job.containsPii },
    });

    return link;
  }
}
