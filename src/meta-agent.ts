import { callLLM, type ChatMessage } from "./llm.js";
import { loadMetaPrompt, getLatestMetaVersion } from "./prompt.js";
import { estimateTokens } from "./scoring.js";
import type { TaskTrace } from "./trace.js";

export interface EvalSummary {
  version: string;
  avg_score: number;
  task_scores: { task_id: string; score: number }[];
  n_tasks: number;
  timestamp: string;
}

// --- Signal extraction ---

const WRITE_TOOLS = new Set(["write", "delete", "mkdir", "move"]);

export function diagnosePatterns(trace: TaskTrace): string[] {
  const patterns: string[] = [];
  const steps = trace.steps;

  // STAGNATION — 3+ consecutive identical tool+params calls
  for (let i = 0; i <= steps.length - 3; i++) {
    const key = (s: typeof steps[0]) => `${s.tool}:${JSON.stringify(s.params)}`;
    if (key(steps[i]) === key(steps[i + 1]) && key(steps[i + 1]) === key(steps[i + 2])) {
      patterns.push("STAGNATION");
      break;
    }
  }

  // EXHAUSTION — hit step limit without converging
  if (trace.total_steps >= 28) {
    patterns.push("EXHAUSTION");
  }

  // NO_SIDE_EFFECTS — outcome "ok" but no write/delete/mkdir/move calls
  if (trace.outcome === "ok") {
    const hasWrite = steps.some((s) => WRITE_TOOLS.has(s.tool));
    if (!hasWrite) {
      patterns.push("NO_SIDE_EFFECTS");
    }
  }

  // PARSE_ERRORS — count of steps with parse_error
  const parseErrors = steps.filter((s) => s.parse_error).length;
  if (parseErrors > 0) {
    patterns.push(`PARSE_ERRORS(${parseErrors})`);
  }

  // MISSING_REFS — score_detail mentions refs
  if (trace.score_detail.some((d) => d.toLowerCase().includes("ref"))) {
    patterns.push("MISSING_REFS");
  }

  // ERROR_CASCADE — 2+ steps with errors
  const errorSteps = steps.filter((s) => s.error).length;
  if (errorSteps >= 2) {
    patterns.push(`ERROR_CASCADE(${errorSteps})`);
  }

  return patterns;
}

export function extractCriticalSteps(trace: TaskTrace): string[] {
  const steps = trace.steps;
  if (steps.length === 0) return [];

  const indices = new Set<number>();

  // First step
  indices.add(0);

  // First error step
  const firstError = steps.findIndex((s) => s.error);
  if (firstError >= 0) indices.add(firstError);

  // Last non-answer action
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].tool !== "answer") {
      indices.add(i);
      break;
    }
  }

  // Answer step
  const answerIdx = steps.findIndex((s) => s.tool === "answer");
  if (answerIdx >= 0) indices.add(answerIdx);

  return [...indices].sort((a, b) => a - b).map((i) => {
    const s = steps[i];
    const preview = s.result_preview ? s.result_preview.slice(0, 100) : "";
    let line = `  Step ${s.step}: [${s.tool}] ${JSON.stringify(s.params)}`;
    if (preview) line += `\n    Result: ${preview}`;
    if (s.error) line += `\n    ERROR: ${s.error}`;
    if (s.parse_error) line += `\n    PARSE ERROR: ${s.parse_error}`;
    return line;
  });
}

export function extractFailureSignal(traces: TaskTrace[]): string {
  return traces.map((t) => {
    const patterns = diagnosePatterns(t);
    const criticalSteps = extractCriticalSteps(t);

    const scoreStr = t.score !== undefined ? t.score.toFixed(2) : "N/A";
    const detailStr = t.score_detail.length > 0 ? t.score_detail.join("; ") : "none";

    return `### Task: ${t.task_id}
Score: ${scoreStr} | Outcome: ${t.outcome ?? "unknown"} | Steps: ${t.total_steps}/30 | Time: ${t.total_elapsed_ms}ms
Evaluator: ${detailStr}
Patterns: ${patterns.length > 0 ? patterns.join(", ") : "none"}
Key steps:
${criticalSteps.join("\n")}`;
  }).join("\n\n---\n\n");
}

// --- Meta-agent ---

export interface RunMetaAgentOpts {
  metaPromptVersion?: string;
  experimentHistory?: string;
  focusDirective?: string;
  promptTokens?: number;
}

export async function runMetaAgent(
  model: string,
  currentPrompt: string,
  currentVersion: string,
  summary: EvalSummary,
  failedTraces: TaskTrace[],
  opts?: RunMetaAgentOpts,
): Promise<{ newPrompt: string; reasoning: string }> {
  // Load meta-prompt from file
  const metaVersion = opts?.metaPromptVersion ?? getLatestMetaVersion();
  let metaPrompt = loadMetaPrompt(metaVersion);

  // Hydrate template variables
  const historyStr = opts?.experimentHistory ?? "No prior experiments.";
  metaPrompt = metaPrompt.replace("{{EXPERIMENT_HISTORY}}", `## Experiment History\n${historyStr}`);

  const tokens = opts?.promptTokens ?? estimateTokens(currentPrompt);
  let metricsStr = `Current prompt: ${tokens} tokens (target: <1500)`;
  if (tokens > 1500) {
    metricsStr += `\n⚠ Prompt is ${tokens - 1500} tokens over the soft cap. Consider compressing or removing low-value instructions.`;
  }
  metaPrompt = metaPrompt.replace("{{PROMPT_METRICS}}", `## Prompt Metrics\n${metricsStr}`);

  const focusStr = opts?.focusDirective ?? "Focus on highest-impact failure patterns";
  metaPrompt = metaPrompt.replace("{{FOCUS_DIRECTIVE}}", `## Focus\n${focusStr}`);

  // Build user prompt with compact failure signal
  const userPrompt = `## Current Performance
Average score: ${summary.avg_score.toFixed(2)} across ${summary.n_tasks} tasks

## Current System Prompt (version ${currentVersion})
${currentPrompt}

## Failed/Low-Scoring Tasks
${extractFailureSignal(failedTraces)}

Analyze the failures and produce an improved system prompt. Respond with JSON only.`;

  const messages: ChatMessage[] = [
    { role: "system", content: metaPrompt },
    { role: "user", content: userPrompt },
  ];
  const response = await callLLM(model, messages, { format: "json" });

  let text = response.result;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1];

  const parsed = JSON.parse(text.trim());
  return {
    newPrompt: parsed.new_prompt,
    reasoning: parsed.reasoning,
  };
}
