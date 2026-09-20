import { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthController } from '../src/health.controller';

/**
 * A full e2e run needs Postgres, Redis and a GeoIP database, so it lives behind
 * `npm run test:e2e` against docker-compose rather than in the unit suite. This
 * smoke test checks the one route that must answer before any of that is up.
 */
describe('admin-core (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
    })
      .useMocker(() => ({}))
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reports liveness without a session', async () => {
    await request(app.getHttpServer() as App)
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', service: 'admin-core' });
  });
});
