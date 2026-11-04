import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  ApiCoreAvailabilityRule,
  TemplateReviewClient,
} from '../../integrations/api-core/template-review.client';
import { ChangeAvailabilityDto } from './dto/availability.dto';

const describe = (r: {
  accountCountry: string;
  service: string;
  destinationCountry: string;
  messageType?: string;
  enabled: boolean;
}) => ({
  accountCountry: r.accountCountry,
  service: r.service,
  destinationCountry: r.destinationCountry,
  messageType: r.messageType ?? '*',
  enabled: r.enabled,
});

/**
 * Which products accounts from each country may use, and for SMS where they can send and which kinds of message. The rows
 * live with the product (api-core enforces them on every request); this adds who may change them and the audit trail.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly apiCore: TemplateReviewClient,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.apiCore.listAvailability();
  }

  /**
   * One save is one change: every rule it adds, changes or removes is applied together in api-core, and written to the audit
   * log as a single entry that shows what each rule said before and after.
   */
  async change(actor: StaffPrincipal, dto: ChangeAvailabilityDto) {
    const before = await this.apiCore.listAvailability();
    const byId = new Map(before.map((r) => [r.id, r]));
    const removed: ApiCoreAvailabilityRule[] = dto.deleteIds
      .map((id) => byId.get(id))
      .filter((r): r is ApiCoreAvailabilityRule => Boolean(r));

    const upserts = dto.upserts.map((r) => ({
      ...r,
      accountCountry: r.accountCountry.toUpperCase(),
      destinationCountry: r.destinationCountry.toUpperCase(),
      messageType: r.messageType ?? '*',
      updatedBy: actor.email,
    }));

    const after = await this.apiCore.changeAvailability({
      upserts,
      deleteIds: dto.deleteIds,
    });

    await this.audit.record({
      actor,
      action: 'availability.changed',
      targetType: 'availability_rule',
      targetId: 'bulk',
      reason: dto.reason,
      before: { removed: removed.map(describe) },
      after: { saved: upserts.map(describe), rules: after.length },
    });
    return after;
  }
}
