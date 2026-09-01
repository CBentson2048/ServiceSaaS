import type { CampaignConfig, CampaignType } from '@sheer/domain';
import { validateCampaignConfig } from '@sheer/domain';

/**
 * The `comms.campaigns` row shape every campaign service agrees on, plus the
 * governing timezone the caller has already resolved.
 *
 * `timezone` is NOT a column. It is the campaign location's timezone, or the
 * business's for a business-wide campaign, resolved once per read so that no
 * downstream code is ever tempted to fall back to server UTC (Wrike section 22).
 */
export interface CampaignRow {
  id: string;
  business_id: string;
  location_id: string | null;
  campaign_type: string;
  name: string;
  status: string;
  channel: string;
  message_template: string;
  message_subject: string | null;
  send_at_local_hour: number;
  config: Record<string, unknown> | null;
  created_by_user_profile_id: string | null;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
  /** Resolved by the caller. Location's own, else the business's. Never UTC. */
  timezone: string;
}

export const CAMPAIGN_COLUMNS =
  'id,business_id,location_id,campaign_type,name,status,channel,message_template,message_subject,' +
  'send_at_local_hour,config,created_by_user_profile_id,last_evaluated_at,created_at,updated_at';

/**
 * The stored config, re-validated against the row's declared type on every read.
 *
 * Validating on the way OUT as well as on the way in matters: a row written by a
 * script, a backfill or a future migration could otherwise hand the evaluator a
 * shape it would silently misread — and a misread audience filter is a message
 * sent to the wrong people. Throwing here fails one campaign's run loudly rather
 * than messaging the wrong audience quietly.
 */
export function campaignConfigOf(row: CampaignRow): CampaignConfig {
  const type = row.campaign_type as CampaignType;
  const result = validateCampaignConfig(type, row.config ?? {});
  if (!result.valid) {
    throw new Error(`campaign ${row.id} has an invalid ${type} configuration: ${result.errors.join('; ')}`);
  }
  // The COLUMN is authoritative, so it is spread last: a stray `type` key inside
  // the stored JSON must never be able to re-label a campaign and send it down
  // another strategy's branch.
  return { ...(row.config as object), type } as CampaignConfig;
}
