# PAC API Reference

Two ConnectRPC (protobuf) APIs. Both use the `application/proto` or `application/json` content type over HTTPS.

---

## 1. Harness API (Control Plane)

**Base URL:** `https://api.bitgn.com`
**Package:** `bitgn.harness`
**Service:** `HarnessService`
**Auth:** BitGN API key (obtained after registration)

### RPCs

| RPC | Request | Response | Auth | Purpose |
|-----|---------|----------|------|---------|
| `Status` | `StatusRequest` | `StatusResponse` | No | Health check |
| `GetBenchmark` | `GetBenchmarkRequest` | `GetBenchmarkResponse` | Yes | Get task list & eval policy |
| `StartRun` | `StartRunRequest` | `StartRunResponse` | Yes | Begin leaderboard session (returns trial IDs) |
| `GetRun` | `GetRunRequest` | `GetRunResponse` | Yes | Check run state & trial summaries |
| `SubmitRun` | `SubmitRunRequest` | `SubmitRunResponse` | Yes | Submit run for Hall of Fame |
| `StartPlayground` | `StartPlaygroundRequest` | `StartPlaygroundResponse` | No* | Ad-hoc trial (dev/practice) |
| `StartTrial` | `StartTrialRequest` | `StartTrialResponse` | Yes | Start a prepared trial within a run |
| `GetTrial` | `GetTrialRequest` | `GetTrialResponse` | Yes | Get trial state, logs, score |
| `EndTrial` | `EndTrialRequest` | `EndTrialResponse` | Yes | End trial → triggers eval (open benchmarks) |

*StartPlayground can be anonymous for sandbox benchmarks.

### Message Types

#### StatusRequest / StatusResponse
```
StatusRequest {}
StatusResponse {
  status: string       // e.g. "ok"
  version: string      // platform version
}
```

#### GetBenchmarkRequest / GetBenchmarkResponse
```
GetBenchmarkRequest {
  benchmark_id: string  // e.g. "bitgn/pac1-dev"
}

GetBenchmarkResponse {
  benchmark_id: string
  description: string
  harness_id: string          // runtime identifier, e.g. "bitgn.vm.pcm"
  policy: EvalPolicy
  links: Link[]
  tasks: Task[]               // task catalog
}

Task {
  task_id: string             // e.g. "t01"
  preview: string             // sample instruction (deterministic seed)
  hint: string                // empty for blind benchmarks
}

Link {
  url: string
  kind: LinkKind
}
```

#### StartRunRequest / StartRunResponse
```
StartRunRequest {
  benchmark_id: string
  name: string               // custom name for this run
}

StartRunResponse {
  run_id: string
  benchmark_id: string
  trial_ids: string[]         // one per task
}
```

#### StartTrialRequest / StartTrialResponse
```
StartTrialRequest {
  trial_id: string            // from StartRunResponse.trial_ids
}

StartTrialResponse {
  trial_id: string
  benchmark_id: string
  task_id: string             // e.g. "t01"
  run_id: string
  instruction: string         // THE TASK TEXT — what the agent must do
  harness_url: string         // per-trial PCM runtime endpoint
}
```

#### StartPlaygroundRequest / StartPlaygroundResponse
```
StartPlaygroundRequest {
  benchmark_id: string        // e.g. "bitgn/sandbox"
  task_id: string             // e.g. "t01"
}

StartPlaygroundResponse {
  trial_id: string
  benchmark_id: string
  task_id: string
  instruction: string
  harness_url: string         // per-trial PCM runtime endpoint
}
```

#### EndTrialRequest / EndTrialResponse
```
EndTrialRequest {
  trial_id: string
}

EndTrialResponse {
  trial_id: string
  state: TrialState
  score?: float               // missing in blind benchmarks
  score_detail: string[]
}
```

