import { Module } from '@nestjs/common';
import { TemplateReviewClient } from '../../integrations/api-core/template-review.client';
import { CustomerActionsService } from './customer-actions.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, CustomerActionsService, TemplateReviewClient],
  exports: [CustomersService],
})
export class CustomersModule {}
