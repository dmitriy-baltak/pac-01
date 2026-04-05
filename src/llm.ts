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
  format?: "json";
  maxTokens?: number;
}

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const TIMEOUT_MS = 600_000; // 10 minutes — cold start can take 2-3 min to load 20GB into RAM

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
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

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
      throw new Error(`Ollama request timed out after ${TIMEOUT_MS / 1000}s`);
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

export async function callLLM(
  model: string,
  messages: ChatMessage[],
  opts?: LLMOptions,
): Promise<LLMResponse> {
  return callOllama(model, messages, opts);
}
