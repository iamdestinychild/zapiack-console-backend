import { Global, Module } from '@nestjs/common';
import { AdminPrismaService } from './admin-prisma.service';
import { ZapiackPrismaService } from './zapiack-prisma.service';
import { ZapiackWriteService } from './zapiack-write.service';

@Global()
@Module({
  providers: [AdminPrismaService, ZapiackPrismaService, ZapiackWriteService],
  exports: [AdminPrismaService, ZapiackPrismaService, ZapiackWriteService],
})
export class PrismaModule {}
