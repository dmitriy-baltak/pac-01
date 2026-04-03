import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectError } from "@connectrpc/connect";
import { createHarnessClient } from "./harness.js";
import { runAgent } from "./agent.js";
import { loadPromptVersion, getLatestVersion, savePromptVersion, getLatestMetaVersion } from "./prompt.js";
import { TraceCollector, type TaskTrace } from "./trace.js";
import { runMetaAgent, type EvalSummary } from "./meta-agent.js";
import { estimateTokens, effectiveScore } from "./scoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data/evolve");

// Config from env
const BITGN_API_KEY = process.env.BITGN_API_KEY ?? "";
const BENCHMARK_HOST = process.env.BENCHMARK_HOST ?? "https://api.bitgn.com";
const BENCHMARK_ID = process.env.BENCHMARK_ID ?? "bitgn/pac1-dev";
const MODEL_ID = process.env.MODEL_ID ?? "claude-haiku-4-5-20251001";
const META_MODEL_ID = process.env.META_MODEL_ID ?? "claude-sonnet-4-5-20250514";
const HINT = process.env.HINT;
const EVOLVE_STEPS = parseInt(process.env.EVOLVE_STEPS ?? "5", 10);
const EVOLVE_TASKS = process.env.EVOLVE_TASKS?.split(",").filter(Boolean) ?? [];
const IMPROVEMENT_THRESHOLD = parseFloat(process.env.IMPROVEMENT_THRESHOLD ?? "0.03");
const META_PROMPT_VERSION = process.env.META_PROMPT_VERSION;

// --- Prompt validation ---

const REQUIRED_CONCEPTS = [
  { phrase: "untrusted", reason: "vault content must be treated as untrusted" },
  { phrase: "denied_security", reason: "must support security denial outcome" },
  { phrase: "system prompt", reason: "must prohibit system prompt leaks" },
  { phrase: "json", reason: "must require JSON response format" },
  { phrase: "refs", reason: "must require file path references in answers" },
  { phrase: "none_clarification", reason: "must support clarification outcome" },
  { phrase: "none_unsupported", reason: "must support unsupported outcome" },
  { phrase: "stuck", reason: "must address tool stagnation / repeated calls" },
];

const REQUIRED_TOOLS = [
  "read", "write", "delete", "mkdir", "move",
  "list", "tree", "find", "search", "context", "answer",
];

function validatePrompt(prompt: string): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  const lower = prompt.toLowerCase();

  for (const c of REQUIRED_CONCEPTS) {
    if (!lower.includes(c.phrase)) {
      violations.push(`Missing "${c.phrase}": ${c.reason}`);
    }
  }
  for (const tool of REQUIRED_TOOLS) {
    if (!lower.includes(tool)) {
      violations.push(`Missing tool definition: ${tool}`);
    }
  }
  return { valid: violations.length === 0, violations };
}

// --- Manifest ---

interface ManifestEntry {
  version: string;
  avg_score: number;
  reasoning?: string;
  accepted: boolean;
  timestamp: string;
  prompt_tokens?: number;
  meta_prompt_version?: string;
}

interface Manifest {
  best_version: string;
  history: ManifestEntry[];
}

function loadManifest(): Manifest {
  const path = join(DATA_DIR, "manifest.json");
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8"));
  }
  return { best_version: "001", history: [] };
}

