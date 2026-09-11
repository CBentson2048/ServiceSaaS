import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WORKSTREAM 3 READ-ONLY + PII BOUNDARY, asserted rather than documented.
 *
 * Phase 2 is read-only and human-led: ZAC may recommend, prioritise and
 * deep-link, but must not change bookings, clients, staff, stock, prices or
 * payments, and must not order anything. WS3 is the first workstream to read
 * services whose surface is mostly WRITES — InventoryService has 14 of them,
 * OrdersService 5, one of which allocates a purchase-order number and emails a
 * supplier.
 *
 * The FIRST line of defence is the `Pick<>` ports in ports/zac-service-ports.ts:
 * a method absent from the port is a compile error, not a review miss. This
 * sweep is the SECOND line, and it exists for the case the ports cannot catch —
 * someone widening a Pick<>, or reaching around it with a raw Supabase client.
 *
 * It also pins three rules that are not about writes at all:
 *   - no tool may read the write-only `waste_events` table (Phase 1 safety
 *     doctrine: it is inserted by an RPC, deleted and reinserted on re-save,
 *     SELECTed nowhere, and holds 0 rows);
 *   - no tool may name a pay or identity field that rides along on a payload it
 *     legitimately reads;
 *   - no tool may divide two numbers inline — every rate must go through
 *     ZacCoverageReading, which cannot produce a figure without its denominator.
 *
 * Modelled on ai/zac-provider-boundary.spec.ts, including its Windows
 * path-separator normalisation and its guard against a silently empty sweep.
 */

const TOOLS_ROOT = join(__dirname, 'tools');
const PORTS_ROOT = join(__dirname, 'ports');

/**
 * Every WS3 tool file. Listed explicitly rather than globbed so that adding a
 * QLab/stock tool without adding it here is itself a visible omission — and so
 * the Workstream 1 and 2 tools, which have their own (different) constraints,
 * are not swept by rules written for this workstream.
 */
const WS3_TOOL_FILES: readonly string[] = [
  'qlab-colour-analytics.tool.ts',
  'inventory-stock-status.tool.ts',
  'inventory-colour-prep-risk.tool.ts',
  'inventory-reorder-advisory.tool.ts',
];

/**
 * Mutating methods on the services WS3 reads. A WS3 tool naming any of these is
 * a boundary breach even if the ports would have refused to compile it — the
 * two checks fail independently on purpose.
 *
 * `generate` is the most dangerous single token in this list: it is the only
 * implementation of the reorder algorithm, and it writes purchase orders and
 * sends supplier email. `previewReorder` exists so no tool ever needs it.
 */
const WRITE_METHODS: readonly string[] = [
  // OrdersService
  'generate',
  'submit',
  'cancel',
  'send',
  // InventoryService
  'createProduct',
  'updateProduct',
  'archiveProduct',
  'initializeStock',
  'adjustStock',
  'updateStockThreshold',
  'setProductAvailability',
  'recordConsumption',
  'createCategory',
  'updateCategory',
  'deleteCategory',
  'createSupplier',
  'updateSupplier',
  'deleteSupplier',
  // FormulaChangeService — the only write in the whole QLab area.
  'upsertSettings',
];

/** Write RPCs and verbs, in case someone reaches around the services entirely. */
const WRITE_RPCS: readonly string[] = [
  'create_purchase_order',
  'save_formula_with_reconciliation',
  'adjust_location_stock',
  'record_retail_sale',
];

/**
 * Pay and identity fields that ride along on payloads WS3 legitimately reads.
 *
 * `hourlyRate` / `contractedHours` / `averageBillBenchmark` / `stylistName` sit
 * on `SheerLabAnalyticsResponse.byStylist`, reachable under
 * `report.lab_analytics.view` with NO payroll permission in the path.
 * `clientName` sits on `ColourPrepAppointment`. `createdByName` sits on
 * `InventoryStockMovement`. None is needed to answer a colour or stock
 * question, so none may be named.
 */
const PII_FIELDS: readonly string[] = [
  'byStylist',
  'stylistName',
  'hourlyRate',
  'contractedHours',
  'averageBillBenchmark',
  'clientName',
  'createdByName',
  'clientProfileId',
];

