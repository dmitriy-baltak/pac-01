import type { OpenAIToolDefinition } from "./schemas.js";

export interface ToolCallEntry {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCallEntry[] }
  | { role: "tool"; content: string; tool_call_id: string };

export interface LLMResponse {
  result: string | null;
  tool_calls: ToolCallEntry[];
  duration_ms: number;
  total_cost_usd: number;
  stop_reason: string; // "stop" | "tool_calls" | "max_tokens"
}

export interface LLMOptions {
  tools?: OpenAIToolDefinition[];
  tool_choice?: "auto" | "required" | "none";
  maxTokens?: number;
}

// --- OpenAI ---

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_TIMEOUT_MS = 120_000; // 2 minutes

interface OpenAIResponse {
  choices: {
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCallEntry[];
    };
    finish_reason: string; // "stop" | "tool_calls" | "length"
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
    throw new Error("OPENAI_API_KEY is required. Set it in your environment.");
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.6,
    max_tokens: opts?.maxTokens ?? 8192,
  };

  if (opts?.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts?.tool_choice ?? "auto";
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
    result: choice.message.content ?? null,
    tool_calls: choice.message.tool_calls ?? [],
    duration_ms: Date.now() - start,
    total_cost_usd: cost,
    stop_reason: choice.finish_reason === "length" ? "max_tokens"
      : choice.finish_reason === "tool_calls" ? "tool_calls"
      : "stop",
  };
}

// --- Router ---

export async function callLLM(
  model: string,
  messages: ChatMessage[],
  opts?: LLMOptions,
): Promise<LLMResponse> {
  return callOpenAI(model, messages, opts);
}
