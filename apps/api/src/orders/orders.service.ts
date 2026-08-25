import {
  BadRequestException,
  ConflictException,
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
  BusinessLocationSummary,
  GeneratePurchaseOrdersResponse,
  ListPurchaseOrdersResponse,
  Permission,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderResponse,
  PurchaseOrderStatus,
  SendPurchaseOrderResponse,
  StockUnit,
  UnorderableProduct,
} from '@sheer/domain';
import { userHasPermission, userHasRole } from '@sheer/domain';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { renderPurchaseOrderEmail } from '../email/templates/purchase-order.template';
import { computeShortfallBase, resolveOrderPackSize, suggestOrderPacks } from './reorder-math';
import type { GenerateOrdersDto, ListOrdersQueryDto, UpdateOrderDto } from './dto';

interface OrderRow {
  id: string;
  business_id: string;
  location_id: string;
  supplier_id: string;
  order_number: string;
  status: PurchaseOrderStatus;
  currency_code: string;
  subtotal_cents: number;
  notes: string | null;
  created_by: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  sent_at: string | null;
  sent_to_email: string | null;
  send_error: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface OrderLineRow {
  id: string;
  purchase_order_id: string;
  product_id: string;
  product_name_snapshot: string;
  pack_size_snapshot: number | string | null;
  stock_unit_snapshot: string;
  suggested_quantity: number;
  ordered_quantity: number;
  unit_cost_cents: number | null;
  line_total_cents: number;
}

interface SupplierRow {
  id: string;
  name: string;
  contact_email: string | null;
  account_reference: string | null;
  is_active: boolean;
}

interface StockRow {
  product_id: string;
  quantity_on_hand_grams: number | string;
  low_stock_threshold_grams: number | string | null;
}

interface ProductRow {
  id: string;
  name: string;
  is_active: boolean;
  stock_unit: string | null;
  pack_size: number | string | null;
  size_value: number | string | null;
  default_cost_per_gram_cents: number | null;
  low_stock_threshold_grams: number | string;
  supplier_id: string | null;
  minimum_order_quantity: number;
  order_multiple: number;
}

const ORDER_COLUMNS =
  'id,business_id,location_id,supplier_id,order_number,status,currency_code,subtotal_cents,notes,created_by,submitted_at,approved_at,approved_by,sent_at,sent_to_email,send_error,cancelled_at,created_at,updated_at';
const LINE_COLUMNS =
  'id,purchase_order_id,product_id,product_name_snapshot,pack_size_snapshot,stock_unit_snapshot,suggested_quantity,ordered_quantity,unit_cost_cents,line_total_cents';
const SUPPLIER_COLUMNS = 'id,name,contact_email,account_reference,is_active';
const PRODUCT_COLUMNS =
  'id,name,is_active,stock_unit,pack_size,size_value,default_cost_per_gram_cents,low_stock_threshold_grams,supplier_id,minimum_order_quantity,order_multiple';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private readonly admin: SupabaseClient;

  constructor(
    config: ConfigService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
  ) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  // ---------------------------------------------------------------------------
  // Ticket 8 — generate draft orders from trailing usage
  // ---------------------------------------------------------------------------

