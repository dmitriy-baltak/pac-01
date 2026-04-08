import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConnectError } from "@connectrpc/connect";
import { createHarnessClient } from "./harness.js";
import { runAgent } from "./agent.js";
import { loadPromptVersion, getLatestVersion } from "./prompt.js";
import { TraceCollector } from "./trace.js";

interface EvalSummary {
  version: string;
  avg_score: number;
  task_scores: { task_id: string; score: number }[];
  n_tasks: number;
  timestamp: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "../data/evolve");

const BITGN_API_KEY = process.env.BITGN_API_KEY ?? "";
const BENCHMARK_HOST =
  process.env.BENCHMARK_HOST ?? "https://api.bitgn.com";
const BENCHMARK_ID = process.env.BENCHMARK_ID ?? "bitgn/pac1-dev";
const MODEL_ID = process.env.MODEL_ID ?? "gpt-4o-mini";
const HINT = process.env.HINT;
const PROMPT_VERSION = process.env.PROMPT_VERSION ?? getLatestVersion();

async function main() {
  if (!BITGN_API_KEY) {
    console.error("BITGN_API_KEY is required. Set it in your environment.");
    process.exit(1);
  }

  const harness = createHarnessClient(BENCHMARK_HOST, BITGN_API_KEY);

  // Verify connection
  const status = await harness.status({});
  console.log(`Connected to BitGN: ${status.status} (${status.version})`);

  // Get benchmark info
  const benchmark = await harness.getBenchmark({
    benchmarkId: BENCHMARK_ID,
  });
  console.log(
    `Benchmark: ${benchmark.benchmarkId} — ${benchmark.tasks.length} tasks (policy: ${benchmark.policy})`,
  );

  // Filter tasks by CLI args
  const filterIds = process.argv.slice(2);
  const tasks =
    filterIds.length > 0
      ? benchmark.tasks.filter((t) => filterIds.includes(t.taskId))
      : benchmark.tasks;

  if (tasks.length === 0) {
    console.log("No tasks to run.");
    return;
  }

  console.log(`Using prompt: v${PROMPT_VERSION}`);
  console.log(`Running ${tasks.length} task(s) with model ${MODEL_ID}\n`);

  const systemPrompt = loadPromptVersion(PROMPT_VERSION, HINT);
  const scores: { taskId: string; score?: number }[] = [];
  const traces: ReturnType<TraceCollector["finalize"]>[] = [];

  for (const task of tasks) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Task: ${task.taskId}`);
    console.log(`${"=".repeat(60)}`);

    try {
      // Start playground trial
      const trial = await harness.startPlayground({
        benchmarkId: BENCHMARK_ID,
        taskId: task.taskId,
      });

      console.log(`Trial: ${trial.trialId} (runtime: ${trial.harnessUrl})`);
      console.log(`Instruction: ${trial.instruction.slice(0, 200)}...`);
      console.log();

      // Run agent
      const trace = new TraceCollector(task.taskId, PROMPT_VERSION, MODEL_ID, trial.instruction);
      await runAgent(MODEL_ID, trial.harnessUrl, trial.instruction, HINT, {
        systemPrompt,
        trace,
      });

      // End trial and get score
      const result = await harness.endTrial({ trialId: trial.trialId });
      const score = result.score;
      scores.push({ taskId: task.taskId, score });

      if (score !== undefined) {
        const color = score >= 0.8 ? "\x1b[32m" : score >= 0.5 ? "\x1b[33m" : "\x1b[31m";
        console.log(`\n${color}Score: ${score.toFixed(2)}\x1b[0m`);
      } else {
        console.log("\nScore: (pending — blind benchmark)");
      }

      if (result.scoreDetail.length > 0) {
        for (const detail of result.scoreDetail) {
          console.log(`  ${detail}`);
        }
      }

      if (score !== undefined) trace.setScore(score, [...result.scoreDetail]);
      const finalized = trace.finalize();
      trace.save();
      traces.push(finalized);
      console.log(`  Trace: ${finalized.total_steps} steps, ${finalized.total_elapsed_ms}ms total`);
    } catch (err) {
      if (err instanceof ConnectError) {
        console.error(`\x1b[31mError: ${err.code} — ${err.message}\x1b[0m`);
      } else {
        console.error(`\x1b[31mError: ${err}\x1b[0m`);
      }

      const errorTrace = new TraceCollector(task.taskId, PROMPT_VERSION, MODEL_ID, "(error)");
      errorTrace.setError(err instanceof ConnectError ? `${err.code}: ${err.message}` : String(err));
      traces.push(errorTrace.finalize());
      scores.push({ taskId: task.taskId, score: undefined });
    }
  }

  // Save summary in evolve-compatible format
  const taskScores = scores.map((s) => ({
    task_id: s.taskId,
    score: s.score ?? 0,
  }));
  const avg = taskScores.length > 0
    ? taskScores.reduce((sum, t) => sum + t.score, 0) / taskScores.length
    : 0;
  const summary: EvalSummary = {
    version: PROMPT_VERSION,
    avg_score: avg,
    task_scores: taskScores,
    n_tasks: taskScores.length,
    timestamp: new Date().toISOString(),
  };
  const versionDir = join(DATA_DIR, `v${PROMPT_VERSION}`);
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(join(versionDir, "summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  // Console summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(60)}`);
  for (const s of scores) {
    const val =
      s.score !== undefined ? s.score.toFixed(2) : "—";
    console.log(`  ${s.taskId}: ${val}`);
  }
  const scored = scores.filter((s) => s.score !== undefined);
  if (scored.length > 0) {
    console.log(`\n  Average: ${avg.toFixed(2)} (${scored.length}/${scores.length} scored)`);
  }
  console.log(`\n  Results saved to ${versionDir}`);
}

// Handle SIGINT
process.on("SIGINT", () => {
  console.log("\n\x1b[33mInterrupted\x1b[0m");
  process.exit(130);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
