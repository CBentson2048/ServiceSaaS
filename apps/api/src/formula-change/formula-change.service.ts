import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  FormulaChangeAssessment,
  FormulaChangeSettingsRecord,
  FormulaChangeSettingsResponse,
  FormulaChangeSettingsScope,
  FormulaChangeThresholds,
  FormulaComponentInput,
  FormulaSnapshotInput,
  StockUnit,
} from '@sheer/domain';
import {
  DEFAULT_FORMULA_CHANGE_THRESHOLDS,
  compareFormulas,
  formulaComparabilityKey,
  noComparableFormula,
  resolveFormulaChangeThresholds,
  userHasAnyRole,
  userHasRole,
  validateFormulaChangeThresholds,
} from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import type { UpsertFormulaChangeSettingsDto } from './dto';

/**
 * Formula Change Detection (Wrike 4507283774).
 *
 * COMPUTED ON READ, NOTHING STORED. This mirrors the platform's existing client
 * intelligence (crm client lapse detection, 0097), which recomputes from live
 * rows on every call. The consequences are deliberate and are the answer to
 * three of the ticket's open questions:
 *   - a threshold change is reflected on the very next read, because the
 *     assessment is derived from the current settings;
 *   - there is no persisted flag to deduplicate, so idempotency is trivially
 *     satisfied;
 *   - editing or voiding a formula is reflected immediately, with no cache.
 *
 * READ-ONLY OVER QLAB. The only write in this service is the settings upsert.
 * Detection never writes a formula, never touches stock, and is not called from
 * the formula save path at all — so it cannot fail a save or a reconciliation
 * (Wrike sections 32, 33).
 *
 * SET-BASED, NEVER PER CLIENT. Both the single-client and the Colour Prep bulk
 * path run the same bounded loader: at most five queries regardless of how many
 * clients are being assessed (Wrike sections 39, 40).
 */
@Injectable()
export class FormulaChangeService {
  private readonly logger = new Logger(FormulaChangeService.name);
  private readonly admin: SupabaseClient;

  /**
   * Finalised formulas read per client. Only the newest and the newest
   * COMPARABLE one are needed, but a client may have several purposes
   * interleaved (colour, toner, colour), so a small window is read to find the
   * comparable pair without an unbounded lifetime scan.
   */
  private static readonly HISTORY_PER_CLIENT = 12;
  /** Overall row bound for the bulk read, before per-client windowing. */
  private static readonly BULK_ROW_CAP = 1000;

