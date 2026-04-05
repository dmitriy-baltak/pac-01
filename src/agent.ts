import { ConnectError } from "@connectrpc/connect";
import {
  Outcome,
  FindRequest_Type,
} from "@buf/bitgn_api.bufbuild_es/bitgn/vm/pcm_pb.js";
import { createRuntimeClient, type RuntimeClient } from "./runtime.js";
import { NextStep, type ToolAction } from "./schemas.js";
import { formatResult } from "./format.js";
import { buildSystemPrompt } from "./prompt.js";
import { callLLM, type LLMResponse, type ChatMessage } from "./llm.js";
import type { TraceCollector } from "./trace.js";

const MAX_STEPS = 30;

const OUTCOME_MAP: Record<string, Outcome> = {
  ok: Outcome.OK,
  denied_security: Outcome.DENIED_SECURITY,
  none_clarification: Outcome.NONE_CLARIFICATION,
  none_unsupported: Outcome.NONE_UNSUPPORTED,
  err_internal: Outcome.ERR_INTERNAL,
};

const FIND_TYPE_MAP: Record<string, FindRequest_Type> = {
  all: FindRequest_Type.ALL,
  files: FindRequest_Type.FILES,
  dirs: FindRequest_Type.DIRS,
};

async function dispatch(
  vm: RuntimeClient,
  cmd: ToolAction,
): Promise<unknown> {
  switch (cmd.tool) {
    case "tree":
      return vm.tree({ root: cmd.root, level: cmd.level });
    case "list":
      return vm.list({ name: cmd.path });
    case "read":
      return vm.read({
        path: cmd.path,
        number: cmd.number,
        startLine: cmd.start_line ?? 0,
        endLine: cmd.end_line ?? 0,
      });
    case "write":
      return vm.write({
        path: cmd.path,
        content: cmd.content,
        startLine: cmd.start_line ?? 0,
        endLine: cmd.end_line ?? 0,
      });
    case "delete":
      return vm.delete({ path: cmd.path });
    case "mkdir":
      return vm.mkDir({ path: cmd.path });
    case "move":
      return vm.move({ fromName: cmd.from, toName: cmd.to });
    case "find":
      return vm.find({
        root: cmd.root,
        name: cmd.name,
        type: FIND_TYPE_MAP[cmd.type] ?? FindRequest_Type.ALL,
        limit: cmd.limit,
      });
    case "search":
      return vm.search({
        root: cmd.root,
        pattern: cmd.pattern,
        limit: cmd.limit,
      });
    case "context":
      return vm.context({});
    case "answer":
      return vm.answer({
        message: cmd.message,
        outcome: OUTCOME_MAP[cmd.outcome] ?? Outcome.OK,
        refs: cmd.refs,
      });
  }
}

function buildCompletedActionsSummary(
  history: { role: string; content: string }[],
): string {
  const actions: string[] = [];
  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== "assistant") continue;
    try {
      const parsed = JSON.parse(history[i].content);
      const action = parsed.action;
      if (!action?.tool) continue;
      const resultMsg = i + 1 < history.length && history[i + 1].role === "user"
        ? history[i + 1].content.slice(0, 80)
        : "no result";
      const param = action.tool === "read" || action.tool === "list" || action.tool === "delete"
        ? action.path
        : action.tool === "write"
          ? action.path
          : action.tool === "move"
            ? `${action.from} -> ${action.to}`
            : action.tool === "find"
              ? `name=${action.name}`
              : action.tool === "search"
                ? `pattern=${action.pattern}`
                : "";
      actions.push(`${actions.length + 1}. ${action.tool} ${param} -> ${resultMsg}`);
    } catch {
      // Skip unparseable assistant messages
    }
  }
  return actions.length > 0 ? actions.join("\n") : "(none yet)";
}

export interface AgentOptions {
  systemPrompt?: string;
  trace?: TraceCollector;
}

