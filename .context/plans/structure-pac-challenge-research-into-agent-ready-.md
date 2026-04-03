# Plan: Structure PAC Challenge Research into Agent-Ready Documentation

## Context
We've completed research on the BitGN PAC challenge. Before implementation, we need to distill all findings into structured reference docs in `.context/` that will serve two audiences:
- **Claude Opus** — building the agent (needs full API specs, architecture patterns, scoring nuances, design decisions)
- **Claude Haiku** — executing tasks at runtime (needs compact, unambiguous tool schemas, decision trees, response formats)

## Documentation Structure

### 1. `.context/01-api-reference.md` — Complete API Spec
Both APIs in a structured, parseable format:
- **Harness API** (control plane): every RPC, request/response fields, enums
- **PCM Runtime API** (per-trial): every file-system RPC, request/response fields, enums
- Field types, optionality, semantics
- Format: tables + typed signatures (no prose walls)

### 2. `.context/02-agent-architecture.md` — Agent Design Blueprint
- Control flow: harness → trial → agent loop → answer
- Agent loop mechanics: conversation history, structured output, tool dispatch
- SGR pattern: how to structure the LLM's reasoning via Zod schemas
- Initial boot sequence (tree, read AGENTS.md, context)
- Max 30 steps, ~1000 API calls cap
- TypeScript SDK packages and setup

### 3. `.context/03-scoring-and-trust.md` — What Wins & What Loses
- Scoring mechanics (1.0 per task, penalties to 0.0)
- Penalty categories with examples
- Trustworthiness rubric: rewarded vs punished behaviors
- Injection attack patterns to defend against
- Outcome enum usage guide (when to use each)
- Common failure modes from ERC3 insights

### 4. `.context/04-haiku-system-prompt.md` — Compact Runtime Reference
Designed as a self-contained reference that gets included in the Haiku system prompt during task execution:
- Available tools as a flat list with param signatures
- Outcome decision tree (when OK vs DENIED_SECURITY vs CLARIFICATION etc.)
- Safety rules (injection resistance, no exfiltration, no destructive actions without justification)
- Answer format requirements (message, outcome, refs)
- Constraint checklist before every action
- Max ~2000 tokens to fit in Haiku's working context

### 5. `.context/05-competition-rules.md` — Rules & Constraints
- Timeline, submission process
- What's allowed/prohibited
- API call cap, blind vs open scoring
- Hall of Fame submission mechanics

### 6. Update `.context/pac-research.md`
- Keep as the high-level overview / index pointing to the detailed docs

## Verification
- Each doc should be self-contained for its purpose
- 04 (Haiku prompt) should be under 2000 tokens
- All proto field names match the actual API exactly
- No duplicated information across docs (reference instead)
