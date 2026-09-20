import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Propagates the request id api-core uses, so a console action and the product-side
 * work it triggers can be traced as one thing in the logs.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { id?: string }, res: Response, next: NextFunction) {
    const incoming = req.get('x-request-id');
    req.id =
      incoming && /^[\w.-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  }
}