/** Strip comments so a rule NAMED in a docblock is not reported as a breach. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('Workstream 3 read-only and PII boundary', () => {
  const present = WS3_TOOL_FILES.filter((name) => {
    try {
      return statSync(join(TOOLS_ROOT, name)).isFile();
    } catch {
      return false;
    }
  });

  const files = present.map((name) => ({
    name,
    code: stripComments(readFileSync(join(TOOLS_ROOT, name), 'utf8')),
  }));

  it('sweeps every WS3 tool (guards against a silently empty or partial sweep)', () => {
    // A boundary test that scans nothing passes forever. This was a subset
    // check while the tools were being written; now all four have landed it is
    // strict, so renaming or adding a QLab/stock tool without listing it here
    // fails loudly rather than quietly leaving it unguarded.
    expect(present).toEqual([...WS3_TOOL_FILES]);
  });

  it.each(WRITE_METHODS)('lets no WS3 tool call the mutating method %s', (method) => {
    const called = new RegExp(`\\.\\s*${method}\\s*\\(`);
    for (const file of files) {
      expect({ file: file.name, method, hit: called.test(file.code) }).toEqual({
        file: file.name,
        method,
        hit: false,
      });
    }
  });

  it.each(WRITE_RPCS)('lets no WS3 tool name the write RPC %s', (rpc) => {
    for (const file of files) {
      expect({ file: file.name, rpc, hit: file.code.includes(rpc) }).toEqual({
        file: file.name,
        rpc,
        hit: false,
      });
    }
  });

  it.each(['insert', 'update', 'upsert', 'delete'])(
    'lets no WS3 tool issue a PostgREST %s',
    (verb) => {
      const called = new RegExp(`\\.\\s*${verb}\\s*\\(`);
      for (const file of files) {
        expect({ file: file.name, verb, hit: called.test(file.code) }).toEqual({
          file: file.name,
          verb,
          hit: false,
        });
      }
    },
  );

  it('lets no WS3 tool open its own database client', () => {
    // ZAC reaches business data ONLY through guarded QLOOQO services called with
    // the resolved actor. A tool holding its own service-role client would
    // bypass every permission and location check those services perform.
    for (const file of files) {
      expect({ file: file.name, hit: /createClient\s*\(/.test(file.code) }).toEqual({
        file: file.name,
        hit: false,
      });
      expect({ file: file.name, hit: /SupabaseClient/.test(file.code) }).toEqual({
        file: file.name,
        hit: false,
      });
    }
  });

  it('lets no WS3 tool read the write-only waste_events table', () => {
    // Phase 1 safety doctrine. Waste comes from lab.formulas.waste_cost_cents
    // via LabAnalyticsService — never from this table, which is SELECTed
    // nowhere in the platform and holds no rows.
    for (const file of files) {
      expect({ file: file.name, hit: file.code.includes('waste_events') }).toEqual({
        file: file.name,
        hit: false,
      });
    }
  });

  it.each(PII_FIELDS)('lets no WS3 tool name the pay/identity field %s', (field) => {
    const named = new RegExp(`\\b${field}\\b`);
    for (const file of files) {
      expect({ file: file.name, field, hit: named.test(file.code) }).toEqual({
        file: file.name,
        field,
        hit: false,
      });
    }
  });

  it('lets no WS3 tool read plan.appointments from a colour-prep plan', () => {
    // ColourPrepAppointment carries a client's full name. The prep tool reads
    // plan.products and plan.summary only, which is what makes its
    // piiLevel 'none' structurally true rather than merely asserted.
    for (const file of files) {
      expect({ file: file.name, hit: /\.\s*appointments\b/.test(file.code) }).toEqual({
        file: file.name,
        hit: false,
      });
    }
  });

  it('lets no WS3 tool compute a percentage inline', () => {
    // Every rate must go through ZacCoverageReading, whose constructors demand
    // the denominator, the sample unit and an as-of timestamp — so a zero
    // denominator yields null plus an honest sentence rather than "0%".
    // On the live data colour waste is 0/0 and AndrewHair's colour margin is
    // 0/0; both would render as a confident "0%" under naive arithmetic.
    const inlinePercent = /\*\s*100\b|\/\s*100\b.*\bpercent/i;
    for (const file of files) {
      expect({ file: file.name, hit: inlinePercent.test(file.code) }).toEqual({
        file: file.name,
        hit: false,
      });
    }
  });

  it('keeps the ports file free of value imports', () => {
    // `import type` only: the ports must create no Nest dependency and no
    // runtime import cycle between ZAC and the services it narrows.
    const ports = stripComments(readFileSync(join(PORTS_ROOT, 'zac-service-ports.ts'), 'utf8'));
    const valueImports = ports
      .split('\n')
      .filter((line) => /^\s*import\s/.test(line) && !/^\s*import\s+type\s/.test(line));
    expect(valueImports).toEqual([]);
  });

  it('gives the ports no member that mutates', () => {
    const ports = stripComments(readFileSync(join(PORTS_ROOT, 'zac-service-ports.ts'), 'utf8'));
    for (const method of WRITE_METHODS) {
      expect({ method, hit: new RegExp(`'${method}'`).test(ports) }).toEqual({ method, hit: false });
    }
  });
});
