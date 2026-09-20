import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reader, type CityResponse } from 'maxmind';
import { readFile } from 'node:fs/promises';
import type { AdminConfig } from '../../common/config/configuration';

export interface GeoLocation {
  country?: string;
  countryName?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
}

/**
 * IPs are resolved offline against a local MaxMind GeoLite2 City database, refreshed
 * weekly, so there is no third-party call per request and no way for a lookup outage
 * to slow ingestion. A missing database degrades to "unknown location" rather than
 * failing the pipeline.
 */
@Injectable()
export class GeoIpService implements OnModuleInit {
  private readonly logger = new Logger(GeoIpService.name);
  private reader?: Reader<CityResponse>;
  private readonly cache = new Map<string, GeoLocation>();
  private readonly cacheLimit = 50_000;

  constructor(
    private readonly config: ConfigService<{ admin: AdminConfig }, true>,
  ) {}

  async onModuleInit() {
    await this.load();
  }

  /** Called at boot and by the weekly refresh job once a new database is in place. */
  async load(): Promise<boolean> {
    const path = this.config.get('admin', { infer: true }).geoip.cityDbPath;
    try {
      this.reader = new Reader<CityResponse>(await readFile(path));
      this.cache.clear();
      this.logger.log(`GeoIP database loaded from ${path}`);
      return true;
    } catch (err) {
      this.logger.warn(
        `GeoIP database unavailable at ${path} (${(err as Error).message}); locations will be unknown`,
      );
      return false;
    }
  }

  get ready(): boolean {
    return Boolean(this.reader);
  }

  lookup(ip?: string | null): GeoLocation {
    if (!ip || !this.reader) return {};
    const normalised = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

    const cached = this.cache.get(normalised);
    if (cached) return cached;

    let result: GeoLocation = {};
    try {
      const city = this.reader.get(normalised);
      if (city) {
        result = {
          country: city.country?.iso_code ?? city.registered_country?.iso_code,
          countryName: city.country?.names?.en,
          region: city.subdivisions?.[0]?.names?.en,
          city: city.city?.names?.en,
          latitude: city.location?.latitude,
          longitude: city.location?.longitude,
        };
      }
    } catch {
      // Private and malformed addresses simply have no location.
      result = {};
    }

    if (this.cache.size >= this.cacheLimit) this.cache.clear();
    this.cache.set(normalised, result);
    return result;
  }
}
