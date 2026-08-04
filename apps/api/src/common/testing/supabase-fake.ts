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
 */

type Row = Record<string, unknown>;

export interface SupabaseFakeState {
  tables: Map<string, Row[]>;
  /** Every mutation applied, for assertions: {table, verb, payload, matched}. */
  log: Array<{ table: string; verb: string; payload?: unknown; matched: number }>;
}

export function createSupabaseFakeState(seed: Record<string, Row[]> = {}): SupabaseFakeState {
  const tables = new Map<string, Row[]>();
  for (const [key, rows] of Object.entries(seed)) {
    tables.set(
      key,
      rows.map((r) => ({ ...r })),
    );
  }
  return { tables, log: [] };
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
  private limitCount: number | null = null;

  constructor(
    private readonly state: SupabaseFakeState,
    private readonly tableKey: string,
  ) {}

  select(_columns?: string, options?: { count?: string; head?: boolean }): this {
    if (options?.head) this.wantCountHead = true;
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

  /** Only the `col.is.null,col.gt.X` disjunction form used by the services. */
  or(expression: string): this {
    const clauses = expression.split(',').map((clause) => {
      const [column, op, ...rest] = clause.split('.');
      const raw = rest.join('.');
      return (row: Row): boolean => {
        const value = row[column];
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

  order(_column: string, _options?: { ascending?: boolean }): this {
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  range(_from: number, _to: number): this {
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
    let result = matches();
    if (this.limitCount !== null) result = result.slice(0, this.limitCount);
    if (this.wantCountHead) return { data: null, error: null, count: result.length };
    if (this.wantSingle) {
      if (result.length === 0) {
        return this.wantSingle === 'maybeSingle'
          ? { data: null, error: null }
          : { data: null, error: { message: 'no rows' } };
      }
      return { data: result[0], error: null };
    }
    return { data: result, error: null };
  }
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}

export function createSupabaseFake(state: SupabaseFakeState) {
  return {
    schema(schemaName: string) {
      return {
        from(tableName: string) {
          return new FakeQuery(state, `${schemaName}.${tableName}`);
        },
      };
    },
    from(tableName: string) {
      return new FakeQuery(state, `public.${tableName}`);
    },
    rpc() {
      return Promise.resolve({ data: null, error: { message: 'rpc not faked' } });
    },
  };
}
