export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  result: string;
  duration_ms: number;
  total_cost_usd: number;
  stop_reason: string; // "stop" | "max_tokens"
}

export interface LLMOptions {
  format?: "json" | Record<string, unknown>;
  maxTokens?: number;
}

// --- Ollama ---

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const OLLAMA_TIMEOUT_MS = 600_000; // 10 minutes — cold start can take 2-3 min to load 20GB into RAM

interface OllamaResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number; // nanoseconds
  eval_count?: number;
  done_reason?: string; // "stop" | "length"
}

function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function callOllama(
  model: string,
  messages: ChatMessage[],
  opts?: LLMOptions,
): Promise<LLMResponse> {
  const body = {
    model,
    messages,
    stream: false,
    ...(opts?.format ? { format: opts.format } : {}),
    options: {
      num_predict: opts?.maxTokens ?? 4096,
      temperature: 0.6,
      top_p: 0.95,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Ollama request timed out after ${OLLAMA_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(
      `Failed to connect to Ollama at ${OLLAMA_HOST}. Is Ollama running? Try: ollama serve`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama returned ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as OllamaResponse;
  const content = stripThinkTags(data.message?.content ?? "");
  const durationNs = data.total_duration ?? 0;

  return {
    result: content,
    duration_ms: Math.round(durationNs / 1_000_000),
    total_cost_usd: 0,
    stop_reason: data.done_reason === "length" ? "max_tokens" : "stop",
  };
}

// --- OpenAI ---

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_TIMEOUT_MS = 120_000; // 2 minutes

interface OpenAIResponse {
  choices: {
    message: { role: string; content: string };
    finish_reason: string; // "stop" | "length"
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

// Rough per-token pricing (USD) — updated for common models
const GPT_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15 / 1e6, output: 0.6 / 1e6 },
  "gpt-4o": { input: 2.5 / 1e6, output: 10 / 1e6 },
  "gpt-4.1-mini": { input: 0.4 / 1e6, output: 1.6 / 1e6 },
  "gpt-4.1-nano": { input: 0.1 / 1e6, output: 0.4 / 1e6 },
};

async function callOpenAI(
  model: string,
  messages: ChatMessage[],
  opts?: LLMOptions,
): Promise<LLMResponse> {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for GPT models. Set it in your environment.");
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.6,
    max_tokens: opts?.maxTokens ?? 4096,
  };

  if (typeof opts?.format === "object" && opts?.format) {
    // Use OpenAI structured outputs with the provided JSON schema
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", strict: false, schema: opts.format },
    };
  } else if (opts?.format === "json") {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  const start = Date.now();

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OpenAI request timed out after ${OPENAI_TIMEOUT_MS / 1000}s`);
    }
    throw new Error(`Failed to connect to OpenAI API: ${err}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI returned ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as OpenAIResponse;
  const choice = data.choices?.[0];
  if (!choice) {
    throw new Error("OpenAI returned no choices");
  }

  const pricing = GPT_PRICING[model] ?? { input: 0, output: 0 };
  const usage = data.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const cost = usage.prompt_tokens * pricing.input + usage.completion_tokens * pricing.output;

  return {
    result: choice.message.content ?? "",
    duration_ms: Date.now() - start,
    total_cost_usd: cost,
    stop_reason: choice.finish_reason === "length" ? "max_tokens" : "stop",
  };
}

// --- Router ---

function isOpenAIModel(model: string): boolean {
  return model.startsWith("gpt-");
}

export async function callLLM(
  model: string,
  messages: ChatMessage[],
  opts?: LLMOptions,
): Promise<LLMResponse> {
  if (isOpenAIModel(model)) {
    return callOpenAI(model, messages, opts);
  }
  return callOllama(model, messages, opts);
}