  async generate(actor: AuthUser, dto: GenerateOrdersDto): Promise<GeneratePurchaseOrdersResponse> {
    this.assertPermission(actor, 'orders.manage');
    await this.assertLocationScope(actor, dto.locationId);

    const { windowWeeks, coverageWeeks } = await this.fetchReorderSettings(
      actor.businessId,
      dto.locationId,
    );
    const since = new Date(Date.now() - windowWeeks * 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data: usageData, error: usageError } = await this.admin
      .schema('inventory')
      .rpc('reorder_usage', {
        p_business_id: actor.businessId,
        p_location_id: dto.locationId,
        p_from: since,
      });
    if (usageError) {
      this.logger.error(`reorder_usage failed: ${usageError.message}`);
      throw new InternalServerErrorException('Unable to compute product usage');
    }
    const usage = new Map(
      ((usageData ?? []) as { product_id: string; outbound_base: number | string }[]).map((row) => [
        row.product_id,
        Number(row.outbound_base),
      ]),
    );

    const [stock, products, suppliers] = await Promise.all([
      this.fetchActiveStock(actor.businessId, dto.locationId),
      this.fetchProducts(actor.businessId),
      this.fetchSuppliers(actor.businessId),
    ]);

    const unorderable: UnorderableProduct[] = [];
    const linesBySupplier = new Map<
      string,
      {
        product_id: string;
        product_name: string;
        pack_size: number;
        stock_unit: StockUnit;
        suggested_quantity: number;
        ordered_quantity: number;
        unit_cost_cents: number | null;
        line_total_cents: number;
      }[]
    >();

    for (const row of stock) {
      const product = products.get(row.product_id);
      if (!product || !product.is_active) continue;

      const stockUnit = (product.stock_unit ?? 'gram') as StockUnit;
      const inputs = {
        onHandBase: Number(row.quantity_on_hand_grams),
        outboundBaseInWindow: usage.get(row.product_id) ?? 0,
        usageWindowWeeks: windowWeeks,
        coverageWeeks,
        lowStockThresholdBase: Number(
          row.low_stock_threshold_grams ?? product.low_stock_threshold_grams ?? 0,
        ),
        packSize:
          product.pack_size === null || product.pack_size === undefined
            ? product.size_value === null || product.size_value === undefined
              ? null
              : Number(product.size_value)
            : Number(product.pack_size),
        stockUnit,
        minimumOrderQuantity: Number(product.minimum_order_quantity ?? 1),
        orderMultiple: Number(product.order_multiple ?? 1),
      };

      if (computeShortfallBase(inputs) <= 0) continue;

      const supplier = product.supplier_id ? suppliers.get(product.supplier_id) : undefined;
      if (!supplier || !supplier.is_active) {
        unorderable.push({ productId: product.id, productName: product.name, reason: 'no_supplier' });
        continue;
      }
      const packSize = resolveOrderPackSize(stockUnit, inputs.packSize);
      if (packSize === null) {
        unorderable.push({ productId: product.id, productName: product.name, reason: 'no_pack_size' });
        continue;
      }

      const suggestion = suggestOrderPacks(inputs);
      if (!suggestion) continue;

      const unitCost =
        product.default_cost_per_gram_cents === null
          ? null
          : Math.round(packSize * product.default_cost_per_gram_cents);
      const lines = linesBySupplier.get(supplier.id) ?? [];
      lines.push({
        product_id: product.id,
        product_name: product.name,
        pack_size: packSize,
        stock_unit: stockUnit,
        suggested_quantity: suggestion.packs,
        ordered_quantity: suggestion.packs,
        unit_cost_cents: unitCost,
        line_total_cents: unitCost === null ? 0 : suggestion.packs * unitCost,
      });
      linesBySupplier.set(supplier.id, lines);
    }

    const created: PurchaseOrder[] = [];
    const skippedExistingOrder: GeneratePurchaseOrdersResponse['skippedExistingOrder'] = [];

    for (const [supplierId, lines] of linesBySupplier) {
      const subtotal = lines.reduce((total, line) => total + line.line_total_cents, 0);
      const { data, error } = await this.admin.schema('inventory').rpc('create_purchase_order', {
        p_order: {
          business_id: actor.businessId,
          location_id: dto.locationId,
          supplier_id: supplierId,
          subtotal_cents: subtotal,
          created_by: actor.id,
        },
        p_lines: lines,
      });
      if (error) {
        this.logger.error(`create_purchase_order failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to create purchase order');
      }
      const result = (Array.isArray(data) ? data[0] : data) as
        | { id: string; order_number: string; created: boolean }
        | undefined;
      if (!result) throw new InternalServerErrorException('Unable to create purchase order');

      if (result.created) {
        await this.audit.record(actor, {
          action: 'purchase_order.created',
          entityType: 'purchase_order',
          entityId: result.id,
          locationId: dto.locationId,
          metadata: { orderNumber: result.order_number, supplierId, lineCount: lines.length, subtotalCents: subtotal },
        });
        created.push(await this.getOrder(actor, result.id).then((r) => r.order));
      } else {
        const supplier = suppliers.get(supplierId);
        skippedExistingOrder.push({
          supplierId,
          supplierName: supplier?.name ?? 'Unknown supplier',
          orderId: result.id,
          orderNumber: result.order_number,
        });
      }
    }

    return {
      created,
      skippedExistingOrder,
      unorderable,
      nothingNeeded: created.length === 0 && skippedExistingOrder.length === 0 && unorderable.length === 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async list(actor: AuthUser, query: ListOrdersQueryDto): Promise<ListPurchaseOrdersResponse> {
    this.assertPermission(actor, 'orders.view');
    const locationIds = await this.resolveLocationScope(actor, query.locationId);
    const locations = await this.fetchLocations(actor.businessId, locationIds);
    if (locationIds.length === 0) return { orders: [], locations };

    let request = this.admin
      .schema('inventory')
      .from('purchase_orders')
      .select(ORDER_COLUMNS)
      .eq('business_id', actor.businessId)
      .in('location_id', locationIds)
      .order('created_at', { ascending: false })
      .limit(100);
    if (query.status) request = request.eq('status', query.status);
    if (query.supplierId) request = request.eq('supplier_id', query.supplierId);

    const { data, error } = await request.returns<OrderRow[]>();
    if (error) {
      this.logger.error(`list orders failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load purchase orders');
    }
    const orders = await this.decorateOrders(actor.businessId, data ?? [], locations);
    return { orders, locations };
  }

  async getOrder(actor: AuthUser, orderId: string): Promise<PurchaseOrderResponse> {
    this.assertPermission(actor, 'orders.view');
    const row = await this.fetchOrderRow(actor.businessId, orderId);
    await this.assertLocationScope(actor, row.location_id);
    const locations = await this.fetchLocations(actor.businessId, [row.location_id]);
    const [order] = await this.decorateOrders(actor.businessId, [row], locations);
    return { order };
  }

  // ---------------------------------------------------------------------------
  // Draft editing
  // ---------------------------------------------------------------------------

  async update(actor: AuthUser, orderId: string, dto: UpdateOrderDto): Promise<PurchaseOrderResponse> {
    this.assertPermission(actor, 'orders.manage');
    const row = await this.fetchOrderRow(actor.businessId, orderId);
    await this.assertLocationScope(actor, row.location_id);
    if (row.status !== 'draft') {
      throw new ConflictException('Only draft orders can be edited');
    }

    if (dto.notes !== undefined) {
      const { error } = await this.admin
        .schema('inventory')
        .from('purchase_orders')
        .update({ notes: dto.notes?.trim() || null })
        .eq('id', orderId)
        .eq('business_id', actor.businessId);
      if (error) {
        this.logger.error(`update order notes failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to update purchase order');
      }
    }

    if (dto.lines?.length) {
      const lineRows = await this.fetchLineRows([orderId]);
      const byId = new Map(lineRows.map((line) => [line.id, line]));
      for (const change of dto.lines) {
        const line = byId.get(change.id);
        if (!line) throw new BadRequestException('Line does not belong to this order');
        const lineTotal =
          line.unit_cost_cents === null ? 0 : change.orderedQuantity * line.unit_cost_cents;
        const { error } = await this.admin
          .schema('inventory')
          .from('purchase_order_lines')
          .update({ ordered_quantity: change.orderedQuantity, line_total_cents: lineTotal })
          .eq('id', change.id)
          .eq('purchase_order_id', orderId);
        if (error) {
          this.logger.error(`update order line failed: ${error.message}`);
          throw new InternalServerErrorException('Unable to update order line');
        }
      }
      const refreshed = await this.fetchLineRows([orderId]);
      const subtotal = refreshed.reduce((total, line) => total + Number(line.line_total_cents), 0);
      const { error } = await this.admin
        .schema('inventory')
        .from('purchase_orders')
        .update({ subtotal_cents: subtotal })
        .eq('id', orderId)
        .eq('business_id', actor.businessId);
      if (error) {
        this.logger.error(`update order subtotal failed: ${error.message}`);
        throw new InternalServerErrorException('Unable to update purchase order');
      }
    }

    return this.getOrder(actor, orderId);
  }

  // ---------------------------------------------------------------------------
  // Ticket 9 — the state machine
  // ---------------------------------------------------------------------------

  async submit(actor: AuthUser, orderId: string): Promise<PurchaseOrderResponse> {
    return this.transition(actor, orderId, {
      permission: 'orders.manage',
      from: ['draft'],
      patch: { status: 'pending_approval', submitted_at: new Date().toISOString() },
      action: 'purchase_order.submitted',
      failure: 'Only a draft order can be submitted for approval',
    });
  }

  async approve(actor: AuthUser, orderId: string): Promise<PurchaseOrderResponse> {
    return this.transition(actor, orderId, {
      permission: 'orders.approve',
      from: ['pending_approval'],
      patch: {
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: actor.id,
      },
      action: 'purchase_order.approved',
      failure: 'Only a submitted order can be approved',
    });
  }

  async cancel(actor: AuthUser, orderId: string): Promise<PurchaseOrderResponse> {
    const row = await this.fetchOrderRow(actor.businessId, orderId);
    // Cancelling an APPROVED order un-authorises spend, so it needs the same
    // authority that approved it; open drafts can be withdrawn by whoever
    // prepares orders. Sent orders are history and can never be cancelled here.
    const permission: Permission = row.status === 'approved' ? 'orders.approve' : 'orders.manage';
    return this.transition(actor, orderId, {
      permission,
      from: ['draft', 'pending_approval', 'approved'],
      patch: { status: 'cancelled', cancelled_at: new Date().toISOString() },
      action: 'purchase_order.cancelled',
      failure: 'A sent or cancelled order cannot be cancelled',
    });
  }

  async send(actor: AuthUser, orderId: string): Promise<SendPurchaseOrderResponse> {
    this.assertPermission(actor, 'orders.approve');
    const row = await this.fetchOrderRow(actor.businessId, orderId);
    await this.assertLocationScope(actor, row.location_id);
    if (row.status !== 'approved') {
      throw new ConflictException(
        row.status === 'sent' ? 'This order has already been sent' : 'Only an approved order can be sent',
      );
    }

    const [suppliers, locations, businessName, lines] = await Promise.all([
      this.fetchSuppliers(actor.businessId),
      this.fetchLocations(actor.businessId, [row.location_id]),
      this.fetchBusinessName(actor.businessId),
      this.fetchLineRows([orderId]),
    ]);
    const supplier = suppliers.get(row.supplier_id);
    if (!supplier) throw new NotFoundException('Supplier no longer exists');
    if (!supplier.contact_email) {
      throw new BadRequestException(
        `${supplier.name} has no order email. Add one under Inventory → Suppliers, then send again.`,
      );
    }

    const emailLines = lines
      .filter((line) => line.ordered_quantity > 0)
      .map((line) => ({
        productName: line.product_name_snapshot,
        packSize:
          line.pack_size_snapshot === null ? undefined : Number(line.pack_size_snapshot),
        stockUnit: (line.stock_unit_snapshot ?? 'gram') as 'gram' | 'millilitre' | 'unit',
        quantity: line.ordered_quantity,
      }));
    if (emailLines.length === 0) {
      throw new BadRequestException('Every line is zero — there is nothing to order');
    }

    const rendered = renderPurchaseOrderEmail({
      supplierName: supplier.name,
      businessName,
      locationName: locations[0]?.name ?? 'Unknown location',
      accountReference: supplier.account_reference ?? undefined,
      orderNumber: row.order_number,
      lines: emailLines,
      notes: row.notes ?? undefined,
      contactEmail: actor.profile.email || undefined,
    });

    const result = await this.email.send({
      to: supplier.contact_email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      replyTo: actor.profile.email || undefined,
      tags: [{ name: 'type', value: 'purchase_order' }],
    });

    if (result.delivered) {
      // Conditional on status so a concurrent send cannot double-record; the
      // race window between delivery and this update is accepted (a duplicate
      // email to a supplier is an apology, not a data corruption).
      const { data, error } = await this.admin
        .schema('inventory')
        .from('purchase_orders')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          sent_to_email: supplier.contact_email,
          send_error: null,
        })
        .eq('id', orderId)
        .eq('business_id', actor.businessId)
        .eq('status', 'approved')
        .select(ORDER_COLUMNS)
        .maybeSingle<OrderRow>();
      if (error || !data) {
        this.logger.error(`record sent failed: ${error?.message ?? 'state moved'}`);
        throw new InternalServerErrorException('Order was emailed but recording the send failed — check before resending');
      }
      await this.audit.record(actor, {
        action: 'purchase_order.sent',
        entityType: 'purchase_order',
        entityId: orderId,
        locationId: row.location_id,
        metadata: { orderNumber: row.order_number, sentToEmail: supplier.contact_email },
      });
      const [order] = await this.decorateOrders(actor.businessId, [data], locations);
      return { order, delivered: true };
    }

    const failure = result.error ?? 'Email delivery failed';
    const { data } = await this.admin
      .schema('inventory')
      .from('purchase_orders')
      .update({ send_error: failure })
      .eq('id', orderId)
      .eq('business_id', actor.businessId)
      .select(ORDER_COLUMNS)
      .maybeSingle<OrderRow>();
    await this.audit.record(actor, {
      action: 'purchase_order.send_failed',
      entityType: 'purchase_order',
      entityId: orderId,
      locationId: row.location_id,
      metadata: { orderNumber: row.order_number, error: failure },
    });
    const [order] = await this.decorateOrders(actor.businessId, [data ?? row], locations);
    return { order, delivered: false, error: failure };
  }

  private async transition(
    actor: AuthUser,
    orderId: string,
    opts: {
      permission: Permission;
      from: PurchaseOrderStatus[];
      patch: Record<string, unknown>;
      action: string;
      failure: string;
    },
  ): Promise<PurchaseOrderResponse> {
    this.assertPermission(actor, opts.permission);
    const row = await this.fetchOrderRow(actor.businessId, orderId);
    await this.assertLocationScope(actor, row.location_id);

    // Conditional on the current status set so two racing calls cannot both
    // transition: the loser's update matches no row and reports the conflict.
    const { data, error } = await this.admin
      .schema('inventory')
      .from('purchase_orders')
      .update(opts.patch)
      .eq('id', orderId)
      .eq('business_id', actor.businessId)
      .in('status', opts.from)
      .select(ORDER_COLUMNS)
      .maybeSingle<OrderRow>();
    if (error) {
      this.logger.error(`${opts.action} failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update purchase order');
    }
    if (!data) throw new ConflictException(opts.failure);

    await this.audit.record(actor, {
      action: opts.action,
      entityType: 'purchase_order',
      entityId: orderId,
      locationId: data.location_id,
      before: { status: row.status },
      after: { status: data.status },
      metadata: { orderNumber: data.order_number },
    });

    const locations = await this.fetchLocations(actor.businessId, [data.location_id]);
    const [order] = await this.decorateOrders(actor.businessId, [data], locations);
    return { order };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private assertPermission(actor: AuthUser, permission: Permission): void {
    if (!userHasPermission(actor, permission)) {
      throw new ForbiddenException(`You do not have the ${permission} permission`);
    }
  }

  private async assertLocationScope(actor: AuthUser, locationId: string): Promise<void> {
    if (!userHasRole(actor, 'owner') && !actor.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException('Location is outside your scope');
    }
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id')
      .eq('business_id', actor.businessId)
      .eq('id', locationId)
      .maybeSingle<{ id: string }>();
    if (error) throw new InternalServerErrorException('Unable to validate location');
    if (!data) throw new BadRequestException('locationId is not valid for this business');
  }

  private async resolveLocationScope(actor: AuthUser, locationId?: string): Promise<string[]> {
    if (locationId) {
      await this.assertLocationScope(actor, locationId);
      return [locationId];
    }
    if (userHasRole(actor, 'owner')) {
      const locations = await this.fetchLocations(actor.businessId);
      return locations.map((location) => location.id);
    }
    return actor.allowedLocationIds;
  }

  private async fetchOrderRow(businessId: string, orderId: string): Promise<OrderRow> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('purchase_orders')
      .select(ORDER_COLUMNS)
      .eq('business_id', businessId)
      .eq('id', orderId)
      .maybeSingle<OrderRow>();
    if (error) {
      this.logger.error(`fetchOrderRow failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load purchase order');
    }
    if (!data) throw new NotFoundException('Purchase order not found');
    return data;
  }

  private async fetchLineRows(orderIds: string[]): Promise<OrderLineRow[]> {
    if (orderIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('inventory')
      .from('purchase_order_lines')
      .select(LINE_COLUMNS)
      .in('purchase_order_id', orderIds)
      .order('product_name_snapshot', { ascending: true })
      .returns<OrderLineRow[]>();
    if (error) {
      this.logger.error(`fetchLineRows failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load order lines');
    }
    return data ?? [];
  }

  private async fetchSuppliers(businessId: string): Promise<Map<string, SupplierRow>> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('suppliers')
      .select(SUPPLIER_COLUMNS)
      .eq('business_id', businessId)
      .returns<SupplierRow[]>();
    if (error) {
      this.logger.error(`fetchSuppliers failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load suppliers');
    }
    return new Map((data ?? []).map((row) => [row.id, row]));
  }

  private async fetchProducts(businessId: string): Promise<Map<string, ProductRow>> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('products')
      .select(PRODUCT_COLUMNS)
      .eq('business_id', businessId)
      .returns<ProductRow[]>();
    if (error) {
      this.logger.error(`fetchProducts failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load products');
    }
    return new Map((data ?? []).map((row) => [row.id, row]));
  }

  private async fetchActiveStock(businessId: string, locationId: string): Promise<StockRow[]> {
    const { data, error } = await this.admin
      .schema('inventory')
      .from('location_stock')
      .select('product_id,quantity_on_hand_grams,low_stock_threshold_grams')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .eq('is_active', true)
      .returns<StockRow[]>();
    if (error) {
      this.logger.error(`fetchActiveStock failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load location stock');
    }
    return data ?? [];
  }

  private async fetchReorderSettings(
    businessId: string,
    locationId: string,
  ): Promise<{ windowWeeks: number; coverageWeeks: number }> {
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('reorder_usage_window_weeks,reorder_coverage_weeks')
      .eq('business_id', businessId)
      .eq('location_id', locationId)
      .maybeSingle<{
        reorder_usage_window_weeks: number | string | null;
        reorder_coverage_weeks: number | string | null;
      }>();
    if (error) {
      this.logger.error(`fetchReorderSettings failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load reorder settings');
    }
    return {
      windowWeeks: Number(data?.reorder_usage_window_weeks ?? 8) || 8,
      coverageWeeks: Number(data?.reorder_coverage_weeks ?? 4) || 4,
    };
  }

  private async fetchLocations(businessId: string, locationIds?: string[]): Promise<BusinessLocationSummary[]> {
    let query = this.admin.schema('core').from('locations').select('id,name').eq('business_id', businessId);
    if (locationIds) {
      if (locationIds.length === 0) return [];
      query = query.in('id', locationIds);
    }
    const { data, error } = await query.order('name', { ascending: true }).returns<{ id: string; name: string }[]>();
    if (error) throw new InternalServerErrorException('Unable to load locations');
    return (data ?? []).map((row) => ({ id: row.id, name: row.name }));
  }

  private async fetchBusinessName(businessId: string): Promise<string> {
    const { data, error } = await this.admin
      .schema('core')
      .from('businesses')
      .select('name')
      .eq('id', businessId)
      .maybeSingle<{ name: string }>();
    if (error) throw new InternalServerErrorException('Unable to load business');
    return data?.name ?? 'Your salon';
  }

  private async decorateOrders(
    businessId: string,
    rows: OrderRow[],
    locations: BusinessLocationSummary[],
  ): Promise<PurchaseOrder[]> {
    if (rows.length === 0) return [];
    const [lines, suppliers] = await Promise.all([
      this.fetchLineRows(rows.map((row) => row.id)),
      this.fetchSuppliers(businessId),
    ]);
    const linesByOrder = new Map<string, PurchaseOrderLine[]>();
    for (const line of lines) {
      const mapped: PurchaseOrderLine = {
        id: line.id,
        productId: line.product_id,
        productName: line.product_name_snapshot,
        packSize: line.pack_size_snapshot === null ? undefined : Number(line.pack_size_snapshot),
        stockUnit: (line.stock_unit_snapshot ?? 'gram') as StockUnit,
        suggestedQuantity: Number(line.suggested_quantity),
        orderedQuantity: Number(line.ordered_quantity),
        unitCostCents: line.unit_cost_cents ?? undefined,
        lineTotalCents: Number(line.line_total_cents),
      };
      const existing = linesByOrder.get(line.purchase_order_id) ?? [];
      existing.push(mapped);
      linesByOrder.set(line.purchase_order_id, existing);
    }

    return rows.map((row) => {
      const supplier = suppliers.get(row.supplier_id);
      return {
        id: row.id,
        orderNumber: row.order_number,
        businessId: row.business_id,
        locationId: row.location_id,
        locationName: locations.find((location) => location.id === row.location_id)?.name ?? 'Unknown location',
        supplierId: row.supplier_id,
        supplierName: supplier?.name ?? 'Unknown supplier',
        supplierEmail: supplier?.contact_email ?? undefined,
        status: row.status,
        currencyCode: row.currency_code,
        subtotalCents: Number(row.subtotal_cents),
        notes: row.notes ?? undefined,
        createdBy: row.created_by ?? undefined,
        submittedAt: row.submitted_at ?? undefined,
        approvedAt: row.approved_at ?? undefined,
        approvedBy: row.approved_by ?? undefined,
        sentAt: row.sent_at ?? undefined,
        sentToEmail: row.sent_to_email ?? undefined,
        sendError: row.send_error ?? undefined,
        cancelledAt: row.cancelled_at ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lines: linesByOrder.get(row.id) ?? [],
      };
    });
  }
}