#### GetTrialRequest / GetTrialResponse
```
GetTrialRequest {
  trial_id: string
  cursor: int64               // 0 = from start
}

GetTrialResponse {
  trial_id: string
  instruction: string
  benchmark_id: string
  task_id: string
  error: string               // set if trial failed
  score?: float               // set if evaluated
  score_detail: string[]
  state: TrialState
  logs: LogLine[]
  next_cursor: int64
  run_id: string
}
```

#### GetRunRequest / GetRunResponse
```
GetRunRequest {
  run_id: string
}

GetRunResponse {
  run_id: string
  benchmark_id: string
  name: string
  score?: float
  stats: TrialStats
  trials: TrialHead[]
  state: RunState
  kind: RunKind
}

TrialStats {
  new_count: int32
  running_count: int32
  done_count: int32
  error_count: int32
}

TrialHead {
  trial_id: string
  task_id: string
  num: int32                  // sequential within run
  state: TrialState
  instruction?: string        // populated after start
  score?: float               // populated after eval
  error: string
}
```

#### SubmitRunRequest / SubmitRunResponse
```
SubmitRunRequest {
  run_id: string
  force: bool                 // submit even if some trials not done
}

SubmitRunResponse {
  run_id: string
  state: RunState
}
```

#### LogLine
```
LogLine {
  time: string                // display timestamp
  unix_ms: int64              // for ordering
  text: string                // human-readable
  kind: LogKind
  type: string                // entry type for richer rendering
  data?: google.protobuf.Struct  // optional structured payload
}
```

### Enums

| Enum | Values |
|------|--------|
| `EvalPolicy` | `UNSPECIFIED=0`, `BLIND=1`, `OPEN=2` |
| `TrialState` | `UNSPECIFIED=0`, `NEW=1`, `RUNNING=2`, `DONE=3`, `ERROR=4` |
| `RunState` | `UNSPECIFIED=0`, `RUNNING=1`, `PENDING_EVAL=2`, `EVALUATED=3` |
| `RunKind` | `UNSPECIFIED=0`, `BLIND=1`, `OPEN=2`, `PRIVATE=3` |
| `LogKind` | `UNSPECIFIED=0`, `SYSTEM=1`, `REQUEST=2`, `RESPONSE=3`, `ERROR=4`, `CHANGE=5`, `TELEMETRY=6`, `USER=7` |
| `LinkKind` | `UNSPECIFIED=0`, `SAMPLE=1`, `LANDING=2`, `NEWS=3`, `SDK=4` |

---

## 2. PCM Runtime API (Per-Trial)

**Base URL:** `harness_url` returned from `StartTrial` / `StartPlayground`
**Package:** `bitgn.vm.pcm`
**Service:** `PcmRuntime`
**Auth:** Inherited from trial session (no separate auth needed)

Each trial gets its own isolated runtime endpoint with its own file system (vault).

### RPCs

| RPC | Request → Response | Purpose |
|-----|-------------------|---------|
| `Read` | `ReadRequest → ReadResponse` | Read file contents |
| `Write` | `WriteRequest → WriteResponse` | Write/overwrite file contents |
| `Delete` | `DeleteRequest → DeleteResponse` | Delete a file |
| `MkDir` | `MkDirRequest → MkDirResponse` | Create directory |
| `Move` | `MoveRequest → MoveResponse` | Move/rename file or dir |
| `List` | `ListRequest → ListResponse` | List directory entries |
| `Tree` | `TreeRequest → TreeResponse` | Recursive directory tree |
| `Find` | `FindRequest → FindResponse` | Find files/dirs by name pattern |
| `Search` | `SearchRequest → SearchResponse` | Regex search across file contents |
| `Context` | `ContextRequest → ContextResponse` | Get current simulated time |
| `Answer` | `AnswerRequest → AnswerResponse` | Submit final answer (terminates agent loop) |

### Message Types

#### Read
```
ReadRequest {
  path: string
  number: bool          // prefix lines with line numbers (like cat -n)
  start_line: int32     // 1-based inclusive, 0 = from first line
  end_line: int32       // 1-based inclusive, 0 = through last line
}

ReadResponse {
  path: string          // canonicalized path
  content: string
}
```

