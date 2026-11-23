/**
 * The floating assistant keeps a client-side transcript. Each answer bubble
 * must render the routing metadata of ITS OWN response (§10), and none at all
 * when the presentation flag is off (§8).
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ZacAskResponse } from '../../auth/api';
import { ZacAnswerBubble, ZacChatWidget } from './ZacChatWidget';

const mockAskZac = jest.fn();
let mockRoutingDebug = false;
const mockAuth = {
  user: { id: 'user-1', permissions: ['zac.access'] },
  session: { accessToken: 'token' },
};

jest.mock('../../auth/api', () => ({
  ApiRequestError: class ApiRequestError extends Error {
    status = 500;
  },
  askZac: (...args: unknown[]) => mockAskZac(...args),
  submitZacFeedback: jest.fn(),
}));
jest.mock('../../auth/AuthProvider', () => ({ useAuth: () => mockAuth }));
jest.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/' }) }));
// The env reader uses `import.meta` (Vite); tests drive the flag directly.
jest.mock('../../config/zacRoutingDebug', () => ({
  zacRoutingDebugEnabled: () => mockRoutingDebug,
}));

beforeEach(() => {
  mockAskZac.mockReset();
  mockRoutingDebug = false;
});

/** Open the floating widget and submit one question. */
function askInWidget(question: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Ask ZAC, your AI business assistant' }));
  const input = screen.getByPlaceholderText('Ask about your business…');
  fireEvent.change(input, { target: { value: question } });
  fireEvent.submit(input.closest('form') as HTMLFormElement);
}

function makeResponse(
  answer: string,
  technical: Partial<ZacAskResponse['technical_details']>,
): ZacAskResponse {
  return {
    answer,
    role_context: 'owner',
    response_type: 'Insight',
    evidence: [],
    confidence: 'high',
    limitations: [],
    suggested_next_step: null,
    measurement_hook: null,
    attribution_seed: null,
    memory_updates: [],
    tool_calls: [],
    cost_metadata: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      input_tokens: 1,
      output_tokens: 1,
      reasoning_tokens: 0,
      estimated_cost_usd: 0,
      cache_hit: false,
    },
    technical_details: {
      foundation_mode: false,
      feature_flag_state: 'enabled',
      connected_tools: [],
      disabled_tools: [],
      provider: 'anthropic',
      model: 'claude-opus-5',
      ...technical,
    },
    trace_id: 'trace',
    conversation_id: null,
    output_id: null,
  };
}

describe('ZacAnswerBubble routing inspector', () => {
  it('L. every turn in a transcript shows its own backend route', () => {
    const turns = [
      { id: 1, response: makeResponse('Rebooking is 39%.', { request_mode: 'qlooqo_data', router_analysis_intent: 'specific_metric', classification_source: 'semantic_model', semantic_provider: 'openai' }) },
      { id: 2, response: makeResponse('A stylist is…', { request_mode: 'general_advice', classification_source: 'deterministic' }) },
      { id: 3, response: makeResponse('If they were at 40%…', { request_mode: 'hypothetical', classification_source: 'semantic_model', semantic_provider: 'openai' }) },
    ];
    render(
      <ul>
        {turns.map((turn) => (
          <li key={turn.id} data-testid={`turn-${turn.id}`}>
            <ZacAnswerBubble response={turn.response} onAsk={() => undefined} routingDebug />
          </li>
        ))}
      </ul>,
    );
    const badge = (id: number) =>
      within(screen.getByTestId(`turn-${id}`)).getByTestId('zac-routing-summary').textContent;
    expect(badge(1)).toBe('Routing: Service SaaS Data · Specific Metric');
    expect(badge(2)).toBe('Routing: General Knowledge / Advice');
    expect(badge(3)).toBe('Routing: Hypothetical');
    const source = (id: number) =>
      within(screen.getByTestId(`turn-${id}`)).getByTestId('zac-routing-badge-source').textContent;
    expect(source(1)).toBe('Source: OpenAI semantic router');
    expect(source(2)).toBe('Source: Deterministic rules (no model)');
  });

  it('M. shows no routing UI to a normal user when the flag is off', () => {
    render(
      <ZacAnswerBubble
        response={makeResponse('Hello', { request_mode: 'conversational' })}
        onAsk={() => undefined}
      />,
    );
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.queryByTestId('zac-routing-badge')).toBeNull();
    expect(screen.queryByTestId('zac-routing-inspector')).toBeNull();
  });

  it('shows nothing routing-related when the API returned no request mode, even with the flag on', () => {
    render(
      <ZacAnswerBubble response={makeResponse('Hello', {})} onAsk={() => undefined} routingDebug />,
    );
    expect(screen.queryByTestId('zac-routing-inspector')).toBeNull();
  });
});

describe('ZacChatWidget routing inspector', () => {
  it('N. shows "ZAC is thinking" and no route while the answer is in flight', () => {
    mockRoutingDebug = true;
    mockAskZac.mockReturnValue(new Promise(() => undefined)); // never settles
    render(<ZacChatWidget />);
    askInWidget('What is my rebooking?');
    expect(screen.getByLabelText('ZAC is thinking')).toBeTruthy();
    expect(screen.queryByTestId('zac-routing-badge')).toBeNull();
    expect(screen.queryByTestId('zac-routing-inspector')).toBeNull();
  });

  it('invents no route when the request fails', async () => {
    mockRoutingDebug = true;
    mockAskZac.mockRejectedValue(new Error('boom'));
    render(<ZacChatWidget />);
    askInWidget('What is my rebooking?');
    expect(await screen.findByText('Something went wrong talking to ZAC. Please try again.')).toBeTruthy();
    expect(screen.queryByTestId('zac-routing-badge')).toBeNull();
  });

  it('M. renders the route only when the presentation flag is on', async () => {
    mockAskZac.mockResolvedValue(
      makeResponse('Rebooking is 39%.', {
        request_mode: 'qlooqo_data',
        router_analysis_intent: 'specific_metric',
        classification_source: 'semantic_model',
        semantic_provider: 'openai',
      }),
    );

    const off = render(<ZacChatWidget />);
    askInWidget('What is my rebooking?');
    expect(await screen.findByText('Rebooking is 39%.')).toBeTruthy();
    expect(screen.queryByTestId('zac-routing-badge')).toBeNull();
    off.unmount();

    mockRoutingDebug = true;
    render(<ZacChatWidget />);
    askInWidget('What is my rebooking?');
    expect(await screen.findByText('Rebooking is 39%.')).toBeTruthy();
    expect(screen.getByTestId('zac-routing-summary').textContent).toBe(
      'Routing: Service SaaS Data · Specific Metric',
    );
    expect(screen.getByTestId('zac-routing-badge-source').textContent).toBe(
      'Source: OpenAI semantic router',
    );
  });
});
