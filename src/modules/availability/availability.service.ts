import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  ApiCoreAvailabilityRule,
  TemplateReviewClient,
} from '../../integrations/api-core/template-review.client';
import { SetAvailabilityDto } from './dto/availability.dto';

const same = (
  a: ApiCoreAvailabilityRule,
  b: Partial<ApiCoreAvailabilityRule>,
) =>
  a.accountCountry === b.accountCountry &&
  a.service === b.service &&
  a.destinationCountry === b.destinationCountry;

/**
 * Which services accounts from each country may use, and towards which countries. The rows live with the product (api-core
 * enforces them on every send and in the price list); this adds who may change them and the audit trail.
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

  async set(actor: StaffPrincipal, dto: SetAvailabilityDto) {
    const key = {
      accountCountry: dto.accountCountry.toUpperCase(),
      service: dto.service,
      destinationCountry: dto.destinationCountry.toUpperCase(),
    };
    const before = (await this.apiCore.listAvailability()).find((r) =>
      same(r, key),
    );
    const row = await this.apiCore.setAvailability({
      ...key,
      enabled: dto.enabled,
      note: dto.note,
      updatedBy: actor.email,
    });
    await this.audit.record({
      actor,
      action: 'availability.set',
      targetType: 'availability_rule',
      targetId: row.id,
      reason: dto.reason,
      before: before ? { enabled: before.enabled, note: before.note } : null,
      after: { ...key, enabled: row.enabled, note: row.note },
    });
    return row;
  }

  async remove(actor: StaffPrincipal, id: string, reason: string) {
    const row = await this.apiCore.deleteAvailability(id);
    await this.audit.record({
      actor,
      action: 'availability.removed',
      targetType: 'availability_rule',
      targetId: id,
      reason,
      before: {
        accountCountry: row.accountCountry,
        service: row.service,
        destinationCountry: row.destinationCountry,
        enabled: row.enabled,
      },
    });
    return row;
  }
}
