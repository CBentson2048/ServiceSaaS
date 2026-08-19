import {
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
  ColourPrepAppointment,
  ColourPrepAppointmentItem,
  ColourPrepPlan,
  ColourPrepProductRequirement,
  ColourPrepRange,
  ColourPrepStockState,
  ServiceBillingCategory,
  StockUnit,
} from '@sheer/domain';
import { userHasPermission, userHasRole } from '@sheer/domain';
import { resolveStockUnit, roundBaseQuantity } from '../inventory/unit-conversion';
import { resolveColourPrepWindow } from './date-range';
import type { ColourPrepQueryDto } from './dto';

/**
 * Colour Prep answers one question for the salon: for the colour appointments
 * coming up, what will we need to mix, and have we got it?
 *
 * It owns no data. Every figure is read from the authoritative source —
 * booking.appointments for what is coming, booking.service_categories for what
 * counts as colour work, lab.formulas for what the client had last time, and
 * inventory.location_stock for what is on the shelf. Nothing is duplicated or
 * cached, so the plan cannot drift from the systems it reports on.
 *
 * Reads are deliberately set-based: one query per table for the whole window,
 * stitched in memory. PostgREST cannot embed across schemas here (booking ->
 * lab -> inventory), and per-appointment queries would be an N+1 over a screen
 * that a salon opens every morning.
 */

/** Appointments still worth preparing for. Cancelled/finished work is excluded. */
const PREPARABLE_STATUSES = ['pending', 'confirmed', 'awaiting_acceptance', 'checked_in'];

/** Formula states that represent a finalized mix; drafts are not prep-worthy. */
const SAVED_FORMULA_STATUS = 'saved';

interface LocationRow {
  id: string;
  name: string;
  timezone: string;
  business_id: string;
}

interface LocationSettingsRow {
  location_id: string;
  waste_allowance_percent: number | string | null;
}

interface AppointmentRow {
  id: string;
  client_profile_id: string;
  assigned_staff_profile_id: string | null;
  scheduled_start_at: string;
  status: string;
}

interface AppointmentServiceRow {
  appointment_id: string;
  service_id: string;
  service_name_snapshot: string;
}

interface ServiceRow {
  id: string;
  service_category_id: string | null;
}

interface ServiceCategoryRow {
  id: string;
  billing_category: ServiceBillingCategory | null;
}

interface ClientRow {
  id: string;
  first_name: string;
  last_name: string;
}

interface StaffRow {
  id: string;
  display_name: string;
}

interface FormulaRow {
  id: string;
  client_profile_id: string;
  saved_at: string | null;
  status: string;
}

interface FormulaItemRow {
  formula_id: string;
  product_id: string | null;
  product_name: string | null;
  captured_grams: number | string | null;
}

interface ProductRow {
  id: string;
  name: string;
  brand: string | null;
  stock_unit: string | null;
  pack_size: number | string | null;
  size_value: number | string | null;
  low_stock_threshold_grams: number | string | null;
  is_active: boolean;
}

interface StockRow {
  product_id: string;
  quantity_on_hand_grams: number | string;
  low_stock_threshold_grams: number | string | null;
}

