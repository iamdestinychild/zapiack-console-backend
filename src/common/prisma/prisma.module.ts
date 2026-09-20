import { Global, Module } from '@nestjs/common';
import { AdminPrismaService } from './admin-prisma.service';
import { ZapiackPrismaService } from './zapiack-prisma.service';

@Global()
@Module({
  providers: [AdminPrismaService, ZapiackPrismaService],
  exports: [AdminPrismaService, ZapiackPrismaService],
})
export class PrismaModule {}
