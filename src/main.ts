import { ConnectError } from "@connectrpc/connect";
import { createHarnessClient } from "./harness.js";
import { runAgent } from "./agent.js";

const BITGN_API_KEY = process.env.BITGN_API_KEY ?? "";
const BENCHMARK_HOST =
  process.env.BENCHMARK_HOST ?? "https://api.bitgn.com";
const BENCHMARK_ID = process.env.BENCHMARK_ID ?? "bitgn/pac1-dev";
const MODEL_ID = process.env.MODEL_ID ?? "claude-haiku-4-5-20251001";
const HINT = process.env.HINT;

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

  console.log(`Running ${tasks.length} task(s) with model ${MODEL_ID}\n`);

  const scores: { taskId: string; score?: number }[] = [];

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
      await runAgent(MODEL_ID, trial.harnessUrl, trial.instruction, HINT);

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
    } catch (err) {
      if (err instanceof ConnectError) {
        console.error(`\x1b[31mError: ${err.code} — ${err.message}\x1b[0m`);
      } else {
        console.error(`\x1b[31mError: ${err}\x1b[0m`);
      }
      scores.push({ taskId: task.taskId, score: undefined });
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(60)}`);
  const scored = scores.filter((s) => s.score !== undefined);
  for (const s of scores) {
    const val =
      s.score !== undefined ? s.score.toFixed(2) : "—";
    console.log(`  ${s.taskId}: ${val}`);
  }
  if (scored.length > 0) {
    const avg =
      scored.reduce((sum, s) => sum + (s.score ?? 0), 0) / scored.length;
    console.log(`\n  Average: ${avg.toFixed(2)} (${scored.length}/${scores.length} scored)`);
  }
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
