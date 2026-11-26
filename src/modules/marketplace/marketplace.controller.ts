import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentStaff, Idempotent, RequirePermissions } from '../../common/auth/decorators';
import type { StaffPrincipal } from '../../common/auth/staff-principal';
import { ReasonDto } from '../../common/dto/common.dto';
import { LISTING_STATUSES, MarketplaceReviewService, type ListingStatus } from './marketplace.service';

export class ListListingsDto {
  @IsOptional()
  @IsIn(LISTING_STATUSES)
  status?: ListingStatus;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class ListCatalogDto {
  @IsOptional()
  @IsIn(['push', 'sms', 'whatsapp', 'website'])
  channel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}

export class OverrideDto extends ReasonDto {
  @IsOptional()
  @IsBoolean()
  hidden?: boolean;

  @IsOptional()
  @IsBoolean()
  featured?: boolean;
}

/** The templates customers offer to the marketplace. Nothing is public until it is approved here. */
@Controller('marketplace')
@RequirePermissions('templates.review')
export class MarketplaceReviewController {
  constructor(private readonly marketplace: MarketplaceReviewService) {}

  @Get()
  list(@Query() query: ListListingsDto) {
    return this.marketplace.list(query.status ?? 'pending', query.q);
  }

  /** Every listing in the marketplace, Zapiack's own included, with whether it is hidden or featured. */
  @Get('catalog')
  catalog(@Query() query: ListCatalogDto) {
    return this.marketplace.catalog(query.channel, query.q);
  }

  /** Hides a listing from the marketplace (or shows it again), or features it. Nothing else about it changes. */
  @Post('catalog/:channel/:slug')
  @Idempotent()
  setOverride(@CurrentStaff() staff: StaffPrincipal, @Param('channel') channel: string, @Param('slug') slug: string, @Body() dto: OverrideDto) {
    return this.marketplace.setOverride(staff, channel, slug, { hidden: dto.hidden, featured: dto.featured }, dto.reason);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.marketplace.get(id);
  }

  /** Makes it public. The reason stays in the audit log. */
  @Post(':id/approve')
  @Idempotent()
  approve(@CurrentStaff() staff: StaffPrincipal, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.marketplace.decide(staff, id, 'approve', dto.reason);
  }

  /** Refuses it. The reason is shown to the customer. */
  @Post(':id/reject')
  @Idempotent()
  reject(@CurrentStaff() staff: StaffPrincipal, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.marketplace.decide(staff, id, 'reject', dto.reason);
  }

  /** Removes a live listing. Copies already made stay with whoever made them. The reason is shown to the customer. */
  @Post(':id/take-down')
  @Idempotent()
  takeDown(@CurrentStaff() staff: StaffPrincipal, @Param('id') id: string, @Body() dto: ReasonDto) {
    return this.marketplace.decide(staff, id, 'take_down', dto.reason);
  }
}
