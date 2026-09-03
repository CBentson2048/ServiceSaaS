/**
 * The semantic-routing inspector must show the route the BACKEND returned for
 * an answer — never one inferred client-side — and must make a fallback
 * answer impossible to mistake for a successful semantic classification.
 */
import { render, screen, within } from '@testing-library/react';
import { describeZacRouting } from '@sheer/domain';
import type { ZacRoutingDetails } from '@sheer/domain';
import {
  ZacRoutingBadge,
  ZacRoutingInspector,
  ZacRoutingTechnicalDetails,
} from './ZacRoutingInspector';

const SEMANTIC_TURN: ZacRoutingDetails = {
  request_mode: 'qlooqo_data',
  router_analysis_intent: 'business_priorities',
  analysis_intent: 'business_priorities',
  information_source: 'live_qlooqo',
  classification_source: 'semantic_model',
  routing_mode: 'semantic',
  router_version: 'semantic-v2',
  prompt_version: '2026-09-02.1',
  semantic_provider: 'openai',
  semantic_model: 'gpt-5.6-luna',
  semantic_confidence: 0.92,
  semantic_confidence_bucket: 'high',
  fallback_used: false,
};

/** The compact "Routing: …" text, without the separate Source element. */
function badgeText(details: ZacRoutingDetails | null | undefined): string | null {
  const { container, unmount } = render(<ZacRoutingBadge details={details} />);
  const summary = container.querySelector('[data-testid="zac-routing-summary"]');
  const text = summary?.textContent ?? null;
  unmount();
  return text;
}

function badgeSource(details: ZacRoutingDetails | null | undefined): string | null {
  const { container, unmount } = render(<ZacRoutingBadge details={details} />);
  const source = container.querySelector('[data-testid="zac-routing-badge-source"]');
  const text = source?.textContent ?? null;
  unmount();
  return text;
}

describe('ZacRoutingBadge — compact indicator (spec §4, cases A–H)', () => {
  it.each([
    ['A', { request_mode: 'qlooqo_data', router_analysis_intent: 'business_priorities' }, 'QLOOQO Data · Business Priorities'],
    ['B', { request_mode: 'qlooqo_data', router_analysis_intent: 'specific_metric' }, 'QLOOQO Data · Specific Metric'],
    ['C', { request_mode: 'general_advice' }, 'General Knowledge / Advice'],
    ['D', { request_mode: 'hypothetical' }, 'Hypothetical'],
    ['E', { request_mode: 'memory' }, 'Memory'],
    ['F', { request_mode: 'permission_capability' }, 'Permission / Capability'],
    ['G', { request_mode: 'privacy_boundary' }, 'Privacy Boundary'],
    ['H', { request_mode: 'conversational' }, 'Conversational'],
  ])('%s. renders "Routing: %s"', (_case, details, expected) => {
    expect(badgeText(details as ZacRoutingDetails)).toBe(`Routing: ${expected}`);
  });

  it('never shows an intent label for none/null (§3)', () => {
    expect(badgeText({ request_mode: 'general_advice', router_analysis_intent: 'none' })).toBe(
      'Routing: General Knowledge / Advice',
    );
    expect(badgeText({ request_mode: 'hypothetical', analysis_intent: undefined })).toBe(
      'Routing: Hypothetical',
    );
  });

  it('uses the planner intent only when the router made no reading, and says so in the badge', () => {
    const plannerOnly: ZacRoutingDetails = { request_mode: 'qlooqo_data', analysis_intent: 'business_health' };
    expect(badgeText(plannerOnly)).toBe('Routing: QLOOQO Data · Business Health (planner intent)');
    expect(describeZacRouting(plannerOnly)?.analysisIntent?.origin).toBe('planner');
    expect(describeZacRouting(SEMANTIC_TURN)?.analysisIntent?.origin).toBe('router');
    expect(badgeText(SEMANTIC_TURN)).toBe('Routing: QLOOQO Data · Business Priorities');
  });

  it('shows the source as a separate element so semantic vs fallback is visible without expanding (§6)', () => {
    expect(badgeSource(SEMANTIC_TURN)).toBe('Source: OpenAI semantic router');
    const fallback: ZacRoutingDetails = {
      request_mode: 'qlooqo_data',
      classification_source: 'fallback',
      fallback_used: true,
      fallback_reason: 'classification_timeout',
    };
    expect(badgeText(fallback)).toBe('Routing: QLOOQO Data');
    expect(badgeSource(fallback)).toBe('Source: Fallback (Provider timeout)');
    // No classification source reported → no Source element, no guess.
    expect(badgeSource({ request_mode: 'memory' })).toBeNull();
  });

  it('communicates the route in text, not colour alone (§14)', () => {
    render(<ZacRoutingBadge details={SEMANTIC_TURN} />);
    expect(screen.getByText('QLOOQO Data · Business Priorities')).toBeTruthy();
  });
});

