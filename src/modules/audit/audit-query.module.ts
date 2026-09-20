import { Module } from '@nestjs/common';
import { AuditQueryController } from './audit-query.controller';

@Module({ controllers: [AuditQueryController] })
export class AuditQueryModule {}
