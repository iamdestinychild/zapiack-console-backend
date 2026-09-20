import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { Public, RequirePermissions } from '../../common/auth/decorators';
import { ApiCoreClient } from '../../integrations/api-core/api-core.client';
import { EventsService, type IncomingEvent } from './events.service';

/**
 * Inbound events from the other services. This is the one route reachable without a
 * staff session, so it is authenticated by the same HMAC scheme admin-core uses when
 * it calls api-core, with a five-minute timestamp window against replay.
 */
@Controller('events')
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly apiCore: ApiCoreClient,
  ) {}

  @Public()
  @Post('ingest')
  async ingest(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-admin-signature') signature: string,
    @Headers('x-admin-timestamp') timestamp: string,
    @Body() body: { events: IncomingEvent[] },
  ) {
    const raw = req.rawBody?.toString('utf8') ?? JSON.stringify(body);

    if (!signature || !timestamp) {
      throw new BadRequestException('Signature headers are required');
    }
    if (
      !this.apiCore.verifySignature(
        timestamp,
        'POST',
        '/events/ingest',
        raw,
        signature,
      )
    ) {
      throw new BadRequestException('Invalid or expired signature');
    }
    if (!Array.isArray(body?.events) || !body.events.length) {
      throw new BadRequestException('events must be a non-empty array');
    }

    return this.events.ingestBatch(body.events);
  }

  /** Queue depth and failures, for the observability dashboard. */
  @Get('stats')
  @RequirePermissions('metrics.read')
  stats() {
    return this.events.stats();
  }
}
