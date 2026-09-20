import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * One error shape for the console, with the request id attached so a staff member can
 * quote it and an engineer can find the matching api-core log line. Internal messages
 * are never echoed to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { id?: string }>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const payload = isHttp ? exception.getResponse() : null;

    const body = {
      statusCode: status,
      error: HttpStatus[status] ?? 'ERROR',
      message:
        status === Number(HttpStatus.INTERNAL_SERVER_ERROR)
          ? 'Something went wrong'
          : typeof payload === 'string'
            ? payload
            : ((payload as { message?: unknown })?.message ?? 'Request failed'),
      requestId: request.id,
    };

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status}: ${(exception as Error)?.message}`,
        (exception as Error)?.stack,
      );
    }

    response.status(status).json(body);
  }
}