describe('ZacRoutingTechnicalDetails — expandable fields (spec §5, §6, §18)', () => {
  it('I. names the OpenAI semantic router, provider, model and versions on a semantic turn', () => {
    render(<ZacRoutingTechnicalDetails details={SEMANTIC_TURN} />);
    expect(screen.getByTestId('zac-routing-source').textContent).toBe('Source: OpenAI semantic router');
    const row = (key: string) => screen.getByTestId(`zac-routing-row-${key}`).textContent;
    expect(row('routing_mode')).toBe('Routing modeSemantic (semantic)');
    expect(row('request_mode')).toBe('Request modeQLOOQO Data (qlooqo_data)');
    expect(row('router_analysis_intent')).toBe(
      'Analysis intent (router)Business Priorities (business_priorities)',
    );
    expect(row('information_source')).toBe('Information sourceLive QLOOQO data (live_qlooqo)');
    expect(row('classification_source')).toBe('Classification sourceSemantic model (semantic_model)');
    expect(row('semantic_provider')).toBe('Semantic providerOpenAI (openai)');
    expect(row('semantic_model')).toBe('Semantic modelgpt-5.6-luna');
    expect(row('router_version')).toBe('Router versionsemantic-v2');
    expect(row('prompt_version')).toBe('Prompt version2026-09-02.1');
    expect(row('confidence')).toBe('ConfidenceHigh (0.92)');
    expect(row('fallback_used')).toBe('Fallback usedno');
    expect(screen.queryByTestId('zac-routing-row-fallback_reason')).toBeNull();
  });

  it('J. makes a fallback unmistakable: source Fallback, fallback used yes, and the safe reason', () => {
    render(
      <ZacRoutingTechnicalDetails
        details={{
          request_mode: 'qlooqo_data',
          classification_source: 'fallback',
          routing_mode: 'semantic',
          router_version: 'semantic-v2',
          semantic_provider: 'openai',
          semantic_model: 'gpt-5.6-luna',
          fallback_used: true,
          fallback_reason: 'provider_unavailable',
        }}
      />,
    );
    expect(screen.getByTestId('zac-routing-source').textContent).toBe(
      'Source: Fallback (Provider unavailable)',
    );
    expect(screen.getByTestId('zac-routing-row-fallback_used').textContent).toBe('Fallback usedyes');
    expect(screen.getByTestId('zac-routing-row-fallback_reason').textContent).toBe(
      'Fallback reasonProvider unavailable (provider_unavailable)',
    );
  });

  it('treats a clarification as a fallback too, without inventing a fallback_used row', () => {
    render(
      <ZacRoutingTechnicalDetails
        details={{ request_mode: 'qlooqo_data', classification_source: 'clarification' }}
      />,
    );
    expect(screen.getByTestId('zac-routing-source').textContent).toBe(
      'Source: Fallback (clarification)',
    );
    // The API did not return fallback_used, so no row claims it did.
    expect(screen.queryByTestId('zac-routing-row-fallback_used')).toBeNull();
  });

  it('credits a contextual follow-up to the semantic router that decided it', () => {
    render(
      <ZacRoutingTechnicalDetails
        details={{
          request_mode: 'qlooqo_data',
          classification_source: 'contextual_followup',
          routing_mode: 'semantic',
          semantic_provider: 'openai',
          fallback_used: false,
        }}
      />,
    );
    expect(screen.getByTestId('zac-routing-source').textContent).toBe(
      'Source: OpenAI semantic router (contextual follow-up)',
    );
  });

  it('shows the legacy Anthropic classifier honestly rather than as the OpenAI router', () => {
    render(
      <ZacRoutingTechnicalDetails
        details={{
          request_mode: 'general_advice',
          classification_source: 'semantic_model',
          routing_mode: 'legacy',
          router_version: 'semantic-v1',
          semantic_provider: 'anthropic',
          semantic_model: 'claude-sonnet-5',
        }}
      />,
    );
    expect(screen.getByTestId('zac-routing-source').textContent).toBe(
      'Source: Legacy semantic classifier (Anthropic)',
    );
    expect(screen.getByTestId('zac-routing-row-routing_mode').textContent).toBe(
      'Routing modeLegacy (legacy)',
    );
  });

  it('K. omits absent fields and renders safely on partial metadata', () => {
    const { container } = render(
      <ZacRoutingTechnicalDetails details={{ request_mode: 'memory' }} />,
    );
    expect(screen.getByTestId('zac-routing-row-request_mode').textContent).toBe(
      'Request modeMemory (memory)',
    );
    expect(container.querySelectorAll('[data-testid^="zac-routing-row-"]').length).toBe(1);
    expect(screen.getByTestId('zac-routing-source').textContent).toBe('Source: Not reported');
    expect(screen.queryByTestId('zac-routing-shadow')).toBeNull();
  });

  it('K. renders nothing at all without a request mode', () => {
    const { container } = render(
      <>
        <ZacRoutingTechnicalDetails details={{}} />
        <ZacRoutingTechnicalDetails details={null} />
        <ZacRoutingTechnicalDetails details={undefined} />
        <ZacRoutingBadge details={{ classification_source: 'semantic_model' }} />
      </>,
    );
    expect(container.innerHTML).toBe('');
  });

  it('humanises an enum value the client does not know instead of hiding it', () => {
    render(<ZacRoutingBadge details={{ request_mode: 'future_mode', router_analysis_intent: 'new_intent' }} />);
    expect(screen.getByTestId('zac-routing-summary').textContent).toBe('Routing: Future Mode · New Intent');
  });

  it('uses a native disclosure that is keyboard operable (§14)', () => {
    const { container } = render(<ZacRoutingTechnicalDetails details={SEMANTIC_TURN} />);
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details?.querySelector('summary')?.textContent).toBe('Technical details');
    expect(details?.hasAttribute('open')).toBe(false);
  });

  it('can render inline inside a caller-provided disclosure', () => {
    const { container } = render(
      <ZacRoutingTechnicalDetails details={SEMANTIC_TURN} collapsible={false} />,
    );
    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByTestId('zac-routing-source')).toBeTruthy();
  });

  it('shows the shadow comparison when the API returned one (§7)', () => {
    render(
      <ZacRoutingTechnicalDetails
        details={{
          request_mode: 'general_advice',
          classification_source: 'deterministic',
          routing_mode: 'shadow',
          shadow_route: {
            provider: 'openai',
            model: 'gpt-5.6-luna',
            request_mode: 'qlooqo_data',
            analysis_intent: 'business_priorities',
            information_source: 'live_qlooqo',
            confidence_bucket: 'high',
            failure: null,
            failure_kind: null,
            mode_agreement: false,
            live_data_agreement: false,
          },
        }}
      />,
    );
    const shadow = within(screen.getByTestId('zac-routing-shadow'));
    expect(shadow.getByText('Production route').nextElementSibling?.textContent).toBe(
      'General Knowledge / Advice',
    );
    expect(shadow.getByText('Shadow semantic route').nextElementSibling?.textContent).toBe(
      'QLOOQO Data · Business Priorities',
    );
    expect(shadow.getByText('Agreement').nextElementSibling?.textContent).toBe('No');
  });

  it('reports a failed shadow call as a failure, not as a route', () => {
    render(
      <ZacRoutingTechnicalDetails
        details={{
          request_mode: 'qlooqo_data',
          routing_mode: 'shadow',
          shadow_route: {
            provider: 'openai',
            model: 'gpt-5.6-luna',
            request_mode: null,
            analysis_intent: null,
            information_source: null,
            confidence_bucket: null,
            failure: 'classification_timeout',
            failure_kind: 'timeout',
            mode_agreement: null,
            live_data_agreement: null,
          },
        }}
      />,
    );
    const shadow = within(screen.getByTestId('zac-routing-shadow'));
    expect(shadow.getByText('Shadow semantic route').nextElementSibling?.textContent).toBe(
      'Failed (Provider timeout · Timeout)',
    );
    expect(shadow.getByText('Agreement').nextElementSibling?.textContent).toBe('Not available');
  });
});

