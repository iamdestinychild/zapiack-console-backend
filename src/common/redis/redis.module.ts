import { Global, Module } from '@nestjs/common';
import { ProductCacheService } from './product-cache.service';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, ProductCacheService],
  exports: [RedisService, ProductCacheService],
})
export class RedisModule {}
