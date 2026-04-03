import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { ConnectError } from "@connectrpc/connect";
import {
  Outcome,
  FindRequest_Type,
} from "@buf/bitgn_api.bufbuild_es/bitgn/vm/pcm_pb.js";
import { createRuntimeClient, type RuntimeClient } from "./runtime.js";
import { NextStep, type ToolAction } from "./schemas.js";
import { formatResult } from "./format.js";
import { buildSystemPrompt } from "./prompt.js";

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

export async function runAgent(
  model: string,
  harnessUrl: string,
  taskText: string,
  hint?: string,
): Promise<void> {
  const anthropic = new Anthropic();
  const vm = createRuntimeClient(harnessUrl);
  const systemPrompt = buildSystemPrompt(hint);

  const messages: Anthropic.MessageParam[] = [];

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
      const msg =
        err instanceof ConnectError ? err.message : String(err);
      bootResults.push(`Error: ${msg}`);
      console.log(`\x1b[33mBOOT\x1b[0m [${op.tool}]: Error: ${msg}`);
    }
  }

  // Seed conversation with boot results then task
  messages.push({
    role: "user",
    content: `Vault structure:\n${bootResults[0]}\n\nAgent policies:\n${bootResults[1]}\n\nContext:\n${bootResults[2]}\n\n---\nTASK:\n${taskText}`,
  });

  // Agent loop
  for (let step = 0; step < MAX_STEPS; step++) {
    const started = Date.now();
    const response = await anthropic.messages.parse({
      model,
      max_tokens: 16384,
      system: systemPrompt,
      messages,
      output_config: {
        format: zodOutputFormat(NextStep),
      },
    });
    const elapsed = Date.now() - started;

    const job = response.parsed_output;
    if (!job) {
      console.log(
        `\x1b[31mERR\x1b[0m: Failed to parse structured output (step ${step + 1})`,
      );
      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: "Error: failed to parse your response. Please try again with valid JSON matching the schema.",
      });
      continue;
    }

    const planPreview = job.plan_remaining_steps_brief[0] ?? "";
    console.log(
      `\x1b[36mSTEP ${step + 1}\x1b[0m [${job.action.tool}] ${planPreview} (${elapsed}ms)`,
    );

    // Add assistant response to conversation
    messages.push({ role: "assistant", content: response.content });

    // Dispatch tool call
    try {
      const result = await dispatch(vm, job.action);
      const txt = formatResult(job.action, result);
      if (txt) {
        console.log(`\x1b[32mOUT\x1b[0m: ${txt.slice(0, 200)}${txt.length > 200 ? "..." : ""}`);
        messages.push({ role: "user", content: txt });
      }
    } catch (err) {
      const errMsg =
        err instanceof ConnectError ? `${err.code}: ${err.message}` : String(err);
      console.log(`\x1b[31mERR\x1b[0m: ${errMsg}`);
      messages.push({ role: "user", content: `Error: ${errMsg}` });
    }

    // Check completion
    if (job.action.tool === "answer") {
      console.log(
        `\x1b[32mDONE\x1b[0m: outcome=${job.action.outcome} refs=[${job.action.refs.join(", ")}]`,
      );
      return;
    }
  }

  // Exhausted steps — force answer
  console.log(`\x1b[33mWARN\x1b[0m: Exhausted ${MAX_STEPS} steps, forcing answer`);
  await vm.answer({
    message: "Agent reached step limit without completing the task.",
    outcome: Outcome.ERR_INTERNAL,
    refs: [],
  });
}
