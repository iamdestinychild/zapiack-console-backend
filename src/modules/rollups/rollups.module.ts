import { Module } from '@nestjs/common';
import { RollupsService } from './rollups.service';

@Module({
  providers: [RollupsService],
  exports: [RollupsService],
})
export class RollupsModule {}
