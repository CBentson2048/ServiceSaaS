import { Injectable } from '@nestjs/common';
import type { ApiHealthResponse, ApiReadinessResponse } from '@sheer/types';

const SERVICE_NAME = 'sheer-api';
const SERVICE_VERSION = process.env.npm_package_version ?? '0.1.0';

@Injectable()
export class HealthService {
  private readonly startedAt = Date.now();

  getHealth(): ApiHealthResponse {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      version: SERVICE_VERSION,
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    };
  }

  getReadiness(): ApiReadinessResponse {
    // Placeholder readiness checks. Extend with DB / Supabase / Stripe pings
    // as those integrations land.
    return {
      ready: true,
      checks: {
        process: 'pass',
        database: 'skip',
      },
      timestamp: new Date().toISOString(),
    };
  }
}
