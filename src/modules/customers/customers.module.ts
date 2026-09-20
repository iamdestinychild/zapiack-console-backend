import { Module } from '@nestjs/common';
import { CustomerActionsService } from './customer-actions.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService, CustomerActionsService],
  exports: [CustomersService],
})
export class CustomersModule {}
