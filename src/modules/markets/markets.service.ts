import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import {
  ApiCoreBillingMarket,
  TemplateReviewClient,
} from '../../integrations/api-core/template-review.client';
import { SetBillingMarketDto } from './dto/markets.dto';

const view = (m: ApiCoreBillingMarket) => ({
  currency: m.currency,
  welcomeBonusEnabled: m.welcomeBonusEnabled,
  welcomeBonusAmount: m.welcomeBonusAmount,
  note: m.note,
});

/**
 * How each country's new accounts are set up: the currency their wallet is in and the signup bonus they get. The rows live
 * with the product (api-core reads them when an account is created); this adds who may change them and the audit trail.
 */
@Injectable()
export class MarketsService {
  constructor(
    private readonly apiCore: TemplateReviewClient,
    private readonly audit: AuditService,
  ) {}

  list() {
    return this.apiCore.listBillingMarkets();
  }

  async set(actor: StaffPrincipal, dto: SetBillingMarketDto) {
    const countryCode = dto.countryCode.toUpperCase();
    const before = (await this.apiCore.listBillingMarkets()).find(
      (m) => m.countryCode === countryCode,
    );
    const row = await this.apiCore.setBillingMarket({
      countryCode,
      currency: dto.currency,
      welcomeBonusEnabled: dto.welcomeBonusEnabled,
      welcomeBonusAmount: dto.welcomeBonusAmount ?? null,
      note: dto.note,
      updatedBy: actor.email,
    });
    await this.audit.record({
      actor,
      action: 'markets.set',
      targetType: 'billing_market',
      targetId: row.id,
      reason: dto.reason,
      before: before ? view(before) : null,
      after: { countryCode, ...view(row) },
    });
    return row;
  }

  async remove(actor: StaffPrincipal, id: string, reason: string) {
    const row = await this.apiCore.deleteBillingMarket(id);
    await this.audit.record({
      actor,
      action: 'markets.removed',
      targetType: 'billing_market',
      targetId: id,
      reason,
      before: { countryCode: row.countryCode, ...view(row) },
    });
    return row;
  }
}
