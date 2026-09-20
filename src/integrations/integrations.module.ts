import { Global, Module } from '@nestjs/common';
import { ApiCoreClient } from './api-core/api-core.client';
import { GeoIpService } from './geoip/geoip.service';
import { MailerService } from './mailer/mailer.service';
import { S3Service } from './s3/s3.service';
import { SmsCoreClient } from './sms/sms-core.client';

/** Everything admin-core talks to that is not one of its two databases. */
@Global()
@Module({
  providers: [
    ApiCoreClient,
    S3Service,
    GeoIpService,
    MailerService,
    SmsCoreClient,
  ],
  exports: [
    ApiCoreClient,
    S3Service,
    GeoIpService,
    MailerService,
    SmsCoreClient,
  ],
})
export class IntegrationsModule {}
