/**
 * The one test that proves the API can actually START.
 *
 * WHY THIS EXISTS. Week 7 shipped a change where `ColourPrepService` gained a
 * `FormulaChangeService` constructor dependency while `ColourPrepModule` never
 * imported the module that exports it. Nest could not resolve the provider, so
 * `NestFactory.create(AppModule)` threw and the API would not boot at all —
 * while `tsc --noEmit` stayed clean (dependency injection is a runtime concern)
 * and all ~2,450 unit tests stayed green, because every service spec constructs
 * its subject directly (`new ColourPrepService(config, stub)`) and so never
 * touches the module graph. A total outage was invisible to the entire suite.
 *
 * WHAT THIS TEST PROVES
 *   The REAL AppModule — every module, every controller, every provider, in the
 *   real dependency graph — can be compiled by Nest. A missing module import, a
 *   provider that is never exported, a circular import, or a token that nothing
 *   supplies all fail here.
 *
 * WHAT THIS TEST DELIBERATELY DOES NOT PROVE
 *   * That the app can serve a request. It compiles the graph; it does not call
 *     `listen()` and binds no port.
 *   * That any external system works. Supabase/Twilio/Resend/Anthropic clients
 *     are CONSTRUCTED (that is part of what we want to exercise) but never used:
 *     every provider builds its client lazily from config and performs no I/O in
 *     its constructor, so no network call is made and no credential is needed
 *     beyond a syntactically valid placeholder.
 *   * That background workers do useful work. `onModuleInit` is never invoked,
 *     because `.compile()` stops short of lifecycle hooks — so no poller starts,
 *     no timer is registered and no queue is drained by this test.
 *
 * It therefore needs no credentials, contacts no provider, and cannot send a
 * message. If it ever starts needing a real secret, that is a regression in a
 * provider doing I/O at construction time, not a reason to weaken this test.
 */
import { Test } from '@nestjs/testing';

/**
 * Config the graph can be built against. These are placeholders with the right
 * SHAPE (a parseable URL, a non-empty key) — never real credentials. Anything a
 * provider reads with `getOrThrow` at construction time has to be present here,
 * which is exactly the set below.
 */
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SUPABASE_ANON_KEY: 'test-anon-key',
  ANTHROPIC_API_KEY: 'test-anthropic-key',
  // Every background worker is switched OFF. Compiling the graph must not be
  // able to start a poller even if `.compile()` ever began running lifecycle
  // hooks: a test that quietly began draining a queue would be far worse than a
  // test that fails.
  COMMS_DISPATCH_ENABLED: 'false',
  CAMPAIGNS_EVALUATION_ENABLED: 'false',
  PUSH_DISPATCH_ENABLED: 'false',
  MESSAGE_USAGE_RECOVERY_ENABLED: 'false',
};

describe('AppModule bootstrap', () => {
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(TEST_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('compiles the real module graph — every provider resolves', async () => {
    // AppModule is loaded only now, after TEST_ENV is in place: its
    // `ConfigModule.forRoot({ validate })` runs when the module is evaluated, so a
    // top-level import would validate the environment before `beforeAll` ran and
    // the test would pass only where a local `.env` happens to exist.
    const { AppModule } = await import('./app.module');
    // No overrideProvider, no mocked modules: the point is the REAL graph. If a
    // module forgets to import the module exporting a service it injects, Nest
    // throws here with "Nest can't resolve dependencies of the X (?, ...)".
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 60_000);
});
