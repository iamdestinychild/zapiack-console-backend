import { Module } from '@nestjs/common';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { SuperAdminSyncService } from './super-admin-sync.service';

@Module({
  controllers: [StaffController],
  providers: [StaffService, SuperAdminSyncService],
})
export class StaffModule {}
