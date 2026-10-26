/**
 * Unit spec — Streamflow AI request builder + client.
 *
 * The pure ai.request helpers are exercised directly (message shaping, base64 →
 * data URI, per-provider base URL, response parse, cost estimate). The AiClient
 * runs with a fake fetch + fake usage tracker + a stub SSRF resolver: no network,
 * no DNS. Locks down key resolution, the fail-closed budget guard, usage
 * accounting and that the API key never leaks into thrown errors.
 */
import {
  buildChatRequest,
  estimateUsd,
  parseChatResponse,
  providerBaseUrl,
  resolveImageSource,
} from './ai.request';
import {
  AiBudgetExceededError,
  AiClient,
  AiConfigError,
  type AiUsageTracker,
} from './ai.client';

describe('ai.request (pure builder)', () => {
  it('picks the provider base URL', () => {
    expect(providerBaseUrl('openai')).toBe('https://api.openai.com/v1');
    expect(providerBaseUrl('deepseek')).toBe('https://api.deepseek.com/v1');
  });

  it('builds a text-only chat request (openai default)', () => {
    const req = buildChatRequest({ model: 'gpt-4o-mini', prompt: 'hi' });
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.body.model).toBe('gpt-4o-mini');
    expect(req.body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(req.headers.authorization).toBeUndefined(); // no secret in the pure builder
  });

  it('swaps to the DeepSeek base URL by provider', () => {
    const req = buildChatRequest({
      provider: 'deepseek',
      model: 'deepseek-chat',
      prompt: 'x',
    });
    expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('shapes a vision content array from an image URL', () => {
    const req = buildChatRequest({
      model: 'gpt-4o-mini',
      prompt: 'what is this?',
      imageUrl: 'https://cdn.test/a.jpg',
    });
    const msg = (req.body.messages as Array<{ content: unknown }>)[0];
    expect(msg.content).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: 'https://cdn.test/a.jpg' } },
    ]);
  });

  it('wraps raw base64 as a data: URI', () => {
    expect(resolveImageSource({ model: 'm', prompt: 'p', imageBase64: 'QUJD' })).toBe(
      'data:image/jpeg;base64,QUJD',
    );
    // Honors an explicit mime and passes a data: URI through untouched.
    expect(
      resolveImageSource({ model: 'm', prompt: 'p', imageBase64: 'QUJD', imageMime: 'image/png' }),
    ).toBe('data:image/png;base64,QUJD');
    expect(
      resolveImageSource({ model: 'm', prompt: 'p', imageBase64: 'data:image/gif;base64,ZZ' }),
    ).toBe('data:image/gif;base64,ZZ');
  });

  it('adds system prompt, json mode and max_tokens', () => {
    const req = buildChatRequest({
      model: 'gpt-4o-mini',
      prompt: 'p',
      system: 'be terse',
      jsonMode: true,
      maxTokens: 128,
    });
    const messages = req.body.messages as Array<{ role: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'be terse' });
    expect(req.body.response_format).toEqual({ type: 'json_object' });
    expect(req.body.max_tokens).toBe(128);
  });

  it('parses the completion text + token usage', () => {
    const parsed = parseChatResponse({
      choices: [{ message: { content: 'yes' } }],
      usage: { total_tokens: 42 },
    });
    expect(parsed.text).toBe('yes');
    expect(parsed.usageTokens).toBe(42);
    // Missing fields degrade gracefully.
    expect(parseChatResponse({})).toEqual({ text: '', usageTokens: 0, raw: {} });
  });

  it('estimates a positive cost, defaulting for unknown models', () => {
    expect(estimateUsd('gpt-4o-mini', 1000)).toBeCloseTo(0.0006, 6);
    expect(estimateUsd('unknown-model', 1000)).toBeGreaterThan(0);
    expect(estimateUsd('gpt-4o-mini', 0)).toBe(0);
  });
});

describe('AiClient', () => {
  let usage: AiUsageTracker;
  let spent: number;
  let added: Array<{ tokens: number; usd: number }>;
  let client: AiClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    spent = 0;
    added = [];
    usage = {
      monthlyUsd: () => spent,
      addUsage: (_a, _d, tokens, usd) => {
        added.push({ tokens, usd });
        spent += usd;
      },
    };
    client = new AiClient(usage);
    client.hostResolver = async () => ['93.184.216.34'];
    fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'a real intrusion' } }],
        usage: { total_tokens: 100 },
      }),
      text: async () => '',
    }));
    client.fetchImpl = fetchMock as never;
  });

  it('calls the provider, returns text + usage, records spend', async () => {
    const res = await client.chat({
      app: 'live',
      appDir: '/tmp/live',
      model: 'gpt-4o-mini',
      prompt: 'is this a real intrusion?',
      apiKey: 'sk-test',
      budgetUsd: 20,
    });
    expect(res.text).toBe('a real intrusion');
    expect(res.usageTokens).toBe(100);
    expect(added).toHaveLength(1);
    expect(added[0].tokens).toBe(100);

    // The Authorization header carried the key — but it must never appear in
    // the returned result object.
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe('Bearer sk-test');
    expect(JSON.stringify(res)).not.toContain('sk-test');
  });

  it('throws AiConfigError when no key resolves (nothing dialed)', async () => {
    await expect(
      client.chat({ app: 'live', appDir: '/tmp/live', model: 'm', prompt: 'p' }),
    ).rejects.toBeInstanceOf(AiConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed once the monthly budget is reached', async () => {
    spent = 25;
    await expect(
      client.chat({
        app: 'live',
        appDir: '/tmp/live',
        model: 'm',
        prompt: 'p',
        apiKey: 'sk-test',
        budgetUsd: 20,
      }),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never leaks the key in an error message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'bad key sk-test',
    });
    await client
      .chat({
        app: 'live',
        appDir: '/tmp/live',
        model: 'm',
        prompt: 'p',
        apiKey: 'sk-secret-123',
        budgetUsd: 0,
      })
      .catch((err: Error) => {
        expect(err.message).not.toContain('sk-secret-123');
      });
    expect.assertions(1);
  });
});