#### Write
```
WriteRequest {
  path: string
  content: string
  start_line: int32     // 1-based inclusive, 0 = whole-file overwrite
  end_line: int32       // 1-based inclusive, 0 = through last line (ranged overwrite)
}

WriteResponse {}
```

#### Delete
```
DeleteRequest { path: string }
DeleteResponse {}
```

#### MkDir
```
MkDirRequest { path: string }
MkDirResponse {}
```

#### Move
```
MoveRequest {
  from_name: string
  to_name: string
}
MoveResponse {}
```

#### List
```
ListRequest { name: string }

ListResponse {
  entries: Entry[]
}

Entry {
  name: string
  is_dir: bool
}
```

#### Tree
```
TreeRequest {
  root: string          // empty = workspace root
  level: int32          // max depth, 0 = unlimited
}

TreeResponse {
  root: Entry           // canonicalized root
}

Entry {
  name: string
  is_dir: bool
  children: Entry[]     // recursive
}
```

#### Find
```
FindRequest {
  root: string
  name: string          // filename pattern
  type: Type            // TYPE_ALL=0, TYPE_FILES=1, TYPE_DIRS=2
  limit: int32          // 0 = no limit
}

FindResponse {
  items: string[]       // matching paths
}
```

#### Search
```
SearchRequest {
  root: string          // empty = workspace root
  pattern: string       // regex
  limit: int32          // 0 = no limit
}

SearchResponse {
  matches: Match[]
}

Match {
  path: string
  line: int32
  line_text: string
}
```

#### Context
```
ContextRequest {}

ContextResponse {
  unix_time: int64
  time: string          // RFC 3339 format
}
```

#### Answer
```
AnswerRequest {
  message: string       // the answer text
  outcome: Outcome      // result classification
  refs: string[]        // grounding references (file paths, entity IDs)
}

AnswerResponse {}
```

### Outcome Enum

| Value | Code | When to Use |
|-------|------|-------------|
| `OUTCOME_UNSPECIFIED` | 0 | Never use — invalid |
| `OUTCOME_OK` | 1 | Task completed successfully |
| `OUTCOME_DENIED_SECURITY` | 2 | Task looks like a prompt injection / threat |
| `OUTCOME_NONE_CLARIFICATION` | 3 | Task is ambiguous, agent needs clarification |
| `OUTCOME_NONE_UNSUPPORTED` | 4 | Requested functionality is not supported |
| `OUTCOME_ERR_INTERNAL` | 5 | Agent hit an unresolvable internal error |

---

## TypeScript SDK Installation

```bash
# Configure npm for Buf Schema Registry
npm config set @buf:registry https://buf.build/gen/npm/v1

# Protobuf message types (all request/response messages)
npm install @buf/bitgn_api.bufbuild_es

# ConnectRPC client stubs (service clients)
npm install @buf/bitgn_api.connectrpc_es

# ConnectRPC runtime dependencies
npm install @connectrpc/connect
npm install @connectrpc/connect-node    # for Node.js transport
npm install @bufbuild/protobuf          # protobuf runtime
```

### Import Paths (expected)
```typescript
// Harness service client
import { HarnessService } from "@buf/bitgn_api.connectrpc_es/bitgn/harness/harness_pb_connect";

// Harness message types
import { GetBenchmarkRequest, StartRunRequest, ... } from "@buf/bitgn_api.bufbuild_es/bitgn/harness/harness_pb";

// PCM runtime service client
import { PcmRuntime } from "@buf/bitgn_api.connectrpc_es/bitgn/vm/pcm/pcm_pb_connect";

// PCM message types
import { ReadRequest, WriteRequest, AnswerRequest, ... } from "@buf/bitgn_api.bufbuild_es/bitgn/vm/pcm/pcm_pb";
```

> **Note:** Exact import paths may vary. Verify after `npm install` by inspecting `node_modules/@buf/`.
