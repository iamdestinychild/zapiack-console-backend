import { Module } from '@nestjs/common';
import { TemplateReviewClient } from '../../integrations/api-core/template-review.client';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';

@Module({
  controllers: [CreditsController],
  providers: [CreditsService, TemplateReviewClient],
})
export class CreditsModule {}
