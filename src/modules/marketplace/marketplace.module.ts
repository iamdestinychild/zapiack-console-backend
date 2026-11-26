import { Module } from '@nestjs/common';
import { TemplateReviewClient } from '../../integrations/api-core/template-review.client';
import { MarketplaceReviewController } from './marketplace.controller';
import { MarketplaceReviewService } from './marketplace.service';

@Module({
  controllers: [MarketplaceReviewController],
  providers: [MarketplaceReviewService, TemplateReviewClient],
})
export class MarketplaceReviewModule {}