function toNumber(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function unique<T>(values: (T | null | undefined)[]): T[] {
  return [...new Set(values.filter((value): value is T => value !== null && value !== undefined))];
}

@Injectable()
export class ColourPrepService {
  private readonly logger = new Logger(ColourPrepService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async getPlan(actor: AuthUser, query: ColourPrepQueryDto): Promise<ColourPrepPlan> {
    this.assertCanReadPrep(actor);

    const location = await this.loadLocation(actor, query.locationId);
    const range: ColourPrepRange = query.range ?? 'today';
    const window = resolveColourPrepWindow(range, location.timezone, {
      from: query.from,
      to: query.to,
    });

    const wasteAllowancePercent = await this.loadWasteAllowance(location.id);
    const appointments = await this.loadAppointments(actor.businessId, location.id, window.from, window.to);

    const empty: ColourPrepPlan = {
      locationId: location.id,
      locationName: location.name,
      timezone: location.timezone,
      range,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      fromDate: window.fromDate,
      toDate: window.toDate,
      wasteAllowancePercent,
      appointments: [],
      products: [],
      summary: {
        appointmentCount: 0,
        appointmentsWithoutFormula: 0,
        productCount: 0,
        shortfallProductCount: 0,
        lowStockProductCount: 0,
        unmappedProductCount: 0,
      },
    };

    if (appointments.length === 0) return empty;

    // Which of those appointments are colour work? An appointment qualifies when
    // any of its services sits in a category mapped to a colour billing category.
    const colourByAppointment = await this.resolveColourAppointments(
      actor.businessId,
      appointments.map((appointment) => appointment.id),
    );

    const colourAppointments = appointments.filter((appointment) =>
      colourByAppointment.has(appointment.id),
    );
    if (colourAppointments.length === 0) return empty;

    const clientIds = unique(colourAppointments.map((appointment) => appointment.client_profile_id));
    const staffIds = unique(colourAppointments.map((appointment) => appointment.assigned_staff_profile_id));

    const [clients, staff, formulasByClient] = await Promise.all([
      this.loadClients(actor.businessId, clientIds),
      this.canSeeStylist(actor) ? this.loadStaff(actor.businessId, staffIds) : Promise.resolve(new Map()),
      this.loadLatestFormulas(actor.businessId, clientIds),
    ]);

    const formulaIds = [...formulasByClient.values()].map((formula) => formula.id);
    const itemsByFormula = await this.loadFormulaItems(formulaIds);

    const built = this.buildAppointments({
      appointments: colourAppointments,
      colourByAppointment,
      clients,
      staff,
      formulasByClient,
      itemsByFormula,
      wasteAllowancePercent,
    });

    const products = await this.buildProductRequirements(
      actor.businessId,
      location.id,
      built.requiredByProduct,
      built.unmappedByName,
    );

    return {
      ...empty,
      appointments: built.appointments,
      products,
      summary: {
        appointmentCount: built.appointments.length,
        appointmentsWithoutFormula: built.appointments.filter(
          (appointment) => appointment.state === 'no_formula_on_file',
        ).length,
        productCount: products.length,
        shortfallProductCount: products.filter((product) => product.state === 'shortfall').length,
        lowStockProductCount: products.filter((product) => product.state === 'low_stock').length,
        unmappedProductCount: products.filter(
          (product) => product.state === 'unmapped_product' || product.state === 'not_stocked',
        ).length,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Tenancy
  // ---------------------------------------------------------------------------

  /**
   * Colour Prep reads stock levels and client formula history, so it is gated on
   * the same key as the rest of the inventory surface. Widening this to stylists
   * would need a new permission key seeded in BOTH the migration and
   * PERMISSION_CATALOG (the 0074 lesson) and is deliberately out of Week 6.
   */
  private assertCanReadPrep(actor: AuthUser): void {
    if (!userHasPermission(actor, 'inventory.manage')) {
      throw new ForbiddenException('You do not have permission to view colour preparation');
    }
  }

  private canSeeStylist(actor: AuthUser): boolean {
    return userHasRole(actor, 'owner') || userHasRole(actor, 'manager');
  }

  /**
   * Resolves the location and proves the caller may see it. The location id is
   * never trusted from the request: it must belong to the caller's business AND
   * fall inside their location scope.
   */
  private async loadLocation(actor: AuthUser, locationId: string): Promise<LocationRow> {
    if (!userHasRole(actor, 'owner') && !actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your inventory scope');
    }

    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id,name,timezone,business_id')
      .eq('id', locationId)
      .eq('business_id', actor.businessId)
      .maybeSingle<LocationRow>();

    if (error) {
      this.logger.error(`colour-prep loadLocation failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }
    if (!data) throw new NotFoundException('Location was not found');
    return data;
  }

  private async loadWasteAllowance(locationId: string): Promise<number> {
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('location_id,waste_allowance_percent')
      .eq('location_id', locationId)
      .maybeSingle<LocationSettingsRow>();

    if (error) {
      this.logger.error(`colour-prep loadWasteAllowance failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }
    // 10% is the column default (0053); a location without a settings row yet
    // must behave like one that has never changed the value.
    return toNumber(data?.waste_allowance_percent, 10);
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  private async loadAppointments(
    businessId: string,
    locationId: string,
    from: Date,
    to: Date,
  ): Promise<AppointmentRow[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('id,client_profile_id,assigned_staff_profile_id,scheduled_start_at,status')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .gte('scheduled_start_at', from.toISOString())
      .lt('scheduled_start_at', to.toISOString())
      .in('status', PREPARABLE_STATUSES)
      .order('scheduled_start_at', { ascending: true })
      .returns<AppointmentRow[]>();

    if (error) {
      this.logger.error(`colour-prep loadAppointments failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }
    return data ?? [];
  }

  /**
   * Maps appointment id -> the colour categories it covers. An appointment with
   * no colour-mapped service is absent from the map and drops out of the plan.
   */
  private async resolveColourAppointments(
    businessId: string,
    appointmentIds: string[],
  ): Promise<Map<string, { categories: ServiceBillingCategory[]; serviceNames: string[] }>> {
    const result = new Map<string, { categories: ServiceBillingCategory[]; serviceNames: string[] }>();
    if (appointmentIds.length === 0) return result;

    const { data: links, error: linkError } = await this.admin
      .schema('booking')
      .from('appointment_services')
      .select('appointment_id,service_id,service_name_snapshot')
      .in('appointment_id', appointmentIds)
      .returns<AppointmentServiceRow[]>();

    if (linkError) {
      this.logger.error(`colour-prep loadAppointmentServices failed: ${linkError.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }
    if (!links || links.length === 0) return result;

    const serviceIds = unique(links.map((link) => link.service_id));
    const { data: services, error: serviceError } = await this.admin
      .schema('booking')
      .from('services')
      .select('id,service_category_id')
      .eq('business_id', businessId)
      .in('id', serviceIds)
      .returns<ServiceRow[]>();

    if (serviceError) {
      this.logger.error(`colour-prep loadServices failed: ${serviceError.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }

    const categoryIds = unique((services ?? []).map((service) => service.service_category_id));
    if (categoryIds.length === 0) return result;

    const { data: categories, error: categoryError } = await this.admin
      .schema('booking')
      .from('service_categories')
      .select('id,billing_category')
      .eq('business_id', businessId)
      .in('id', categoryIds)
      .not('billing_category', 'is', null)
      .returns<ServiceCategoryRow[]>();

    if (categoryError) {
      this.logger.error(`colour-prep loadServiceCategories failed: ${categoryError.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }

    const colourByCategory = new Map<string, ServiceBillingCategory>();
    for (const category of categories ?? []) {
      if (category.billing_category) colourByCategory.set(category.id, category.billing_category);
    }
    if (colourByCategory.size === 0) return result;

    const categoryByService = new Map<string, ServiceBillingCategory>();
    for (const service of services ?? []) {
      const colour = service.service_category_id
        ? colourByCategory.get(service.service_category_id)
        : undefined;
      if (colour) categoryByService.set(service.id, colour);
    }

    for (const link of links) {
      const colour = categoryByService.get(link.service_id);
      if (!colour) continue;
      const entry = result.get(link.appointment_id) ?? { categories: [], serviceNames: [] };
      if (!entry.categories.includes(colour)) entry.categories.push(colour);
      if (!entry.serviceNames.includes(link.service_name_snapshot)) {
        entry.serviceNames.push(link.service_name_snapshot);
      }
      result.set(link.appointment_id, entry);
    }
    return result;
  }

  private async loadClients(businessId: string, clientIds: string[]): Promise<Map<string, ClientRow>> {
    if (clientIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('core')
      .from('client_profiles')
      .select('id,first_name,last_name')
      .eq('business_id', businessId)
      .in('id', clientIds)
      .returns<ClientRow[]>();

    if (error) {
      this.logger.error(`colour-prep loadClients failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }
    return new Map((data ?? []).map((client) => [client.id, client]));
  }

  private async loadStaff(businessId: string, staffIds: string[]): Promise<Map<string, StaffRow>> {
    if (staffIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id,display_name')
      .eq('business_id', businessId)
      .in('id', staffIds)
      .returns<StaffRow[]>();

    if (error) {
      this.logger.error(`colour-prep loadStaff failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }
    return new Map((data ?? []).map((row) => [row.id, row]));
  }

  /**
   * The most recent finalized formula per client. Ordering descending and taking
   * the first row per client keeps this to one query rather than one per client.
   */
  private async loadLatestFormulas(
    businessId: string,
    clientIds: string[],
  ): Promise<Map<string, FormulaRow>> {
    if (clientIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('lab')
      .from('formulas')
      .select('id,client_profile_id,saved_at,status')
      .eq('business_id', businessId)
      .eq('status', SAVED_FORMULA_STATUS)
      .in('client_profile_id', clientIds)
      .order('saved_at', { ascending: false })
      .returns<FormulaRow[]>();

    if (error) {
      this.logger.error(`colour-prep loadLatestFormulas failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }

    const latest = new Map<string, FormulaRow>();
    for (const formula of data ?? []) {
      if (!latest.has(formula.client_profile_id)) latest.set(formula.client_profile_id, formula);
    }
    return latest;
  }

  private async loadFormulaItems(formulaIds: string[]): Promise<Map<string, FormulaItemRow[]>> {
    if (formulaIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('lab')
      .from('formula_items')
      .select('formula_id,product_id,product_name,captured_grams')
      .in('formula_id', formulaIds)
      .returns<FormulaItemRow[]>();

    if (error) {
      this.logger.error(`colour-prep loadFormulaItems failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }

    const grouped = new Map<string, FormulaItemRow[]>();
    for (const item of data ?? []) {
      const bucket = grouped.get(item.formula_id) ?? [];
      bucket.push(item);
      grouped.set(item.formula_id, bucket);
    }
    return grouped;
  }

  // ---------------------------------------------------------------------------
  // Assembly
  // ---------------------------------------------------------------------------

  private buildAppointments(input: {
    appointments: AppointmentRow[];
    colourByAppointment: Map<string, { categories: ServiceBillingCategory[]; serviceNames: string[] }>;
    clients: Map<string, ClientRow>;
    staff: Map<string, StaffRow>;
    formulasByClient: Map<string, FormulaRow>;
    itemsByFormula: Map<string, FormulaItemRow[]>;
    wasteAllowancePercent: number;
  }): {
    appointments: ColourPrepAppointment[];
    requiredByProduct: Map<string, { grams: number; appointments: Set<string> }>;
    unmappedByName: Map<string, { grams: number; appointments: Set<string>; displayName: string }>;
  } {
    const uplift = 1 + Math.max(input.wasteAllowancePercent, 0) / 100;
    const requiredByProduct = new Map<string, { grams: number; appointments: Set<string> }>();
    // Keyed case-insensitively so "Bond builder" and "bond Builder" aggregate,
    // but the first spelling seen is kept for display.
    const unmappedByName = new Map<
      string,
      { grams: number; appointments: Set<string>; displayName: string }
    >();
    const appointments: ColourPrepAppointment[] = [];

    for (const row of input.appointments) {
      const colour = input.colourByAppointment.get(row.id);
      const client = input.clients.get(row.client_profile_id);
      const formula = input.formulasByClient.get(row.client_profile_id);
      const staff = row.assigned_staff_profile_id
        ? input.staff.get(row.assigned_staff_profile_id)
        : undefined;

      const items: ColourPrepAppointmentItem[] = [];
      for (const item of formula ? (input.itemsByFormula.get(formula.id) ?? []) : []) {
        const captured = toNumber(item.captured_grams);
        if (captured <= 0) continue;

        // The waste allowance is a planning uplift, not history: it is what the
        // salon expects to lose mixing, and it reuses the location setting Luke
        // already configures rather than inventing a second waste figure.
        const required = roundBaseQuantity(captured * uplift);
        const name = item.product_name?.trim() || 'Unnamed product';
        items.push({ productId: item.product_id ?? undefined, productName: name, requiredGrams: required });

        if (item.product_id) {
          const existing = requiredByProduct.get(item.product_id) ?? {
            grams: 0,
            appointments: new Set<string>(),
          };
          existing.grams = roundBaseQuantity(existing.grams + required);
          existing.appointments.add(row.id);
          requiredByProduct.set(item.product_id, existing);
        } else {
          const key = name.toLowerCase();
          const existing = unmappedByName.get(key) ?? {
            grams: 0,
            appointments: new Set<string>(),
            displayName: name,
          };
          existing.grams = roundBaseQuantity(existing.grams + required);
          existing.appointments.add(row.id);
          unmappedByName.set(key, existing);
        }
      }

      appointments.push({
        appointmentId: row.id,
        scheduledStartAt: row.scheduled_start_at,
        clientProfileId: row.client_profile_id,
        clientName: client ? `${client.first_name} ${client.last_name}`.trim() : 'Unknown client',
        stylistName: staff?.display_name,
        serviceNames: colour?.serviceNames ?? [],
        billingCategories: colour?.categories ?? [],
        // A first-time colour client has no formula and must still appear here,
        // flagged for consultation rather than silently dropped from the plan.
        state: formula && items.length > 0 ? 'formula_on_file' : 'no_formula_on_file',
        formulaId: formula?.id,
        formulaSavedAt: formula?.saved_at ?? undefined,
        items,
      });
    }

    return { appointments, requiredByProduct, unmappedByName };
  }

  private async buildProductRequirements(
    businessId: string,
    locationId: string,
    requiredByProduct: Map<string, { grams: number; appointments: Set<string> }>,
    unmappedByName: Map<string, { grams: number; appointments: Set<string>; displayName: string }>,
  ): Promise<ColourPrepProductRequirement[]> {
    const productIds = [...requiredByProduct.keys()];
    const [products, stock] = await Promise.all([
      this.loadProducts(businessId, productIds),
      this.loadStock(locationId, productIds),
    ]);

    const requirements: ColourPrepProductRequirement[] = [];

    for (const [productId, required] of requiredByProduct) {
      const product = products.get(productId);
      const stockRow = stock.get(productId);
      const onHand = stockRow ? toNumber(stockRow.quantity_on_hand_grams) : 0;
      const threshold = stockRow
        ? toNumber(stockRow.low_stock_threshold_grams, toNumber(product?.low_stock_threshold_grams, 0))
        : toNumber(product?.low_stock_threshold_grams, 0);
      const shortfall = roundBaseQuantity(Math.max(0, required.grams - onHand));

      requirements.push({
        productId,
        productName: product?.name ?? 'Unknown product',
        brand: product?.brand ?? undefined,
        stockUnit: resolveStockUnit({
          stockUnit: (product?.stock_unit ?? null) as StockUnit | null,
          packSize: toNumber(product?.pack_size, 0) || null,
          sizeValue: toNumber(product?.size_value, 0) || null,
        }),
        requiredGrams: required.grams,
        onHandGrams: onHand,
        shortfallGrams: shortfall,
        lowStockThresholdGrams: threshold > 0 ? threshold : undefined,
        state: this.resolveState({ hasStockRow: Boolean(stockRow), required: required.grams, onHand, threshold }),
        appointmentCount: required.appointments.size,
      });
    }

    // Formula lines that were never linked to a catalogue product cannot be
    // checked against stock at all. They are surfaced as their own state so the
    // screen can never present missing data as "enough stock".
    for (const required of unmappedByName.values()) {
      requirements.push({
        productId: undefined,
        productName: required.displayName,
        stockUnit: 'gram',
        requiredGrams: required.grams,
        onHandGrams: 0,
        shortfallGrams: required.grams,
        state: 'unmapped_product',
        appointmentCount: required.appointments.size,
      });
    }

    const severity: Record<ColourPrepStockState, number> = {
      shortfall: 0,
      unmapped_product: 1,
      not_stocked: 2,
      low_stock: 3,
      sufficient: 4,
    };
    return requirements.sort(
      (a, b) => severity[a.state] - severity[b.state] || b.shortfallGrams - a.shortfallGrams,
    );
  }

  /**
   * `not_stocked` is distinct from a zero balance: the product has never been
   * stocked at this location, which is a setup problem rather than a reorder.
   */
  private resolveState(input: {
    hasStockRow: boolean;
    required: number;
    onHand: number;
    threshold: number;
  }): ColourPrepStockState {
    if (!input.hasStockRow) return 'not_stocked';
    if (input.onHand < input.required) return 'shortfall';
    if (input.threshold > 0 && input.onHand - input.required <= input.threshold) return 'low_stock';
    return 'sufficient';
  }

  private async loadProducts(businessId: string, productIds: string[]): Promise<Map<string, ProductRow>> {
    if (productIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select('id,name,brand,stock_unit,pack_size,size_value,low_stock_threshold_grams,is_active')
      .eq('business_id', businessId)
      .in('id', productIds)
      .returns<ProductRow[]>();

    if (error) {
      this.logger.error(`colour-prep loadProducts failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }
    return new Map((data ?? []).map((product) => [product.id, product]));
  }

  private async loadStock(locationId: string, productIds: string[]): Promise<Map<string, StockRow>> {
    if (productIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('inventory')
      .from('location_stock')
      .select('product_id,quantity_on_hand_grams,low_stock_threshold_grams')
      .eq('location_id', locationId)
      .in('product_id', productIds)
      .returns<StockRow[]>();

    if (error) {
      this.logger.error(`colour-prep loadStock failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load colour preparation');
    }
    return new Map((data ?? []).map((row) => [row.product_id, row]));
  }
}
