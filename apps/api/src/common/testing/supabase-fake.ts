/**
 * Minimal thenable table-router fake for supabase-js, shared by payroll specs
 * (docs/V1.1/3-2 plan.md §10 — three divergent hand-rolled mocks already
 * exist elsewhere; new specs standardise on this one).
 *
 * Supports the chains the services actually use: schema().from(),
 * select/insert/update/delete, eq/neq/in/is/lt/lte/gt/gte/or (the
 * `a.is.null,a.gt.X` disjunction form only), order/limit/range,
 * single/maybeSingle/returns, `{ count: 'exact', head: true }`, and bare
 * await. Tables are keyed 'schema.table' and hold plain row objects.
 *
 * ORDER/RANGE/COUNT ARE REAL, not no-ops. They were stubs until the in-app
 * notification feed needed them: a paginated newest-first list cannot be tested
 * against a fake that silently returns insertion order and ignores the page
 * window — such a spec passes whatever the service does. `{ count: 'exact' }`
 * without `head` also reports the count of matches BEFORE the range is applied,
 * which is what PostgREST does and what a total-pages assertion depends on.
 *
 * EMBEDS are supported as plain nested objects: seed a row with
 * `notifications: { … }` to stand in for `select('…, notifications!inner(…)')`,
 * and `.or(expr, { referencedTable: 'notifications' })` filters against it.
 *
 * RPCs come from `state.rpcs`, a name -> handler map. Unregistered names return
 * an error, so a service calling an RPC the spec forgot to register fails loudly
 * instead of silently receiving null.
 */

type Row = Record<string, unknown>;

export type RpcHandler = (
  args: Record<string, unknown>,
) => { data: unknown; error: null | { message: string } };

export interface SupabaseFakeState {
  tables: Map<string, Row[]>;
  /** Every mutation applied, for assertions: {table, verb, payload, matched}. */
  log: Array<{ table: string; verb: string; payload?: unknown; matched: number }>;
  /**
   * Every SELECT issued, with the ordering it requested. Separate from `log` (which
   * is mutations-only by contract) and load-bearing twice over:
   *  - without the entry itself, "the service must not query at all in this case" is
   *    untestable, because a guarded early return and an unguarded query that
   *    happens to match no rows produce identical results;
   *  - without `orderBy`, a tie-break like `.order('id')` is untestable, because
   *    JS's sort is STABLE and so the fake returns a deterministic order whether or
   *    not the service asked for one — the very instability the tie-break exists to
   *    prevent cannot be reproduced in memory.
   */
  reads: Array<{ table: string; orderBy: Array<{ column: string; ascending: boolean }> }>;
  /**
   * Force a PostgREST error for a table key, so error branches can be tested.
   * Keyed 'schema.table'; the entry is consumed on first use so a spec can make
   * the FIRST query fail and let a follow-up query succeed — which is exactly the
   * shape of "the page query 416s, then the count query answers".
   */
  errors: Map<string, { message: string; code?: string }>;
  /** Postgres functions the service under test calls, by name. */
  rpcs: Map<string, RpcHandler>;
  /** Every rpc invocation, for assertions. */
  rpcLog: Array<{ name: string; args: Record<string, unknown> }>;
}

export function createSupabaseFakeState(
  seed: Record<string, Row[]> = {},
  rpcs: Record<string, RpcHandler> = {},
): SupabaseFakeState {
  const tables = new Map<string, Row[]>();
  for (const [key, rows] of Object.entries(seed)) {
    tables.set(
      key,
      rows.map((r) => ({ ...r })),
    );
  }
  return {
    tables,
    log: [],
    reads: [],
    errors: new Map(),
    rpcs: new Map(Object.entries(rpcs)),
    rpcLog: [],
  };
}

type Filter = (row: Row) => boolean;

