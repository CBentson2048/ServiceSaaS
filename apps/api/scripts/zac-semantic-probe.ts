/**
 * Reproduce ONE semantic-routing call with the deployment's real configuration
 * and print the provider's raw failure.
 *
 * `Fallback (Provider unavailable)` in the routing inspector is a closed enum:
 * it collapses a rejected key, an exhausted balance, a malformed request and a
 * network fault into one label, deliberately, so nothing leaks to the user.
 * That is right for the product and useless for an operator, and the detail
 * otherwise exists only in a warn-level server log. This prints it.
 *
 *   npx ts-node --transpile-only scripts/zac-semantic-probe.ts ["a question"]
 */
/* eslint-disable no-console -- this script's entire output contract is stdout. */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { join } from 'node:path';

loadEnv({ path: join(__dirname, '..', '.env') });

import { OpenAiSemanticProvider } from '../src/zac/models/providers/openai-semantic-provider';

const env = {
  get: <T>(key: string): T | undefined => process.env[key] as T | undefined,
  getOrThrow: <T>(key: string): T => {
    const value = process.env[key];
    if (value === undefined || value === '') throw new Error(`${key} is not set`);
    return value as T;
  },
};

async function main(): Promise<void> {
  const question = process.argv[2] ?? 'What is my cancellation rate?';

  console.log('ZAC_AI_PROVIDER      =', process.env.ZAC_AI_PROVIDER ?? '(unset -> hybrid)');
  console.log('ZAC_ROUTING_MODE     =', process.env.ZAC_ROUTING_MODE ?? '(unset -> legacy)');
  console.log('ZAC_SEMANTIC_MODEL   =', process.env.ZAC_SEMANTIC_MODEL ?? '(unset -> default)');
  console.log('OPENAI_API_KEY       =', process.env.OPENAI_API_KEY ? 'present' : 'MISSING');
  console.log('question             =', JSON.stringify(question));
  console.log();

  const provider = new OpenAiSemanticProvider(env as never);
  console.log(`calling ${provider.name}/${provider.model} …\n`);

  const started = Date.now();
  const outcome = await provider.classify({ question, roleContext: 'owner' });
  const ms = Date.now() - started;

  console.log('--- outcome ---');
  console.log('failure      :', outcome.failure ?? 'none');
  console.log('failureKind  :', outcome.failureKind ?? 'n/a');
  console.log('latency      :', `${ms}ms`);
  console.log('usage        :', outcome.completion ? JSON.stringify(outcome.completion) : 'none');
  console.log('raw verdict  :', outcome.raw ? JSON.stringify(outcome.raw, null, 2) : 'null');

  if (!outcome.failure && outcome.raw) {
    console.log('\nSEMANTIC ROUTING WORKS. The inspector should stop reporting a fallback.');
  }
}

main().catch((error) => {
  // The provider swallows failures by contract, so anything reaching here is a
  // construction or configuration fault rather than a routing outcome.
  console.error('\nPROBE FAILED BEFORE THE CALL:', error);
  process.exit(1);
});