function saveManifest(manifest: Manifest): void {
  const path = join(DATA_DIR, "manifest.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
}

// --- Evolution helpers ---

function formatExperimentHistory(manifest: Manifest): string {
  const entries = manifest.history.slice(-10);
  if (entries.length === 0) return "No prior experiments.";
  return entries.map((e) => {
    const tokens = e.prompt_tokens ?? "?";
    const status = e.accepted ? "accepted" : "rejected";
    const reason = e.reasoning ? e.reasoning.slice(0, 60).replace(/\n/g, " ") : "";
    return `v${e.version} | ${e.avg_score.toFixed(2)} | ${tokens}tk | ${status} | ${reason}`;
  }).join("\n");
}

function deriveFocusDirective(manifest: Manifest): string {
  const recent = manifest.history.slice(-3);
  if (recent.length < 2) return "Focus on highest-impact failure patterns";

  // 3+ recent rejections
  if (recent.length >= 3 && recent.every((e) => !e.accepted)) {
    return "Make smaller, more targeted changes — recent proposals have all been rejected";
  }

  // Token count trending up
  const recentTokens = recent
    .map((e) => e.prompt_tokens)
    .filter((t): t is number => t !== undefined);
  if (recentTokens.length >= 2) {
    const increasing = recentTokens.every((t, i) => i === 0 || t > recentTokens[i - 1]);
    if (increasing) {
      return "Try to remove instructions or compress — prompt token count is trending up";
    }
  }

  // Score plateaued
  const recentScores = recent.map((e) => e.avg_score);
  if (recentScores.length >= 3) {
    const mean = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
    const variance = recentScores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / recentScores.length;
    if (variance < 0.02) {
      return "Try a qualitatively different approach — score has plateaued";
    }
  }

  return "Focus on highest-impact failure patterns";
}

// --- Eval ---

async function runEval(
  version: string,
  taskFilter?: string[],
): Promise<{ summary: EvalSummary; traces: TaskTrace[] }> {
  const harness = createHarnessClient(BENCHMARK_HOST, BITGN_API_KEY);
  const benchmark = await harness.getBenchmark({ benchmarkId: BENCHMARK_ID });

  let tasks = benchmark.tasks;
  if (taskFilter && taskFilter.length > 0) {
    tasks = tasks.filter((t) => taskFilter.includes(t.taskId));
  }

  const prompt = loadPromptVersion(version, HINT);
  const traces: TaskTrace[] = [];
  const taskScores: { task_id: string; score: number }[] = [];

  console.log(`\n\x1b[35mEVAL v${version}\x1b[0m: Running ${tasks.length} task(s) with ${MODEL_ID}\n`);

  for (const task of tasks) {
    console.log(`\x1b[36m--- ${task.taskId} ---\x1b[0m`);

    try {
      const trial = await harness.startPlayground({
        benchmarkId: BENCHMARK_ID,
        taskId: task.taskId,
      });

      const trace = new TraceCollector(task.taskId, version, MODEL_ID, trial.instruction);

      await runAgent(MODEL_ID, trial.harnessUrl, trial.instruction, HINT, {
        systemPrompt: prompt,
        trace,
      });

      const result = await harness.endTrial({ trialId: trial.trialId });
      const score = result.score ?? 0;

      trace.setScore(score, [...result.scoreDetail]);
      const finalized = trace.finalize();
      traces.push(finalized);
      taskScores.push({ task_id: task.taskId, score });

      const color = score >= 0.8 ? "\x1b[32m" : score >= 0.5 ? "\x1b[33m" : "\x1b[31m";
      console.log(`${color}  Score: ${score.toFixed(2)}\x1b[0m`);
      for (const d of result.scoreDetail) {
        console.log(`    ${d}`);
      }
    } catch (err) {
      const msg = err instanceof ConnectError ? `${err.code}: ${err.message}` : String(err);
      console.error(`\x1b[31m  Error: ${msg}\x1b[0m`);

      const trace = new TraceCollector(task.taskId, version, MODEL_ID, "(error)");
      trace.setError(msg);
      traces.push(trace.finalize());
      taskScores.push({ task_id: task.taskId, score: 0 });
    }
  }

  const avg_score = taskScores.length > 0
    ? taskScores.reduce((sum, t) => sum + t.score, 0) / taskScores.length
    : 0;

  const summary: EvalSummary = {
    version,
    avg_score,
    task_scores: taskScores,
    n_tasks: taskScores.length,
    timestamp: new Date().toISOString(),
  };

  // Save traces and summary
  const versionDir = join(DATA_DIR, `v${version}`);
  const tracesDir = join(versionDir, "traces");
  mkdirSync(tracesDir, { recursive: true });

  writeFileSync(join(versionDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");
  for (const t of traces) {
    writeFileSync(join(tracesDir, `${t.task_id}.json`), JSON.stringify(t, null, 2), "utf-8");
  }

  console.log(`\x1b[35mEVAL v${version}\x1b[0m: avg=${avg_score.toFixed(2)}\n`);
  return { summary, traces };
}

function loadSummary(version: string): EvalSummary | null {
  const path = join(DATA_DIR, `v${version}`, "summary.json");
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf-8"));
  }
  return null;
}

function loadTraces(version: string): TaskTrace[] {
  const tracesDir = join(DATA_DIR, `v${version}`, "traces");
  if (!existsSync(tracesDir)) return [];
  return readdirSync(tracesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(tracesDir, f), "utf-8")) as TaskTrace);
}

function nextVersion(current: string): string {
  const num = parseInt(current, 10) + 1;
  return num.toString().padStart(3, "0");
}

