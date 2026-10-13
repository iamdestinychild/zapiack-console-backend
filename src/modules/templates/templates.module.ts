import { Module } from '@nestjs/common';
import { TemplateReviewClient } from '../../integrations/api-core/template-review.client';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  controllers: [TemplatesController],
  providers: [TemplatesService, TemplateReviewClient],
})
export class TemplatesModule {}
