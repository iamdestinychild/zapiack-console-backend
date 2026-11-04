import { Module } from '@nestjs/common';
import { TemplateReviewClient } from '../../integrations/api-core/template-review.client';
import { MarketsController } from './markets.controller';
import { MarketsService } from './markets.service';

@Module({
  controllers: [MarketsController],
  providers: [MarketsService, TemplateReviewClient],
})
export class MarketsModule {}
