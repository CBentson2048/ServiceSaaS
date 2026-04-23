export interface ApiHealthResponse {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ApiReadinessResponse {
  ready: boolean;
  checks: Record<string, 'pass' | 'fail' | 'skip'>;
  timestamp: string;
}

export interface ApiErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  path?: string;
  timestamp: string;
}
