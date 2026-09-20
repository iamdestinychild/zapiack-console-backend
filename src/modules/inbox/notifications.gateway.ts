import { Injectable, Logger } from '@nestjs/common';
import { AdminPrismaService } from '../../common/prisma/admin-prisma.service';
import { SseService } from '../../common/sse/sse.service';
import { MailerService } from '../../integrations/mailer/mailer.service';
import type { Permission } from '../../common/auth/permissions';

export interface StaffAlert {
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  body?: string;
  link?: string;
}

/**
 * In-console alerts: new sender ID applications, SLA breaches, failed-payment spikes,
 * provider outages, reconciliation variances and risk flags.
 *
 * Everything lands in the staff inbox and is pushed over SSE. Email is opt-in per
 * staff member, per alert type, so the console does not become another noisy inbox.
 */
@Injectable()
export class NotificationsGateway {
  private readonly logger = new Logger(NotificationsGateway.name);

  constructor(
    private readonly admin: AdminPrismaService,
    private readonly sse: SseService,
    private readonly mailer: MailerService,
  ) {}

  /** Targets everyone whose role carries the permission the alert is relevant to. */
  async broadcastToPermission(
    permission: Permission,
    alert: StaffAlert,
  ): Promise<number> {
    const recipients = await this.admin.staff.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { role: { permissions: { has: permission } } },
          { extraPermissions: { has: permission } },
        ],
      },
      select: {
        id: true,
        email: true,
        name: true,
        emailNotificationPrefs: true,
      },
    });

    if (!recipients.length) {
      this.logger.warn(
        `No active staff hold ${permission}; alert ${alert.type} has no audience`,
      );
      return 0;
    }

    await this.admin.staffNotification.createMany({
      data: recipients.map((r) => ({
        staffId: r.id,
        type: alert.type,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        link: alert.link,
      })),
    });

    await Promise.all(
      recipients.map((r) =>
        this.sse.publish(`staff:${r.id}`, 'notification', alert),
      ),
    );

    // Email only where the staff member asked for this type.
    const wantsEmail = recipients.filter((r) =>
      r.emailNotificationPrefs.includes(alert.type),
    );
    if (wantsEmail.length) {
      await this.mailer
        .sendBatch(
          wantsEmail.map((r) => ({
            to: r.email,
            subject: `[Zapiack Admin] ${alert.title}`,
            html: `<p>${escapeHtml(alert.title)}</p>${alert.body ? `<p>${escapeHtml(alert.body)}</p>` : ''}`,
          })),
        )
        .catch((err) =>
          this.logger.error(`Alert email failed: ${(err as Error).message}`),
        );

      await this.admin.staffNotification.updateMany({
        where: {
          staffId: { in: wantsEmail.map((r) => r.id) },
          type: alert.type,
          emailedAt: null,
        },
        data: { emailedAt: new Date() },
      });
    }

    return recipients.length;
  }

  async notifyStaff(staffId: string, alert: StaffAlert) {
    const created = await this.admin.staffNotification.create({
      data: {
        staffId,
        type: alert.type,
        severity: alert.severity,
        title: alert.title,
        body: alert.body,
        link: alert.link,
      },
    });
    await this.sse.publish(`staff:${staffId}`, 'notification', alert);
    return created;
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
