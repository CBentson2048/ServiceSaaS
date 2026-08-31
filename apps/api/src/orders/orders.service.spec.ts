/**
 * Week 6 tickets 8/9 — purchase order workflow.
 *
 * The stubbed client proves what the service SENDS (tenancy filters, RPC
 * payloads, state-machine patches, the email) and who it refuses. The gapless
 * numbering and the open-order uniqueness live in plpgsql and are proved by
 * supabase/tests/week6_purchase_orders.sql.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { OrdersService } from './orders.service';
import type { AuditService } from '../audit/audit.service';
import type { EmailService } from '../email/email.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

interface Captured {
  key: string;
  method: string;
  args: unknown[];
}

const ORDER = {
  id: 'po-1',
  business_id: 'biz-1',
  location_id: 'loc-1',
  supplier_id: 'sup-1',
  order_number: 'PO-00001',
  status: 'draft',
  currency_code: 'GBP',
  subtotal_cents: 3000,
  notes: null,
  created_by: 'user-1',
  submitted_at: null,
  approved_at: null,
  approved_by: null,
  sent_at: null,
  sent_to_email: null,
  send_error: null,
  cancelled_at: null,
  created_at: '2026-08-24T09:00:00.000Z',
  updated_at: '2026-08-24T09:00:00.000Z',
};

const LINE = {
  id: 'line-1',
  purchase_order_id: 'po-1',
  product_id: 'prod-1',
  product_name_snapshot: 'Colour 6.0',
  pack_size_snapshot: 100,
  stock_unit_snapshot: 'gram',
  suggested_quantity: 6,
  ordered_quantity: 6,
  unit_cost_cents: 500,
  line_total_cents: 3000,
};

const SUPPLIER = {
  id: 'sup-1',
  name: 'Wella Professionals',
  contact_email: 'orders@wella.test',
  account_reference: 'LOH-123',
  is_active: true,
};

function build(
  rows: Record<string, unknown[]>,
  options: {
    rpc?: Record<string, unknown>;
    updateNull?: string[];
    emailResult?: { delivered: boolean; error?: string; id?: string };
  } = {},
) {
  const captured: Captured[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const updateNull = new Set(options.updateNull ?? []);

  const makeChain = (key: string) => {
    const data = () => rows[key] ?? [];
    let isUpdate = false;
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'order', 'limit', 'not', 'returns', 'or', 'ilike']) {
      chain[method] = (...args: unknown[]) => {
        captured.push({ key, method, args });
        return chain;
      };
    }
    for (const method of ['update', 'insert', 'upsert', 'delete']) {
      chain[method] = (...args: unknown[]) => {
        captured.push({ key, method, args });
        if (method === 'update') isUpdate = true;
        return chain;
      };
    }
    chain.maybeSingle = async () => ({
      data: isUpdate && updateNull.has(key) ? null : (data()[0] ?? null),
      error: null,
    });
    chain.single = chain.maybeSingle;
    chain.then = (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) =>
      Promise.resolve({ data: data(), error: null }).then(resolve, reject);
    return chain;
  };

  const root = {
    schema: () => ({
      from: (table: string) => makeChain(table),
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        const result = options.rpc?.[name];
        return { data: result ?? [], error: null };
      },
    }),
  };
  mockedCreateClient.mockReturnValue(root as never);

  const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const email = {
    send: jest.fn().mockResolvedValue(options.emailResult ?? { delivered: true, id: 'msg-1' }),
  } as unknown as EmailService;
  const config = { getOrThrow: (key: string) => `test-${key}` } as unknown as ConfigService;
  return { service: new OrdersService(config, audit, email), captured, rpcCalls, audit, email };
}

const OWNER: AuthUser = {
  id: 'user-1',
  roles: ['owner'],
  primaryRole: 'owner',
  businessId: 'biz-1',
  allowedLocationIds: ['loc-1'],
  locationScope: { kind: 'all' },
  locations: [],
  profile: { id: 'user-1', email: 'owner@salon.test', fullName: 'Owner' },
  permissions: ['orders.view', 'orders.manage', 'orders.approve'],
} as unknown as AuthUser;

const MANAGER: AuthUser = {
  ...OWNER,
  id: 'user-2',
  roles: ['manager'],
  primaryRole: 'manager',
  permissions: ['orders.view', 'orders.manage'],
} as unknown as AuthUser;

const baseRows = (overrides: Record<string, unknown[]> = {}) => ({
  locations: [
    {
      id: 'loc-1',
      name: 'Main',
      address_line_1: '12 Regent Road',
      address_line_2: null,
      city: 'Leeds',
      region: null,
      postal_code: 'LS9 1AA',
    },
  ],
  purchase_orders: [ORDER],
  purchase_order_lines: [LINE],
  suppliers: [SUPPLIER],
  businesses: [{ name: 'Luke Ormsby Hair' }],
  location_settings: [{ reorder_usage_window_weeks: 8, reorder_coverage_weeks: 4 }],
  location_stock: [],
  products: [],
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('generate', () => {
  const stockedRows = () =>
    baseRows({
      location_stock: [
        { product_id: 'prod-1', quantity_on_hand_grams: 0, low_stock_threshold_grams: null },
      ],
      products: [
        {
          id: 'prod-1',
          name: 'Colour 6.0',
          is_active: true,
          stock_unit: 'gram',
          pack_size: 100,
          size_value: 100,
          default_cost_per_gram_cents: 5,
          low_stock_threshold_grams: 0,
          supplier_id: 'sup-1',
          minimum_order_quantity: 6,
          order_multiple: 6,
        },
      ],
    });

  it('creates one draft per supplier with MOQ-rounded lines', async () => {
    const { service, rpcCalls } = build(stockedRows(), {
      rpc: {
        reorder_usage: [{ product_id: 'prod-1', outbound_base: 400 }],
        create_purchase_order: [{ id: 'po-1', order_number: 'PO-00001', created: true }],
      },
    });
    const result = await service.generate(OWNER, { locationId: 'loc-1' });

    const create = rpcCalls.find((call) => call.name === 'create_purchase_order');
    expect(create).toBeDefined();
    expect(create?.args.p_order).toMatchObject({
      business_id: 'biz-1',
      location_id: 'loc-1',
      supplier_id: 'sup-1',
    });
    const lines = create?.args.p_lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    // 400g over 8 weeks -> 200g forecast -> 2 packs -> MOQ 6.
    expect(lines[0]).toMatchObject({
      product_id: 'prod-1',
      suggested_quantity: 6,
      ordered_quantity: 6,
      unit_cost_cents: 500,
      line_total_cents: 3000,
    });
    expect(result.created).toHaveLength(1);
    expect(result.nothingNeeded).toBe(false);
  });

  it('reports a supplier-less product as unorderable instead of dropping it', async () => {
    const rows = stockedRows();
    (rows.products[0] as Record<string, unknown>).supplier_id = null;
    const { service, rpcCalls } = build(rows, {
      rpc: { reorder_usage: [{ product_id: 'prod-1', outbound_base: 400 }] },
    });
    const result = await service.generate(OWNER, { locationId: 'loc-1' });
    expect(result.unorderable).toEqual([
      { productId: 'prod-1', productName: 'Colour 6.0', reason: 'no_supplier' },
    ]);
    expect(rpcCalls.some((call) => call.name === 'create_purchase_order')).toBe(false);
  });

  it('reports a weight product with no pack size as unorderable', async () => {
    const rows = stockedRows();
    (rows.products[0] as Record<string, unknown>).pack_size = null;
    (rows.products[0] as Record<string, unknown>).size_value = null;
    const { service } = build(rows, {
      rpc: { reorder_usage: [{ product_id: 'prod-1', outbound_base: 400 }] },
    });
    const result = await service.generate(OWNER, { locationId: 'loc-1' });
    expect(result.unorderable[0]?.reason).toBe('no_pack_size');
  });

  it('hands back the existing open order instead of duplicating it', async () => {
    const { service } = build(stockedRows(), {
      rpc: {
        reorder_usage: [{ product_id: 'prod-1', outbound_base: 400 }],
        create_purchase_order: [{ id: 'po-1', order_number: 'PO-00001', created: false }],
      },
    });
    const result = await service.generate(OWNER, { locationId: 'loc-1' });
    expect(result.created).toHaveLength(0);
    expect(result.skippedExistingOrder).toEqual([
      { supplierId: 'sup-1', supplierName: 'Wella Professionals', orderId: 'po-1', orderNumber: 'PO-00001' },
    ]);
  });

  it('says so when nothing needs ordering', async () => {
    const { service } = build(stockedRows(), { rpc: { reorder_usage: [] } });
    // No usage, no threshold, stock at zero -> shortfall 0 -> nothing.
    const result = await service.generate(OWNER, { locationId: 'loc-1' });
    expect(result.nothingNeeded).toBe(true);
  });

  it('requires orders.manage', async () => {
    const viewer = { ...OWNER, permissions: ['orders.view'] } as unknown as AuthUser;
    const { service } = build(baseRows());
    await expect(service.generate(viewer, { locationId: 'loc-1' })).rejects.toThrow(ForbiddenException);
  });
});

describe('state machine', () => {
  // Two-step flow (0100): submit takes a draft straight to READY TO SEND. There is
  // no separate approve step, and no state a manager can strand an order in.
  it('submits a draft straight to ready-to-send and audits the transition', async () => {
    const { service, captured, audit } = build(baseRows());
    await service.submit(MANAGER, 'po-1');

    const update = captured.find((c) => c.key === 'purchase_orders' && c.method === 'update');
    expect(update?.args[0]).toMatchObject({ status: 'approved', approved_by: 'user-2' });
    // The conditional transition is pinned to the legal source states.
    const ins = captured.filter((c) => c.key === 'purchase_orders' && c.method === 'in').map((c) => c.args);
    expect(ins).toEqual(expect.arrayContaining([['status', ['draft']]]));
    expect(audit.record).toHaveBeenCalledWith(
      MANAGER,
      expect.objectContaining({ action: 'purchase_order.submitted', entityType: 'purchase_order' }),
    );
  });

  it('stamps submitted_at and approved_at together — one action, both facts', async () => {
    const { service, captured } = build(baseRows());
    await service.submit(MANAGER, 'po-1');
    const patch = captured.find((c) => c.key === 'purchase_orders' && c.method === 'update')
      ?.args[0] as Record<string, unknown>;
    expect(patch.submitted_at).toBeTruthy();
    expect(patch.approved_at).toBe(patch.submitted_at);
  });

  it('lets a manager submit without orders.approve — preparing is not spending', async () => {
    // MANAGER deliberately holds only view+manage here. The spend gate moved to
    // send(), so an owner who strips orders.approve leaves the manager able to
    // prepare an order for someone else to send — the flow degrades to an
    // approval workflow rather than breaking.
    const { service } = build(baseRows());
    await expect(service.submit(MANAGER, 'po-1')).resolves.toBeDefined();
  });

  it('lets a manager WITH orders.approve send — the 0100 default', async () => {
    // Migration 0100 seeds orders.approve onto the manager level, so by default a
    // location manager completes their own order end to end.
    const sender = {
      ...MANAGER,
      permissions: ['orders.view', 'orders.manage', 'orders.approve'],
    } as unknown as AuthUser;
    const { service } = build(baseRows({ purchase_orders: [{ ...ORDER, status: 'approved' }] }));
    await expect(service.send(sender, 'po-1')).resolves.toBeDefined();
  });

  it('reports an illegal transition as a conflict, not a server error', async () => {
    const { service } = build(baseRows({ purchase_orders: [{ ...ORDER, status: 'sent' }] }), {
      updateNull: ['purchase_orders'],
    });
    await expect(service.submit(OWNER, 'po-1')).rejects.toThrow(ConflictException);
  });

  it('requires orders.approve to cancel an APPROVED order', async () => {
    const { service } = build(baseRows({ purchase_orders: [{ ...ORDER, status: 'approved' }] }));
    await expect(service.cancel(MANAGER, 'po-1')).rejects.toThrow(ForbiddenException);
  });

  it('scopes every order read to the caller business', async () => {
    const { service, captured } = build(baseRows());
    await service.getOrder(OWNER, 'po-1');
    const eqs = captured.filter((c) => c.key === 'purchase_orders' && c.method === 'eq').map((c) => c.args);
    expect(eqs).toEqual(expect.arrayContaining([['business_id', 'biz-1'], ['id', 'po-1']]));
  });
});

describe('sending', () => {
  const approvedRows = () => baseRows({ purchase_orders: [{ ...ORDER, status: 'approved' }] });

  it('emails the supplier and records the send', async () => {
    const { service, captured, email, audit } = build(approvedRows());
    const result = await service.send(OWNER, 'po-1');

    expect(email.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'orders@wella.test',
        subject: expect.stringContaining('PO-00001'),
        replyTo: 'owner@salon.test',
      }),
    );
    const update = captured.find((c) => c.key === 'purchase_orders' && c.method === 'update');
    expect(update?.args[0]).toMatchObject({
      status: 'sent',
      sent_to_email: 'orders@wella.test',
      send_error: null,
    });
    expect(result.delivered).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ action: 'purchase_order.sent' }),
    );
  });

  it("puts the location's address in brackets after its name in the email", async () => {
    const { service, email } = build(approvedRows());
    await service.send(OWNER, 'po-1');

    const sent = (email.send as jest.Mock).mock.calls[0][0];
    expect(sent.html).toContain('Main (12 Regent Road, Leeds, LS9 1AA)');
    expect(sent.text).toContain('Main (12 Regent Road, Leeds, LS9 1AA)');
  });

  it('sends the bare location name when the location has no address on record', async () => {
    const { service, email } = build(
      baseRows({
        purchase_orders: [{ ...ORDER, status: 'approved' }],
        locations: [{ id: 'loc-1', name: 'Main' }],
      }),
    );
    await service.send(OWNER, 'po-1');

    const sent = (email.send as jest.Mock).mock.calls[0][0];
    expect(sent.text).toContain('From Luke Ormsby Hair, Main\n');
    expect(sent.text).not.toContain('Main (');
  });

  it('keeps a failed send approved, records the error, and reports it', async () => {
    const { service, captured, audit } = build(approvedRows(), {
      emailResult: { delivered: false, error: 'SMTP down' },
    });
    const result = await service.send(OWNER, 'po-1');

    expect(result.delivered).toBe(false);
    expect(result.error).toBe('SMTP down');
    const update = captured.find((c) => c.key === 'purchase_orders' && c.method === 'update');
    expect(update?.args[0]).toEqual({ send_error: 'SMTP down' });
    expect(audit.record).toHaveBeenCalledWith(
      OWNER,
      expect.objectContaining({ action: 'purchase_order.send_failed' }),
    );
  });

  it('refuses to send when the supplier has no order email', async () => {
    const { service, email } = build(
      baseRows({
        purchase_orders: [{ ...ORDER, status: 'approved' }],
        suppliers: [{ ...SUPPLIER, contact_email: null }],
      }),
    );
    await expect(service.send(OWNER, 'po-1')).rejects.toThrow(BadRequestException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('refuses to send anything that is not approved', async () => {
    const { service, email } = build(baseRows());
    await expect(service.send(OWNER, 'po-1')).rejects.toThrow(ConflictException);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('requires orders.approve to send', async () => {
    const { service } = build(approvedRows());
    await expect(service.send(MANAGER, 'po-1')).rejects.toThrow(ForbiddenException);
  });
});

describe('draft editing', () => {
  it('updates quantities, reprices lines and recomputes the subtotal', async () => {
    const { service, captured } = build(baseRows());
    await service.update(OWNER, 'po-1', { lines: [{ id: 'line-1', orderedQuantity: 8 }] });

    const lineUpdate = captured.find((c) => c.key === 'purchase_order_lines' && c.method === 'update');
    expect(lineUpdate?.args[0]).toEqual({ ordered_quantity: 8, line_total_cents: 4000 });
    // Subtotal recomputed from the (stubbed) line set.
    const orderUpdates = captured.filter((c) => c.key === 'purchase_orders' && c.method === 'update');
    expect(orderUpdates.some((c) => 'subtotal_cents' in (c.args[0] as Record<string, unknown>))).toBe(true);
  });

  it('refuses to edit anything but a draft', async () => {
    const { service } = build(baseRows({ purchase_orders: [{ ...ORDER, status: 'approved' }] }));
    await expect(
      service.update(OWNER, 'po-1', { lines: [{ id: 'line-1', orderedQuantity: 8 }] }),
    ).rejects.toThrow(ConflictException);
  });

  it('refuses a line from another order', async () => {
    const { service } = build(baseRows({ purchase_order_lines: [] }));
    await expect(
      service.update(OWNER, 'po-1', { lines: [{ id: 'foreign-line', orderedQuantity: 2 }] }),
    ).rejects.toThrow(BadRequestException);
  });
});