export async function runAgent(
  model: string,
  harnessUrl: string,
  taskText: string,
  hint?: string,
  opts?: AgentOptions,
): Promise<void> {
  const vm = createRuntimeClient(harnessUrl);
  const systemPrompt = opts?.systemPrompt ?? buildSystemPrompt(hint);

  const history: { role: string; content: string }[] = [];

  // Boot sequence: tree, read AGENTS.md, context
  const bootOps: ToolAction[] = [
    { tool: "tree", root: "", level: 2 },
    { tool: "read", path: "AGENTS.md", number: false },
    { tool: "context" },
  ];

  const bootResults: string[] = [];
  for (const op of bootOps) {
    try {
      const result = await dispatch(vm, op);
      const txt = formatResult(op, result);
      bootResults.push(txt);
      console.log(`\x1b[32mBOOT\x1b[0m [${op.tool}]: ${txt.slice(0, 120)}...`);
    } catch (err) {
      const msg = err instanceof ConnectError ? err.message : String(err);
      bootResults.push(`Error: ${msg}`);
      console.log(`\x1b[33mBOOT\x1b[0m [${op.tool}]: Error: ${msg}`);
    }
  }

  // Seed conversation with boot results then task
  history.push({
    role: "user",
    content: `Vault structure:\n${bootResults[0]}\n\nAgent policies:\n${bootResults[1]}\n\nContext:\n${bootResults[2]}\n\n---\nTASK:\n${taskText}`,
  });

  // Agent loop
  let consecutiveParseErrors = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    const started = Date.now();
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    let response: LLMResponse;
    try {
      response = await callLLM(model, messages, { format: "json" });
    } catch (err) {
      console.log(`\x1b[31mERR\x1b[0m: LLM call failed: ${err}`);
      if (opts?.trace) opts.trace.setError(`LLM call failed: ${err}`);
      break;
    }
    const elapsed = Date.now() - started;

    // Parse JSON from result text (Zod validates schema compliance)
    let raw: unknown;
    try {
      let text = response.result ?? "";
      const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenceMatch) text = fenceMatch[1];
      raw = JSON.parse(text.trim());
    } catch {
      consecutiveParseErrors++;
      const _raw = response.result ?? "";
      const _hasFence = /```/.test(_raw);
      console.log(
        `\x1b[31mERR\x1b[0m: Failed to parse JSON (step ${step + 1}, attempt ${consecutiveParseErrors}):` +
        `\n  stop_reason=${response.stop_reason} | length=${_raw.length} | has_fence=${_hasFence}` +
        `\n  first300=${_raw.slice(0, 300)}` +
        `\n  last200=${_raw.slice(-200)}`,
      );
      if (opts?.trace) {
        opts.trace.addStep({
          step: step + 1, tool: "parse_error", params: {},
          result_preview: "", elapsed_ms: elapsed,
          parse_error: "Response was not valid JSON",
        });
      }

      // Bail after 3 consecutive parse failures
      if (consecutiveParseErrors >= 3) {
        console.log(`\x1b[31mERR\x1b[0m: ${consecutiveParseErrors} consecutive parse errors, forcing answer`);
        if (opts?.trace) opts.trace.setError("Too many consecutive parse errors");
        await vm.answer({
          message: "Agent encountered repeated JSON parse errors.",
          outcome: Outcome.ERR_INTERNAL,
          refs: [],
        });
        return;
      }

      // Do NOT add the broken response to history — the model would see
      // its own truncated action and think it already ran.
      const completedSummary = buildCompletedActionsSummary(history);
      const wasTruncated = response.stop_reason === "max_tokens";
      const causeText = wasTruncated ? "truncated (hit output limit)" : "not valid JSON";

      history.push({
        role: "user",
        content: `Error: your previous response was ${causeText}. No action was executed from it.\n\nActions completed so far:\n${completedSummary}\n\nRespond with ONLY a valid JSON object. Keep current_state and plan_remaining_steps_brief very brief to avoid truncation.`,
      });
      continue;
    }

    // Handle null action when model thinks task is complete
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).action == null && (raw as Record<string, unknown>).task_completed === true) {
      (raw as Record<string, unknown>).action = {
        tool: "answer",
        message: (raw as Record<string, unknown>).current_state ?? "Task completed.",
        outcome: "ok",
        refs: [],
      };
    }

    const parsed = NextStep.safeParse(raw);
    if (!parsed.success) {
      consecutiveParseErrors++;
      console.log(
        `\x1b[31mERR\x1b[0m: Zod validation failed (step ${step + 1}, attempt ${consecutiveParseErrors}): ${parsed.error.message}`,
      );
      if (opts?.trace) {
        opts.trace.addStep({
          step: step + 1, tool: "parse_error", params: {},
          result_preview: "", elapsed_ms: elapsed,
          parse_error: `Zod: ${parsed.error.message}`,
        });
      }

      if (consecutiveParseErrors >= 3) {
        console.log(`\x1b[31mERR\x1b[0m: ${consecutiveParseErrors} consecutive parse errors, forcing answer`);
        if (opts?.trace) opts.trace.setError("Too many consecutive parse errors");
        await vm.answer({
          message: "Agent encountered repeated schema validation errors.",
          outcome: Outcome.ERR_INTERNAL,
          refs: [],
        });
        return;
      }

      const completedSummary = buildCompletedActionsSummary(history);
      history.push({
        role: "user",
        content: `Error: your response didn't match the required schema. No action was executed.\n\nActions completed so far:\n${completedSummary}\n\nRespond with ONLY a valid JSON object matching the schema.`,
      });
      continue;
    }

    consecutiveParseErrors = 0;

    const job = parsed.data;
    const planPreview = job.plan_remaining_steps_brief[0] ?? "";
    console.log(
      `\x1b[36mSTEP ${step + 1}\x1b[0m [${job.action.tool}] ${planPreview} (${elapsed}ms)`,
    );

    // Add assistant response to conversation
    history.push({ role: "assistant", content: JSON.stringify(raw) });

    // Dispatch tool call
    const dispatchStart = Date.now();
    try {
      const result = await dispatch(vm, job.action);
      const txt = formatResult(job.action, result);

      if (opts?.trace) {
        const { tool, ...params } = job.action;
        opts.trace.addStep({
          step: step + 1, tool,
          params: params as Record<string, unknown>,
          result_preview: txt.slice(0, 500),
          elapsed_ms: Date.now() - dispatchStart,
        });
      }

      if (txt) {
        console.log(
          `\x1b[32mOUT\x1b[0m: ${txt.slice(0, 200)}${txt.length > 200 ? "..." : ""}`,
        );
        history.push({ role: "user", content: txt });
      }

      // Check completion
      if (job.action.tool === "answer") {
        console.log(
          `\x1b[32mDONE\x1b[0m: outcome=${job.action.outcome} message="${job.action.message}" refs=[${job.action.refs.join(", ")}]`,
        );
        console.log(`\x1b[32mDONE\x1b[0m: answer dispatch result: ${JSON.stringify(result)}`);
        if (opts?.trace) opts.trace.setOutcome(job.action.outcome, job.action.message, job.action.refs);
        return;
      }
    } catch (err) {
      const errMsg =
        err instanceof ConnectError ? `${err.code}: ${err.message}` : String(err);
      console.log(`\x1b[31mERR\x1b[0m: ${errMsg}`);

      if (opts?.trace) {
        const { tool, ...params } = job.action;
        opts.trace.addStep({
          step: step + 1, tool,
          params: params as Record<string, unknown>,
          result_preview: "", elapsed_ms: Date.now() - dispatchStart,
          error: errMsg,
        });
      }

      // If answer dispatch failed, still exit the loop
      if (job.action.tool === "answer") {
        console.log(`\x1b[31mERR\x1b[0m: Answer submission failed!`);
        return;
      }
      history.push({ role: "user", content: `Error: ${errMsg}` });
    }
  }

  // Exhausted steps — force answer
  console.log(`\x1b[33mWARN\x1b[0m: Exhausted ${MAX_STEPS} steps, forcing answer`);
  if (opts?.trace) opts.trace.setError("Exhausted step limit");
  await vm.answer({
    message: "Agent reached step limit without completing the task.",
    outcome: Outcome.ERR_INTERNAL,
    refs: [],
  });
}