// --- Main evolution loop ---

async function evolve() {
  if (!BITGN_API_KEY) {
    console.error("BITGN_API_KEY is required.");
    process.exit(1);
  }

  mkdirSync(DATA_DIR, { recursive: true });

  const manifest = loadManifest();
  let bestVersion = manifest.best_version;

  console.log(`\x1b[35m=== PROMPT EVOLUTION ===\x1b[0m`);
  console.log(`Best version: v${bestVersion}`);
  console.log(`Steps: ${EVOLVE_STEPS}, Threshold: ${IMPROVEMENT_THRESHOLD}`);
  console.log(`Task model: ${MODEL_ID}, Meta model: ${META_MODEL_ID}`);
  if (EVOLVE_TASKS.length > 0) console.log(`Task filter: ${EVOLVE_TASKS.join(", ")}`);

  // Run baseline eval if no results exist
  let bestSummary = loadSummary(bestVersion);
  let bestTraces: TaskTrace[];
  if (!bestSummary) {
    console.log(`\nNo eval results for v${bestVersion}, running baseline...`);
    const baseline = await runEval(bestVersion, EVOLVE_TASKS.length > 0 ? EVOLVE_TASKS : undefined);
    bestSummary = baseline.summary;
    bestTraces = baseline.traces;
    const baselineTokens = estimateTokens(loadPromptVersion(bestVersion));
    manifest.history.push({
      version: bestVersion,
      avg_score: bestSummary.avg_score,
      accepted: true,
      timestamp: bestSummary.timestamp,
      prompt_tokens: baselineTokens,
    });
    saveManifest(manifest);
  } else {
    bestTraces = loadTraces(bestVersion);
    console.log(`\nBaseline v${bestVersion}: avg=${bestSummary.avg_score.toFixed(2)}`);
  }

  // Evolution iterations
  for (let i = 0; i < EVOLVE_STEPS; i++) {
    console.log(`\n\x1b[35m=== EVOLUTION STEP ${i + 1}/${EVOLVE_STEPS} ===\x1b[0m`);

    // Pick worst-scoring traces (up to 5)
    const sorted = [...bestTraces]
      .filter((t) => t.score !== undefined)
      .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
    const failedTraces = sorted.slice(0, 5);

    if (failedTraces.length === 0) {
      console.log("No scored traces to analyze. Skipping.");
      continue;
    }

    const currentPrompt = loadPromptVersion(bestVersion, HINT);
    const currentTokens = estimateTokens(currentPrompt);
    const newVer = nextVersion(getLatestVersion());
    const metaVer = META_PROMPT_VERSION ?? getLatestMetaVersion();

    const metaOpts = {
      metaPromptVersion: metaVer,
      experimentHistory: formatExperimentHistory(manifest),
      focusDirective: deriveFocusDirective(manifest),
      promptTokens: currentTokens,
    };

    console.log(`Running meta-agent to propose v${newVer} (meta-prompt v${metaVer}, ${currentTokens}tk)...`);
    let metaResult: { newPrompt: string; reasoning: string };
    try {
      metaResult = await runMetaAgent(
        META_MODEL_ID,
        currentPrompt,
        bestVersion,
        bestSummary!,
        failedTraces,
        metaOpts,
      );
    } catch (err) {
      console.error(`\x1b[31mMeta-agent failed: ${err}\x1b[0m`);
      manifest.history.push({
        version: newVer,
        avg_score: 0,
        reasoning: `Meta-agent error: ${err}`,
        accepted: false,
        timestamp: new Date().toISOString(),
        meta_prompt_version: metaVer,
      });
      saveManifest(manifest);
      continue;
    }

    console.log(`\x1b[33mReasoning:\x1b[0m ${metaResult.reasoning.slice(0, 300)}...`);

    // Validate the proposed prompt
    let validation = validatePrompt(metaResult.newPrompt);
    if (!validation.valid) {
      console.log(`\x1b[33mValidation failed (${validation.violations.length} issues), retrying...\x1b[0m`);
      for (const v of validation.violations) console.log(`  - ${v}`);

      // One retry with violation feedback — append violations to the failed traces context
      try {
        const patchedTraces: TaskTrace[] = [{
          task_id: "__validation__",
          prompt_version: bestVersion,
          model: META_MODEL_ID,
          instruction: `VALIDATION ERRORS in your previous proposal:\n${validation.violations.join("\n")}\n\nFix these and keep all required concepts and tool definitions.`,
          steps: [],
          score_detail: validation.violations,
          total_elapsed_ms: 0,
          total_steps: 0,
          score: 0,
        }, ...failedTraces];
        const retryResponse = await runMetaAgent(
          META_MODEL_ID,
          metaResult.newPrompt,
          bestVersion,
          bestSummary!,
          patchedTraces,
          metaOpts,
        );
        metaResult = retryResponse;
        validation = validatePrompt(metaResult.newPrompt);
      } catch {
        // Retry failed
      }

      if (!validation.valid) {
        console.log(`\x1b[31mValidation still failed after retry. Rejecting v${newVer}.\x1b[0m`);
        manifest.history.push({
          version: newVer,
          avg_score: 0,
          reasoning: `Validation failed: ${validation.violations.join("; ")}`,
          accepted: false,
          timestamp: new Date().toISOString(),
        });
        saveManifest(manifest);
        continue;
      }
    }

    // Save and eval new version
    savePromptVersion(newVer, metaResult.newPrompt);
    console.log(`Saved prompt v${newVer}, running eval...`);

    const evalResult = await runEval(newVer, EVOLVE_TASKS.length > 0 ? EVOLVE_TASKS : undefined);
    const newAvg = evalResult.summary.avg_score;
    const bestAvg = bestSummary!.avg_score;
    const newPromptText = loadPromptVersion(newVer);
    const bestPromptText = loadPromptVersion(bestVersion);
    const newTokens = estimateTokens(newPromptText);
    const bestTokens = estimateTokens(bestPromptText);
    const newEffective = effectiveScore(newAvg, newPromptText);
    const bestEffective = effectiveScore(bestAvg, bestPromptText);

    console.log(`  New:  avg=${newAvg.toFixed(2)} eff=${newEffective.toFixed(3)} tokens=${newTokens}`);
    console.log(`  Best: avg=${bestAvg.toFixed(2)} eff=${bestEffective.toFixed(3)} tokens=${bestTokens}`);

    // Primary gate: effective score improvement
    const effectiveImprovement = newEffective - bestEffective;
    // Secondary gate: shorter at parity
    const shorterAtParity = Math.abs(newAvg - bestAvg) < 0.01 && newTokens < bestTokens * 0.9;
    const accepted = effectiveImprovement >= IMPROVEMENT_THRESHOLD || shorterAtParity;

    if (accepted) {
      const reason = shorterAtParity && effectiveImprovement < IMPROVEMENT_THRESHOLD
        ? "shorter at parity"
        : `+${effectiveImprovement.toFixed(3)} effective`;
      console.log(
        `\x1b[32m✓ v${newVer} accepted (${reason}): ${bestAvg.toFixed(2)} → ${newAvg.toFixed(2)}\x1b[0m`,
      );
      bestVersion = newVer;
      bestSummary = evalResult.summary;
      bestTraces = evalResult.traces;
      manifest.best_version = newVer;
      manifest.history.push({
        version: newVer,
        avg_score: newAvg,
        reasoning: metaResult.reasoning,
        accepted: true,
        timestamp: evalResult.summary.timestamp,
        prompt_tokens: newTokens,
        meta_prompt_version: metaVer,
      });
    } else {
      console.log(
        `\x1b[33m✗ v${newVer} rejected (eff ${newEffective.toFixed(3)} vs ${bestEffective.toFixed(3)}), reverting\x1b[0m`,
      );
      manifest.history.push({
        version: newVer,
        avg_score: newAvg,
        reasoning: metaResult.reasoning,
        accepted: false,
        timestamp: evalResult.summary.timestamp,
        prompt_tokens: newTokens,
        meta_prompt_version: metaVer,
      });
    }

    saveManifest(manifest);
  }

  // Final summary
  console.log(`\n\x1b[35m=== EVOLUTION COMPLETE ===\x1b[0m`);
  console.log(`Best version: v${manifest.best_version} (avg: ${bestSummary!.avg_score.toFixed(2)})`);
  console.log(`\nHistory:`);
  for (const entry of manifest.history) {
    const marker = entry.accepted ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const tokens = entry.prompt_tokens ? ` (${entry.prompt_tokens}tk)` : "";
    console.log(`  ${marker} v${entry.version}: ${entry.avg_score.toFixed(2)}${tokens}`);
  }
}

process.on("SIGINT", () => {
  console.log("\n\x1b[33mInterrupted\x1b[0m");
  process.exit(130);
});

evolve().catch((err) => {
  console.error(err);
  process.exit(1);
});