describe('ZacRoutingInspector — presentation flag and per-turn metadata', () => {
  it('M. renders nothing when routing debug is disabled', () => {
    const { container } = render(<ZacRoutingInspector details={SEMANTIC_TURN} enabled={false} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders badge and details together when enabled', () => {
    render(<ZacRoutingInspector details={SEMANTIC_TURN} enabled />);
    expect(screen.getByTestId('zac-routing-badge')).toBeTruthy();
    expect(screen.getByTestId('zac-routing-source')).toBeTruthy();
  });

  it('N. shows no route for a turn that has no response yet (nothing speculative)', () => {
    const { container } = render(<ZacRoutingInspector details={undefined} enabled />);
    expect(container.innerHTML).toBe('');
  });

  it('L. each turn keeps its own route in a multi-turn transcript', () => {
    const turns: Array<{ id: number; details: ZacRoutingDetails }> = [
      { id: 1, details: { request_mode: 'qlooqo_data', router_analysis_intent: 'specific_metric' } },
      { id: 2, details: { request_mode: 'general_advice' } },
      { id: 3, details: { request_mode: 'hypothetical' } },
    ];
    render(
      <ul>
        {turns.map((turn) => (
          <li key={turn.id} data-testid={`turn-${turn.id}`}>
            <ZacRoutingInspector details={turn.details} enabled />
          </li>
        ))}
      </ul>,
    );
    const badgeIn = (id: number) =>
      within(screen.getByTestId(`turn-${id}`)).getByTestId('zac-routing-summary').textContent;
    expect(badgeIn(1)).toBe('Routing: QLOOQO Data · Specific Metric');
    expect(badgeIn(2)).toBe('Routing: General Knowledge / Advice');
    expect(badgeIn(3)).toBe('Routing: Hypothetical');
  });
});
