const openRouterUrl = 'https://openrouter.ai/api/v1/chat/completions';
const requestTimeoutMs = 45_000;

export class AiServiceError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'AiServiceError';
    this.statusCode = statusCode;
  }
}

function configuredProvider() {
  return (process.env.AI_PROVIDER || 'openrouter').trim().toLowerCase();
}

export function aiConfiguration() {
  const provider = configuredProvider();

  if (provider !== 'openrouter') {
    return {
      configured: false,
      provider,
      model: null,
      message: `Unsupported AI provider: ${provider}`,
    };
  }

  const apiKey = process.env.OPENROUTER_API_KEY?.trim() || '';
  const model = process.env.OPENROUTER_MODEL?.trim() || '';

  return {
    configured: apiKey.length > 0 && model.length > 0,
    provider,
    model: model || null,
    message:
      apiKey.length > 0 && model.length > 0
        ? null
        : 'OPENROUTER_API_KEY and OPENROUTER_MODEL are required.',
  };
}

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (joined) return joined;
  }

  throw new AiServiceError('The AI provider returned an empty response.');
}

export async function generateAiText({
  systemPrompt,
  userPrompt,
  temperature = 0,
  maxTokens = 120,
}) {
  const configuration = aiConfiguration();

  if (!configuration.configured) {
    throw new AiServiceError(configuration.message, 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

  try {
    const response = await fetch(openRouterUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY.trim()}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL?.trim() ||
          'https://sehatmate-api.secretstechies.com',
        'X-Title': 'SehatMate AI',
      },
      body: JSON.stringify({
        model: configuration.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
        reasoning: {
          effort: 'low',
          exclude: true,
        },
        provider: {
          data_collection: 'deny',
        },
      }),
    });

    const rawBody = await response.text();
    let payload;

    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      throw new AiServiceError('The AI provider returned invalid JSON.');
    }

    if (!response.ok) {
      const providerMessage = payload?.error?.message;
      const safeMessage = typeof providerMessage === 'string'
        ? providerMessage.slice(0, 300)
        : 'The AI request failed.';
      throw new AiServiceError(safeMessage, response.status === 429 ? 429 : 502);
    }

    return {
      text: responseText(payload),
      provider: configuration.provider,
      model: configuration.model,
    };
  } catch (error) {
    if (error instanceof AiServiceError) throw error;
    if (error?.name === 'AbortError') {
      throw new AiServiceError('The AI provider took too long to respond.', 504);
    }
    throw new AiServiceError('Could not connect to the AI provider.');
  } finally {
    clearTimeout(timeout);
  }
}
