# Agent Architecture Blueprint

## Overview

The agent is a **loop-based autonomous system** that:
1. Receives a task instruction (natural language)
2. Explores a virtual file-system vault (Obsidian-like)
3. Reads, writes, searches, and modifies files to complete the task
4. Submits a final answer with an outcome classification and grounding references

Two separate models are used:
- **Claude Opus** — builds the agent code itself
- **Claude Haiku** — runs inside the agent loop at runtime (fast, cheap, many calls)

---

## Control Flow

```
┌─────────────────────────────────────────────────┐
│                 HARNESS (control plane)          │
│                 api.bitgn.com                    │
│                                                  │
│  1. GetBenchmark(benchmark_id)                   │
│     → task list, eval policy                     │
│                                                  │
│  2. StartRun(benchmark_id, name)                 │
│     → run_id, trial_ids[]                        │
│                                                  │
│  3. For each trial_id:                           │
│     a. StartTrial(trial_id)                      │
│        → instruction, harness_url                │
│     b. ──── AGENT LOOP (see below) ────          │
│     c. EndTrial(trial_id)                        │
│        → score (if open benchmark)               │
│                                                  │
│  4. SubmitRun(run_id)                            │
│     → Hall of Fame submission                    │
└─────────────────────────────────────────────────┘
```

## Agent Loop (per trial)

```
Input: instruction (string), harness_url (string)

1. BOOT SEQUENCE (mandatory first steps):
   a. tree()              → understand vault structure
   b. read("AGENTS.md")   → read agent-specific instructions/policies
   c. context()           → get current simulated time

2. LOOP (max ~30 iterations, ~1000 API calls total):
   a. Build conversation: system prompt + history of (tool calls + results)
   b. Call LLM (Haiku) with structured output → NextStep
   c. NextStep contains:
      - plan: string        (reasoning / what to do next)
      - action: one tool call (read | write | delete | search | find |
                               list | tree | move | mkdir | context | answer)
   d. Dispatch action to PCM Runtime
   e. Format result as human-readable text
   f. Append (action + result) to conversation history
   g. If action was Answer → EXIT LOOP

3. If loop exhausted without Answer → force Answer with ERR_INTERNAL
```

## Schema-Guided Reasoning (SGR)

The key technique for structured agent output. Instead of free-form text, the LLM produces a typed object every step.

### NextStep Schema (Zod)

```typescript
import { z } from "zod";

// Individual tool call schemas
const ReadAction = z.object({
  tool: z.literal("read"),
  path: z.string(),
  number: z.boolean().optional().default(false),
  start_line: z.number().optional(),
  end_line: z.number().optional(),
});

const WriteAction = z.object({
  tool: z.literal("write"),
  path: z.string(),
  content: z.string(),
  start_line: z.number().optional(),
  end_line: z.number().optional(),
});

const DeleteAction = z.object({
  tool: z.literal("delete"),
  path: z.string(),
});

const MkDirAction = z.object({
  tool: z.literal("mkdir"),
  path: z.string(),
});

const MoveAction = z.object({
  tool: z.literal("move"),
  from: z.string(),
  to: z.string(),
});

const ListAction = z.object({
  tool: z.literal("list"),
  path: z.string(),
});

const TreeAction = z.object({
  tool: z.literal("tree"),
  root: z.string().optional().default(""),
  level: z.number().optional(),
});

const FindAction = z.object({
  tool: z.literal("find"),
  root: z.string().optional().default(""),
  name: z.string(),
  type: z.enum(["all", "files", "dirs"]).optional().default("all"),
  limit: z.number().optional(),
});

const SearchAction = z.object({
  tool: z.literal("search"),
  root: z.string().optional().default(""),
  pattern: z.string(),
  limit: z.number().optional(),
});

const ContextAction = z.object({
  tool: z.literal("context"),
});

const AnswerAction = z.object({
  tool: z.literal("answer"),
  message: z.string(),
  outcome: z.enum(["ok", "denied_security", "none_clarification",
                    "none_unsupported", "err_internal"]),
  refs: z.array(z.string()).optional().default([]),
});

// The top-level structured output
const NextStep = z.object({
  plan: z.string(),           // reasoning about what to do and why
  action: z.discriminatedUnion("tool", [
    ReadAction, WriteAction, DeleteAction, MkDirAction,
    MoveAction, ListAction, TreeAction, FindAction,
    SearchAction, ContextAction, AnswerAction,
  ]),
});
```

### Why SGR Matters
- Forces step-by-step reasoning before acting
- Makes every decision auditable
- Prevents hallucinated tool calls (schema validation catches errors)
- 5-10% accuracy improvement over free-form prompting
- Especially effective for smaller models like Haiku

---

## Conversation History Format

Each turn in the conversation history:

```typescript
type Message =
  | { role: "system"; content: string }      // system prompt (once)
  | { role: "user"; content: string }        // task instruction + tool results
  | { role: "assistant"; content: string }   // LLM's NextStep (serialized)
```

### Boot sequence messages:
```
system:  [system prompt with tools, rules, safety]
user:    "Task: {instruction}"
user:    "Vault structure:\n{tree output}"
user:    "Agent policies:\n{AGENTS.md content}"
user:    "Current time: {context.time}"
```

### Subsequent turns:
```
assistant: { plan: "...", action: { tool: "read", path: "..." } }
user:      "Result of read('notes/todo.md'):\n{file content}"
assistant: { plan: "...", action: { tool: "write", path: "...", content: "..." } }
user:      "Result of write('notes/todo.md'): OK"
...
assistant: { plan: "...", action: { tool: "answer", message: "...", outcome: "ok", refs: [...] } }
```

---

## Tool Result Formatting

Format tool outputs as shell-like text for the LLM:

| Tool | Format |
|------|--------|
| `tree` | ASCII tree with `├──` / `└──` branches |
| `list` | One entry per line, dirs suffixed with `/` |
| `read` | File content, optionally with `cat -n` style line numbers |
| `write` | `"OK"` or error message |
| `delete` | `"OK"` or error message |
| `mkdir` | `"OK"` or error message |
| `move` | `"OK"` or error message |
| `find` | One path per line |
| `search` | `path:line:text` format (like grep) |
| `context` | RFC 3339 time string |
| `answer` | N/A (terminates loop) |

---

## TypeScript Project Setup

### Dependencies

```json
{
  "dependencies": {
    "@buf/bitgn_api.bufbuild_es": "latest",
    "@buf/bitgn_api.connectrpc_es": "latest",
    "@connectrpc/connect": "^2.1.1",
    "@connectrpc/connect-node": "^2.1.1",
    "@bufbuild/protobuf": "^2.11.0",
    "openai": "^4.0.0",
    "zod": "^3.23.0"
  }
}
```

### Key Design Decisions

1. **Use OpenAI-compatible API** for Haiku calls (Anthropic API with structured output, or OpenAI-compatible endpoint)
2. **Zod schemas** for structured output validation (not Pydantic — this is TypeScript)
3. **ConnectRPC client** for both Harness and PCM Runtime communication
4. **Stateless agent loop** — all state is in conversation history array
5. **Result formatting functions** — convert protobuf responses to readable text
6. **Timeout/retry logic** — handle transient API errors gracefully
7. **Step counter** — hard limit to prevent runaway loops