  constructor(
    config: ConfigService,
    private readonly audit: AuditService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // -------------------------------------------------------------------------
  // Assessment
  // -------------------------------------------------------------------------

  /**
   * The current formula-change assessment for one client.
   *
   * Access mirrors `LabFormulaService.historyForClient` exactly: a client sees
   * only their own profile, an owner sees the whole business, and everyone else
   * is bounded to their allowed locations. A DB read can never widen visibility,
   * and the client id is validated against the acting business before use —
   * `?clientId=<arbitrary>` can never cross a tenant boundary.
   */
  async assessForClient(actor: AuthUser, clientProfileId: string): Promise<FormulaChangeAssessment> {
    if (userHasRole(actor, 'client') && actor.clientProfileId !== clientProfileId) {
      throw new ForbiddenException('Formula history is outside your scope');
    }
    await this.assertClientInBusiness(actor.businessId, clientProfileId);

    const locationIds = this.readableLocationIds(actor);
    const byClient = await this.assessClients(actor.businessId, [clientProfileId], locationIds);
    return (
      byClient.get(clientProfileId) ??
      noComparableFormula('no_formula_history', await this.thresholdsFor(actor.businessId, null))
    );
  }

  /**
   * Assessments for many clients at once — the Colour Prep path.
   *
   * The caller MUST already have authorised the business and the client set;
   * this method applies no actor scoping of its own, exactly like the other bulk
   * loaders Colour Prep composes. It is bounded and set-based: one formula
   * query, one item query, one product query and the comparability lookups,
   * regardless of how many appointments the day holds.
   */
  async assessClients(
    businessId: string,
    clientProfileIds: string[],
    locationIds?: string[] | null,
    locationIdForThresholds: string | null = null,
  ): Promise<Map<string, FormulaChangeAssessment>> {
    const result = new Map<string, FormulaChangeAssessment>();
    const clientIds = [...new Set(clientProfileIds.filter(Boolean))];
    if (clientIds.length === 0) return result;

    const thresholds = await this.thresholdsFor(businessId, locationIdForThresholds);
    const formulas = await this.loadFinalisedFormulas(businessId, clientIds, locationIds);
    if (formulas.length === 0) {
      for (const clientId of clientIds) {
        result.set(clientId, noComparableFormula('no_formula_history', thresholds));
      }
      return result;
    }

    const [items, comparability] = await Promise.all([
      this.loadItems(formulas.map((row) => row.id)),
      this.loadComparabilityKeys(businessId, formulas),
    ]);
    const stockUnits = await this.loadStockUnits(
      businessId,
      [...items.values()].flat().map((item) => item.product_id).filter((id): id is string => Boolean(id)),
    );

    // Group newest-first per client, collapsing formula revisions.
    const byClient = new Map<string, FormulaRow[]>();
    for (const formula of formulas) {
      const list = byClient.get(formula.client_profile_id) ?? [];
      if (list.length < FormulaChangeService.HISTORY_PER_CLIENT) list.push(formula);
      byClient.set(formula.client_profile_id, list);
    }

    for (const clientId of clientIds) {
      const history = collapseRevisions(byClient.get(clientId) ?? []);
      if (history.length === 0) {
        result.set(clientId, noComparableFormula('no_formula_history', thresholds));
        continue;
      }

      const current = history[0];
      const currentKey = comparability.get(current.id) ?? 'uncategorised';
      const previous = history
        .slice(1)
        .find(
          (candidate) =>
            (comparability.get(candidate.id) ?? 'uncategorised') === currentKey &&
            // Never compare two formulas from the SAME visit: those are parts of
            // one appointment's work, not a change over time (Wrike section 6).
            !(current.visit_id !== null && candidate.visit_id === current.visit_id),
        );

      if (!previous) {
        result.set(
          clientId,
          noComparableFormula(
            'no_prior_comparable_formula',
            thresholds,
            toSnapshot(current, items, stockUnits),
          ),
        );
        continue;
      }

      result.set(
        clientId,
        compareFormulas(
          toSnapshot(previous, items, stockUnits),
          toSnapshot(current, items, stockUnits),
          thresholds,
        ),
      );
    }

    return result;
  }

  /**
   * Colour Prep's entry point. Never throws: a failed assessment must degrade to
   * "no flag shown" rather than taking down the prep screen, which is an
   * operational surface the salon needs to run the day (Wrike section 58).
   */
  async assessClientsSafe(
    businessId: string,
    clientProfileIds: string[],
    locationId: string | null,
  ): Promise<Map<string, FormulaChangeAssessment>> {
    try {
      return await this.assessClients(businessId, clientProfileIds, null, locationId);
    } catch (err) {
      this.logger.error(`formula-change bulk assessment failed: ${(err as Error).message}`);
      return new Map();
    }
  }

  // -------------------------------------------------------------------------
  // Evidence loading
  // -------------------------------------------------------------------------

  /**
   * Finalised formulas only (Wrike section 5).
   *
   * `status = 'saved'` is the platform's existing meaning of "finalized mix"
   * (0069): drafts persist as `status='draft'` and are excluded here exactly as
   * they are excluded from billing, receipts and analytics. `voided` is excluded
   * for the same reason. `saved_at is not null` drops anything that never
   * completed a save.
   */
  private async loadFinalisedFormulas(
    businessId: string,
    clientIds: string[],
    locationIds?: string[] | null,
  ): Promise<FormulaRow[]> {
    let query = this.admin
      .schema('lab')
      .from('formulas')
      .select('id,client_profile_id,visit_id,appointment_id,saved_at,version,version_group_id,service_name_snapshot')
      .eq('business_id', businessId)
      .eq('status', 'saved')
      .not('saved_at', 'is', null)
      .in('client_profile_id', clientIds)
      .order('saved_at', { ascending: false })
      .limit(FormulaChangeService.BULK_ROW_CAP);

    if (locationIds) query = query.in('location_id', locationIds);

    const { data, error } = await query.returns<FormulaRow[]>();
    if (error) throw new Error(`load formulas failed: ${error.message}`);
    return data ?? [];
  }

  private async loadItems(formulaIds: string[]): Promise<Map<string, FormulaItemRow[]>> {
    const byFormula = new Map<string, FormulaItemRow[]>();
    if (formulaIds.length === 0) return byFormula;

    const { data, error } = await this.admin
      .schema('lab')
      .from('formula_items')
      .select('formula_id,product_id,product_name,brand,developer,captured_grams')
      .in('formula_id', formulaIds)
      .returns<FormulaItemRow[]>();
    if (error) throw new Error(`load formula items failed: ${error.message}`);

    for (const item of data ?? []) {
      const list = byFormula.get(item.formula_id) ?? [];
      list.push(item);
      byFormula.set(item.formula_id, list);
    }
    return byFormula;
  }

  /**
   * Each formula's comparability key, from its appointment's colour service
   * categories (Wrike section 4).
   *
   * The path is `lab.formulas.appointment_id` -> `booking.appointment_services`
   * -> `booking.services.service_category_id` ->
   * `booking.service_categories.billing_category` — the SAME linkage Colour Prep
   * uses to decide which appointments are colour work, so the two features agree
   * on what a colour service is. A formula with no appointment, or whose
   * services carry no colour billing category, is keyed `uncategorised` and
   * compares only against other uncategorised formulas.
   */
  private async loadComparabilityKeys(
    businessId: string,
    formulas: FormulaRow[],
  ): Promise<Map<string, string>> {
    const keys = new Map<string, string>();
    const appointmentIds = [
      ...new Set(formulas.map((row) => row.appointment_id).filter((id): id is string => Boolean(id))),
    ];
    if (appointmentIds.length === 0) {
      for (const formula of formulas) keys.set(formula.id, 'uncategorised');
      return keys;
    }

    const { data: links, error: linkError } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .select('appointment_id,service_id')
      .in('appointment_id', appointmentIds)
      .returns<Array<{ appointment_id: string; service_id: string }>>();
    if (linkError) throw new Error(`load appointment services failed: ${linkError.message}`);

    const serviceIds = [...new Set((links ?? []).map((link) => link.service_id))];
    const categoryByService = new Map<string, string>();

    if (serviceIds.length > 0) {
      const { data: services, error: serviceError } = await this.admin
        .schema('booking')
        .from('services')
        .select('id,service_category_id')
        .eq('business_id', businessId)
        .in('id', serviceIds)
        .returns<Array<{ id: string; service_category_id: string | null }>>();
      if (serviceError) throw new Error(`load services failed: ${serviceError.message}`);

      const categoryIds = [
        ...new Set(
          (services ?? []).map((s) => s.service_category_id).filter((id): id is string => Boolean(id)),
        ),
      ];
      const billingByCategory = new Map<string, string>();

      if (categoryIds.length > 0) {
        const { data: categories, error: categoryError } = await this.admin
          .schema('booking')
          .from('service_categories')
          .select('id,billing_category')
          .eq('business_id', businessId)
          .in('id', categoryIds)
          .not('billing_category', 'is', null)
          .returns<Array<{ id: string; billing_category: string | null }>>();
        if (categoryError) throw new Error(`load service categories failed: ${categoryError.message}`);
        for (const category of categories ?? []) {
          if (category.billing_category) billingByCategory.set(category.id, category.billing_category);
        }
      }

      for (const service of services ?? []) {
        const billing = service.service_category_id
          ? billingByCategory.get(service.service_category_id)
          : undefined;
        if (billing) categoryByService.set(service.id, billing);
      }
    }

    const categoriesByAppointment = new Map<string, string[]>();
    for (const link of links ?? []) {
      const billing = categoryByService.get(link.service_id);
      if (!billing) continue;
      const list = categoriesByAppointment.get(link.appointment_id) ?? [];
      if (!list.includes(billing)) list.push(billing);
      categoriesByAppointment.set(link.appointment_id, list);
    }

    for (const formula of formulas) {
      const categories = formula.appointment_id
        ? categoriesByAppointment.get(formula.appointment_id) ?? []
        : [];
      keys.set(formula.id, formulaComparabilityKey(categories));
    }
    return keys;
  }

  /**
   * `products.stock_unit` for every referenced product.
   *
   * Needed because a share is only meaningful over ONE quantity basis. The
   * platform's canonical rule (inventory/unit-conversion.ts) is that gram,
   * millilitre and unit never convert into one another, so a formula mixing them
   * reports composition as unavailable rather than inventing a total.
   *
   * A missing product row (archived, deleted, or a manual line) is NOT an error:
   * historical formulas must stay interpretable even when the catalogue moves on
   * (Wrike section 38). Those components default to gram, which is what the
   * storage column already means.
   */
  private async loadStockUnits(businessId: string, productIds: string[]): Promise<Map<string, StockUnit>> {
    const units = new Map<string, StockUnit>();
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return units;

    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select('id,stock_unit')
      .eq('business_id', businessId)
      .in('id', ids)
      .returns<Array<{ id: string; stock_unit: string | null }>>();
    if (error) throw new Error(`load product stock units failed: ${error.message}`);

    for (const row of data ?? []) {
      const unit = row.stock_unit;
      if (unit === 'gram' || unit === 'millilitre' || unit === 'unit') units.set(row.id, unit);
    }
    return units;
  }

  private async assertClientInBusiness(businessId: string, clientProfileId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id')
      .eq('id', clientProfileId)
      .eq('business_id', businessId)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`verify client ${clientProfileId} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify the client');
    }
    // Same 404 for "another tenant's client" and "no such client": a
    // distinguishable 403 would confirm the id exists somewhere.
    if (!data) throw new NotFoundException('Client not found');
  }

  /** Undefined = no location filter (owners and clients). Otherwise the actor's own. */
  private readableLocationIds(actor: AuthUser): string[] | null {
    if (userHasRole(actor, 'owner') || userHasRole(actor, 'client')) return null;
    return actor.allowedLocationIds;
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /** Location override -> business default -> platform default. */
  async thresholdsFor(businessId: string, locationId: string | null): Promise<FormulaChangeThresholds> {
    try {
      const records = await this.loadSettingsRows(businessId);
      return resolveFormulaChangeThresholds(records, locationId);
    } catch (err) {
      // A settings read failure must not take down a client profile. Falling
      // back to platform defaults keeps detection deterministic and is the
      // conservative direction: the defaults are the least sensitive setting a
      // salon can be on, so a degraded read cannot manufacture a flag.
      this.logger.error(`load formula change settings failed: ${(err as Error).message}`);
      return { ...DEFAULT_FORMULA_CHANGE_THRESHOLDS };
    }
  }

  async getSettings(actor: AuthUser): Promise<FormulaChangeSettingsResponse> {
    this.assertSettingsRead(actor);
    const records = await this.loadSettingsRows(actor.businessId);

    const scopes: FormulaChangeSettingsScope[] = records.map((record) => ({
      locationId: record.locationId,
      compositionChangePercent: record.compositionChangePercent,
      componentMaterialityPercent: record.componentMaterialityPercent,
      developerVolumeDelta: record.developerVolumeDelta,
      configured: true,
    }));

    // Always surface the business-wide scope, even unconfigured, so an owner
    // sees the defaults actually in force rather than an empty list that reads
    // as "no policy".
    if (!scopes.some((scope) => scope.locationId === null)) {
      scopes.unshift({ locationId: null, ...DEFAULT_FORMULA_CHANGE_THRESHOLDS, configured: false });
    }
    scopes.sort((a, b) => {
      if (a.locationId === b.locationId) return 0;
      if (a.locationId === null) return -1;
      if (b.locationId === null) return 1;
      return a.locationId.localeCompare(b.locationId);
    });

    return { scopes, defaults: { ...DEFAULT_FORMULA_CHANGE_THRESHOLDS } };
  }

  async upsertSettings(
    actor: AuthUser,
    input: UpsertFormulaChangeSettingsDto,
  ): Promise<FormulaChangeSettingsResponse> {
    this.assertSettingsManage(actor);

    const errors = validateFormulaChangeThresholds(input);
    if (errors.length > 0) throw new BadRequestException(errors.join('; '));

    const locationId = input.locationId ?? null;
    if (locationId) await this.assertLocationInBusiness(actor.businessId, locationId);

    const before = resolveFormulaChangeThresholds(
      await this.loadSettingsRows(actor.businessId),
      locationId,
    );

    const { error } = await this.admin
      .schema('lab')
      .from('formula_change_settings')
      .upsert(
        {
          business_id: actor.businessId,
          location_id: locationId,
          composition_change_percent: input.compositionChangePercent,
          component_materiality_percent: input.componentMaterialityPercent,
          developer_volume_delta: input.developerVolumeDelta,
        },
        // Inferred against the `unique nulls not distinct (business_id,
        // location_id)` constraint from 0105, so the business-wide row upserts
        // as one row rather than accumulating duplicates.
        { onConflict: 'business_id,location_id' },
      );

    if (error) {
      this.logger.error(`upsert formula change settings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to save formula change settings');
    }

    await this.audit.record(actor, {
      action: 'formula_change_settings.updated',
      entityType: 'formula_change_settings',
      locationId,
      before: { ...before },
      after: {
        compositionChangePercent: input.compositionChangePercent,
        componentMaterialityPercent: input.componentMaterialityPercent,
        developerVolumeDelta: input.developerVolumeDelta,
      },
    });

    return this.getSettings(actor);
  }

  private async loadSettingsRows(businessId: string): Promise<FormulaChangeSettingsRecord[]> {
    const { data, error } = await this.admin
      .schema('lab')
      .from('formula_change_settings')
      .select('business_id,location_id,composition_change_percent,component_materiality_percent,developer_volume_delta')
      .eq('business_id', businessId)
      .returns<SettingsRow[]>();
    if (error) throw new Error(`load formula change settings failed: ${error.message}`);

    return (data ?? []).map((row) => ({
      businessId: row.business_id,
      locationId: row.location_id,
      compositionChangePercent: Number(row.composition_change_percent),
      componentMaterialityPercent: Number(row.component_materiality_percent),
      developerVolumeDelta: Number(row.developer_volume_delta),
    }));
  }

  /**
   * Reading the thresholds is open to owners and managers: the Colour Prep and
   * client-profile surfaces echo the thresholds that produced an assessment, and
   * a manager needs to see them to understand why a flag did or did not appear.
   */
  private assertSettingsRead(actor: AuthUser): void {
    if (!userHasAnyRole(actor, ['owner', 'manager'])) {
      throw new ForbiddenException('Formula change settings require owner or manager access');
    }
  }

  /** Changing sensitivity changes who gets warned — owner-only. */
  private assertSettingsManage(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Changing formula change sensitivity requires owner access');
    }
  }

  private async assertLocationInBusiness(businessId: string, locationId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('id', locationId)
      .eq('business_id', businessId)
      .maybeSingle<{ id: string }>();
    if (error) {
      this.logger.error(`verify location ${locationId} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to verify the location');
    }
    if (!data) throw new NotFoundException('Location not found');
  }
}

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

interface FormulaRow {
  id: string;
  client_profile_id: string;
  visit_id: string | null;
  appointment_id: string | null;
  saved_at: string;
  version: number;
  version_group_id: string;
  service_name_snapshot: string | null;
}

interface FormulaItemRow {
  formula_id: string;
  product_id: string | null;
  product_name: string;
  brand: string | null;
  developer: string | null;
  captured_grams: number | string;
}

interface SettingsRow {
  business_id: string;
  location_id: string | null;
  composition_change_percent: number | string;
  component_materiality_percent: number | string;
  developer_volume_delta: number | string;
}

/**
 * Keep only the highest version of each logical formula (Wrike section 35).
 *
 * `lab.formulas` carries `version` / `version_group_id` (0063). Today the save
 * RPC upserts one row per logical formula so every group has a single member,
 * but collapsing here means the day edit-with-history ships, one visit still
 * yields ONE comparison rather than three — the final version, never a draft
 * revision compared against another draft revision.
 *
 * Input must already be ordered newest-first; output preserves that order.
 */
function collapseRevisions(rows: FormulaRow[]): FormulaRow[] {
  const best = new Map<string, FormulaRow>();
  for (const row of rows) {
    const group = row.version_group_id ?? row.id;
    const existing = best.get(group);
    if (!existing || row.version > existing.version) best.set(group, row);
  }
  // Re-establish newest-first over the surviving rows.
  return [...best.values()].sort((a, b) => b.saved_at.localeCompare(a.saved_at));
}

/**
 * Stable component identity (Wrike section 48).
 *
 * A catalogue line is keyed on its product id, which survives renames, archiving
 * and replacement. A hand-entered line never had one, so it is keyed on its
 * normalised brand+name — the only identity it has. The two namespaces are kept
 * separate, so a manual line is never silently merged with a catalogue product,
 * and two different catalogue products are never merged because their names
 * happen to look alike.
 */
function componentIdentity(item: FormulaItemRow): string {
  if (item.product_id) return `product:${item.product_id}`;
  const brand = (item.brand ?? '').trim().toLowerCase();
  const name = (item.product_name ?? '').trim().toLowerCase();
  return `manual:${brand}|${name}`;
}

function displayName(item: FormulaItemRow): string {
  const brand = item.brand?.trim();
  const name = item.product_name?.trim() || 'Product';
  return brand ? `${brand} ${name}` : name;
}

function toSnapshot(
  formula: FormulaRow,
  itemsByFormula: Map<string, FormulaItemRow[]>,
  stockUnits: Map<string, StockUnit>,
): FormulaSnapshotInput {
  const rows = itemsByFormula.get(formula.id) ?? [];
  const components: FormulaComponentInput[] = rows.map((item) => ({
    identity: componentIdentity(item),
    displayName: displayName(item),
    quantity: typeof item.captured_grams === 'number' ? item.captured_grams : Number(item.captured_grams),
    stockUnit: item.product_id ? stockUnits.get(item.product_id) ?? 'gram' : 'gram',
    developer: item.developer,
  }));

  return {
    formulaId: formula.id,
    savedAt: formula.saved_at,
    // The key is resolved by the caller and attached to the row it belongs to;
    // the snapshot itself carries it only for completeness.
    comparabilityKey: 'resolved-by-caller',
    components,
    serviceName: formula.service_name_snapshot,
    visitId: formula.visit_id,
  };
}