class FakeQuery implements PromiseLike<{
  data: unknown;
  error: null | { message: string };
  count?: number;
}> {
  private verb: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private filters: Filter[] = [];
  private payload: Row | Row[] | null = null;
  private wantSingle: 'single' | 'maybeSingle' | null = null;
  private wantCountHead = false;
  private wantCount = false;
  private limitCount: number | null = null;
  private rangeWindow: { from: number; to: number } | null = null;
  private orderBy: Array<{ column: string; ascending: boolean; nullsFirst: boolean }> = [];

  constructor(
    private readonly state: SupabaseFakeState,
    private readonly tableKey: string,
  ) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (options?.head) this.wantCountHead = true;
    if (options?.count) this.wantCount = true;
    return this;
  }

  insert(payload: Row | Row[]): this {
    this.verb = 'insert';
    this.payload = payload;
    return this;
  }

  update(payload: Row): this {
    this.verb = 'update';
    this.payload = payload;
    return this;
  }

  delete(): this {
    this.verb = 'delete';
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  in(column: string, values: unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  is(column: string, value: null): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] as never) < (value as never));
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] as never) <= (value as never));
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] as never) > (value as never));
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push((row) => (row[column] as never) >= (value as never));
    return this;
  }

  not(column: string, _operator: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  /**
   * Only the `col.is.null,col.gt.X` disjunction form used by the services.
   * With `referencedTable`, the clauses are evaluated against that embedded
   * object instead of the row itself — mirroring PostgREST's
   * `notifications.or=(…)`, which filters the parent by the embedded resource.
   */
  or(expression: string, options?: { referencedTable?: string }): this {
    const clauses = expression.split(',').map((clause) => {
      const [column, op, ...rest] = clause.split('.');
      const raw = rest.join('.');
      return (row: Row): boolean => {
        const target = options?.referencedTable
          ? ((Array.isArray(row[options.referencedTable])
              ? (row[options.referencedTable] as Row[])[0]
              : row[options.referencedTable]) as Row | undefined)
          : row;
        if (!target) return false;
        const value = target[column];
        switch (op) {
          case 'is':
            return raw === 'null' ? value === null : value === (raw as never);
          case 'gt':
            return value !== null && (value as never) > (raw as never);
          case 'gte':
            return value !== null && (value as never) >= (raw as never);
          case 'lt':
            return value !== null && (value as never) < (raw as never);
          case 'lte':
            return value !== null && (value as never) <= (raw as never);
          case 'eq':
            return value === (raw as never);
          case 'neq':
            return value !== (raw as never);
          default:
            return false;
        }
      };
    });
    this.filters.push((row) => clauses.some((clause) => clause(row)));
    return this;
  }

  order(
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ): this {
    this.orderBy.push({
      column,
      ascending: options?.ascending ?? true,
      // PostgREST's default is nulls last for ascending, nulls first for
      // descending; supabase-js lets the caller override it.
      nullsFirst: options?.nullsFirst ?? !(options?.ascending ?? true),
    });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  /** Inclusive on both bounds, like PostgREST. */
  range(from: number, to: number): this {
    this.rangeWindow = { from, to };
    return this;
  }

  returns<T>(): this & PromiseLike<{ data: T; error: null }> {
    return this as never;
  }

  single<T = Row>(): Promise<{ data: T | null; error: { message: string } | null }> {
    this.wantSingle = 'single';
    return this.execute() as never;
  }

  maybeSingle<T = Row>(): Promise<{ data: T | null; error: { message: string } | null }> {
    this.wantSingle = 'maybeSingle';
    return this.execute() as never;
  }

  then<TResult1, TResult2 = never>(
    onfulfilled?: (value: {
      data: unknown;
      error: null | { message: string };
      count?: number;
    }) => TResult1 | PromiseLike<TResult1>,
    onrejected?: (reason: unknown) => TResult2 | PromiseLike<TResult2>,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<{
    data: unknown;
    error: null | { message: string };
    count?: number;
  }> {
    const forced = this.state.errors.get(this.tableKey);
    if (forced) {
      // One-shot: consumed so the next query on the same table behaves normally.
      this.state.errors.delete(this.tableKey);
      return { data: null, error: forced };
    }

    const rows = this.state.tables.get(this.tableKey) ?? [];
    const matches = () => rows.filter((row) => this.filters.every((f) => f(row)));

    if (this.verb === 'insert') {
      const inserted = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const withIds = inserted.map((row) => ({
        id: row['id'] ?? `fake-${Math.abs(hash(JSON.stringify(row)))}`,
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
        ...row,
      }));
      rows.push(...withIds);
      this.state.tables.set(this.tableKey, rows);
      this.state.log.push({
        table: this.tableKey,
        verb: 'insert',
        payload: this.payload,
        matched: withIds.length,
      });
      const data = this.wantSingle ? withIds[0] : withIds;
      return { data, error: null };
    }

    if (this.verb === 'update') {
      const matched = matches();
      for (const row of matched) Object.assign(row, this.payload);
      this.state.log.push({
        table: this.tableKey,
        verb: 'update',
        payload: this.payload,
        matched: matched.length,
      });
      if (this.wantSingle) {
        if (matched.length === 0) {
          return this.wantSingle === 'maybeSingle'
            ? { data: null, error: null }
            : { data: null, error: { message: 'no rows' } };
        }
        return { data: matched[0], error: null };
      }
      return { data: matched, error: null };
    }

    if (this.verb === 'delete') {
      const matched = matches();
      this.state.tables.set(
        this.tableKey,
        rows.filter((row) => !matched.includes(row)),
      );
      this.state.log.push({ table: this.tableKey, verb: 'delete', matched: matched.length });
      return { data: matched, error: null };
    }

    // select
    this.state.reads.push({
      table: this.tableKey,
      orderBy: this.orderBy.map(({ column, ascending }) => ({ column, ascending })),
    });
    let result = matches();
    result = this.applyOrder(result);
    // PostgREST reports the count of everything that matched, not of the page
    // that was returned — pagination totals depend on that distinction.
    const total = result.length;
    if (this.rangeWindow) {
      result = result.slice(this.rangeWindow.from, this.rangeWindow.to + 1);
    }
    if (this.limitCount !== null) result = result.slice(0, this.limitCount);
    if (this.wantCountHead) return { data: null, error: null, count: total };
    if (this.wantSingle) {
      if (result.length === 0) {
        return this.wantSingle === 'maybeSingle'
          ? { data: null, error: null }
          : { data: null, error: { message: 'no rows' } };
      }
      return { data: result[0], error: null };
    }
    return this.wantCount
      ? { data: result, error: null, count: total }
      : { data: result, error: null };
  }

  /** Stable multi-key sort honouring the order() calls, in the order they were made. */
  private applyOrder(rows: Row[]): Row[] {
    if (this.orderBy.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const { column, ascending, nullsFirst } of this.orderBy) {
        const left = a[column];
        const right = b[column];
        const leftNull = left === null || left === undefined;
        const rightNull = right === null || right === undefined;
        if (leftNull || rightNull) {
          if (leftNull && rightNull) continue;
          return leftNull ? (nullsFirst ? -1 : 1) : nullsFirst ? 1 : -1;
        }
        if (left === right) continue;
        const cmp = (left as never) < (right as never) ? -1 : 1;
        return ascending ? cmp : -cmp;
      }
      return 0;
    });
  }
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}

export function createSupabaseFake(state: SupabaseFakeState) {
  const callRpc = (name: string, args: Record<string, unknown> = {}) => {
    state.rpcLog.push({ name, args });
    const handler = state.rpcs.get(name);
    if (!handler) {
      return Promise.resolve({ data: null, error: { message: `rpc not faked: ${name}` } });
    }
    return Promise.resolve(handler(args));
  };

  return {
    schema(schemaName: string) {
      return {
        from(tableName: string) {
          return new FakeQuery(state, `${schemaName}.${tableName}`);
        },
        // supabase-js exposes rpc() on the schema-scoped client too, and services
        // that call a function in a non-public schema use exactly that form.
        rpc: callRpc,
      };
    },
    from(tableName: string) {
      return new FakeQuery(state, `public.${tableName}`);
    },
    rpc: callRpc,
  };
}
