import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { MailerService } from '../../integrations/mailer/mailer.service';
import {
  buildPage,
  cursorWhere,
  decodeCursor,
} from '../../common/http/pagination';
import { maskDestination } from '../../common/http/masking';
import { toDisplayString } from '../../common/http/stringify';
import { DEFAULT_JOB_OPTIONS, JOBS, QUEUES } from '../jobs/queues';
import { NotificationsGateway } from '../inbox/notifications.gateway';
import { SegmentsService, type ResolvedRecipient } from './segments.service';
import type { AdminConfig } from '../../common/config/configuration';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import type {
  CreateCampaignDto,
  ScheduleCampaignDto,
  UpsertTemplateDto,
} from './dto/notifications.dto';

/**
 * Outbound customer communication: in-app, email and SMS, to one account, a
 * hand-picked list or a saved segment.
 *
 * Anything above the broadcast threshold needs Super admin approval before it can be
 * scheduled or sent — a mistaken all-customers send is not undoable.
 */
@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);
  private readonly approvalThreshold: number;

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly segments: SegmentsService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
    private readonly notifications: NotificationsGateway,
    @InjectQueue(QUEUES.campaigns) private readonly queue: Queue,
    config: ConfigService<{ admin: AdminConfig }, true>,
  ) {
    this.approvalThreshold = config.get('admin', {
      infer: true,
    }).limits.broadcastApprovalThreshold;
  }

  async list(query: { cursor?: string; limit?: number; status?: string }) {
    const limit = query.limit ?? 50;
    const rows = await this.admin.campaign.findMany({
      where: {
        ...cursorWhere(decodeCursor(query.cursor)),
        ...(query.status ? { status: query.status as never } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        createdBy: { select: { id: true, name: true } },
        segment: { select: { id: true, name: true } },
      },
    });
    return buildPage(rows, limit);
  }

  async get(campaignId: string) {
    const campaign = await this.admin.campaign.findUnique({
      where: { id: campaignId },
      include: {
        createdBy: { select: { id: true, name: true } },
        segment: true,
        template: true,
      },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');

    const byStatus = await this.admin.campaignRecipient.groupBy({
      by: ['status'],
      where: { campaignId },
      _count: { _all: true },
    });

    return {
      ...campaign,
      delivery: Object.fromEntries(
        byStatus.map((r) => [r.status, r._count._all]),
      ),
    };
  }

  async create(actor: StaffPrincipal, dto: CreateCampaignDto) {
    this.validateAudience(dto);

    const recipientCount = await this.estimateSize(dto);
    const requiresApproval = recipientCount > this.approvalThreshold;

    if (
      requiresApproval &&
      !actor.permissions.includes('notifications.broadcast')
    ) {
      throw new ForbiddenException(
        `Reaching ${recipientCount} accounts needs notifications.broadcast`,
      );
    }

    const campaign = await this.admin.campaign.create({
      data: {
        name: dto.name,
        channel: dto.channel,
        templateId: dto.templateId,
        subject: dto.subject,
        body: dto.body,
        audienceKind: dto.audienceKind,
        segmentId: dto.segmentId,
        accountIds: dto.accountIds ?? [],
        recipientCount,
        requiresApproval,
        createdById: actor.id,
      },
    });

    await this.audit.record({
      actor,
      action: 'campaigns.created',
      targetType: 'campaign',
      targetId: campaign.id,
      after: {
        name: dto.name,
        channel: dto.channel,
        recipientCount,
        requiresApproval,
      },
    });

    return {
      ...campaign,
      requiresApproval,
      approvalThreshold: this.approvalThreshold,
    };
  }

  /** Test send to the requesting staff member, never to a customer. */
  async testSend(actor: StaffPrincipal, campaignId: string) {
    const campaign = await this.admin.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });

    if (campaign.channel !== 'EMAIL') {
      // Only email can be delivered to a staff member as-is; the others would need a
      // customer account or a device token to land anywhere meaningful.
      return {
        channel: campaign.channel,
        preview: this.render(campaign.body, sampleVariables()),
        subject: campaign.subject
          ? this.render(campaign.subject, sampleVariables())
          : null,
        note: 'Preview only; test delivery is available for email campaigns',
      };
    }

    await this.mailer.send({
      to: actor.email,
      subject: `[TEST] ${this.render(campaign.subject ?? campaign.name, sampleVariables())}`,
      html: this.render(campaign.body, sampleVariables()),
    });

    await this.audit.recordSafe({
      actor,
      action: 'campaigns.test_sent',
      targetType: 'campaign',
      targetId: campaignId,
      metadata: { to: actor.email },
    });

    return { sentTo: actor.email };
  }

  async approve(actor: StaffPrincipal, campaignId: string, reason: string) {
    if (actor.roleKey !== 'super_admin') {
      throw new ForbiddenException(
        'Broadcast approval is limited to Super admin',
      );
    }

    const campaign = await this.admin.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    if (campaign.createdById === actor.id) {
      throw new ForbiddenException(
        'A campaign cannot be approved by the staff member who created it',
      );
    }

    const updated = await this.admin.campaign.update({
      where: { id: campaignId },
      data: { approvedById: actor.id, approvedAt: new Date() },
    });

    await this.audit.record({
      actor,
      action: 'campaigns.approved',
      targetType: 'campaign',
      targetId: campaignId,
      reason,
      after: { recipientCount: campaign.recipientCount },
    });

    await this.notifications.notifyStaff(campaign.createdById, {
      type: 'campaigns.approved',
      severity: 'MEDIUM',
      title: `Campaign "${campaign.name}" approved`,
      link: `/campaigns/${campaignId}`,
    });

    return { id: updated.id, approvedAt: updated.approvedAt };
  }

  async schedule(
    actor: StaffPrincipal,
    campaignId: string,
    dto: ScheduleCampaignDto,
  ) {
    const campaign = await this.admin.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });

    if (!['DRAFT', 'PENDING_APPROVAL', 'SCHEDULED'].includes(campaign.status)) {
      throw new ConflictException(
        `Campaign is ${campaign.status} and can no longer be scheduled`,
      );
    }
    if (campaign.requiresApproval && !campaign.approvedAt) {
      throw new ForbiddenException(
        `This campaign reaches ${campaign.recipientCount} accounts and needs Super admin approval first`,
      );
    }

    const scheduledAt = new Date(dto.scheduledAt);
    const delay = Math.max(scheduledAt.getTime() - Date.now(), 0);

    const updated = await this.admin.campaign.update({
      where: { id: campaignId },
      data: { status: 'SCHEDULED', scheduledAt },
    });

    await this.queue.add(
      JOBS.sendCampaign,
      { campaignId },
      { ...DEFAULT_JOB_OPTIONS, delay, jobId: `campaign-${campaignId}` },
    );

    await this.audit.record({
      actor,
      action: 'campaigns.scheduled',
      targetType: 'campaign',
      targetId: campaignId,
      after: { scheduledAt, recipientCount: campaign.recipientCount },
    });

    return { id: updated.id, status: updated.status, scheduledAt };
  }

  async cancel(actor: StaffPrincipal, campaignId: string, reason: string) {
    const campaign = await this.admin.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    if (['SENT', 'SENDING'].includes(campaign.status)) {
      throw new ConflictException(
        'A campaign already sending or sent cannot be cancelled',
      );
    }

    await this.queue.remove(`campaign-${campaignId}`).catch(() => undefined);
    const updated = await this.admin.campaign.update({
      where: { id: campaignId },
      data: { status: 'CANCELLED' },
    });

    await this.audit.record({
      actor,
      action: 'campaigns.cancelled',
      targetType: 'campaign',
      targetId: campaignId,
      reason,
    });
    return { id: updated.id, status: updated.status };
  }

  /** Materialises the recipient list at send time, not at create time. */
  async materialiseRecipients(campaignId: string): Promise<number> {
    const campaign = await this.admin.campaign.findUniqueOrThrow({
      where: { id: campaignId },
    });
    const recipients = await this.resolveRecipients(campaign);

    for (const chunk of chunked(recipients, 1_000)) {
      await this.admin.campaignRecipient.createMany({
        data: chunk.map((r) => ({
          campaignId,
          accountId: r.accountId,
          // Held masked at rest; the worker re-resolves the real address when sending.
          destination: maskDestination(
            campaign.channel === 'SMS' ? r.phone : r.email,
          ),
        })),
        skipDuplicates: true,
      });
    }

    await this.admin.campaign.update({
      where: { id: campaignId },
      data: { recipientCount: recipients.length },
    });

    return recipients.length;
  }

  async resolveRecipients(campaign: {
    audienceKind: string;
    accountIds: string[];
    segmentId: string | null;
  }): Promise<ResolvedRecipient[]> {
    if (campaign.audienceKind === 'SEGMENT') {
      if (!campaign.segmentId)
        throw new BadRequestException('Campaign has no segment');
      return this.segments.resolveById(campaign.segmentId);
    }
    return this.segments
      .resolve({}, undefined)
      .then((all) =>
        all.filter((r) => campaign.accountIds.includes(r.accountId)),
      );
  }

  /** Substitutes {{variable}} placeholders; an unknown variable renders as empty. */
  render(template: string, variables: Record<string, unknown>): string {
    return template.replace(
      /\{\{\s*([\w.]+)\s*\}\}/g,
      (_match, path: string) => {
        const value = path
          .split('.')
          .reduce<unknown>(
            (acc, key) => (acc as Record<string, unknown>)?.[key],
            variables,
          );
        return toDisplayString(value);
      },
    );
  }

  // ---------------------------------------------------------------- templates

  listTemplates() {
    return this.admin.notificationTemplate.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async upsertTemplate(actor: StaffPrincipal, dto: UpsertTemplateDto) {
    const variables = [...dto.body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map(
      (m) => m[1],
    );

    const template = await this.admin.notificationTemplate.upsert({
      where: { key: dto.key },
      create: {
        ...dto,
        variables: [...new Set(variables)],
        createdBy: actor.id,
      },
      update: { ...dto, variables: [...new Set(variables)] },
    });

    await this.audit.recordSafe({
      actor,
      action: 'templates.upserted',
      targetType: 'notification_template',
      targetId: template.id,
    });
    return template;
  }

  // ---------------------------------------------------------------- internals

  private validateAudience(dto: CreateCampaignDto) {
    if (dto.audienceKind === 'SEGMENT' && !dto.segmentId) {
      throw new BadRequestException('A segment campaign needs segmentId');
    }
    if (dto.audienceKind !== 'SEGMENT' && !dto.accountIds?.length) {
      throw new BadRequestException(
        'An account campaign needs at least one accountId',
      );
    }
    if (dto.audienceKind === 'SINGLE_ACCOUNT' && dto.accountIds!.length !== 1) {
      throw new BadRequestException(
        'A single-account campaign takes exactly one accountId',
      );
    }
    if (dto.channel === 'EMAIL' && !dto.subject) {
      throw new BadRequestException('An email campaign needs a subject');
    }
  }

  private async estimateSize(dto: CreateCampaignDto): Promise<number> {
    if (dto.audienceKind === 'SEGMENT') {
      const segment = await this.admin.segment.findUnique({
        where: { id: dto.segmentId! },
      });
      if (!segment) throw new NotFoundException('Segment not found');
      return this.segments.count(segment.filter as never);
    }
    return dto.accountIds?.length ?? 0;
  }
}

function sampleVariables() {
  return {
    account: { businessName: 'Sample Business Ltd', balanceNgn: '12,500.00' },
    staff: { name: 'Zapiack' },
  };
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
