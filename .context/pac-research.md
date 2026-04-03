# PAC Challenge — Documentation Index

## Quick Summary
BitGN PAC: global competition (April 11, 2026) for building autonomous personal vault agents in TypeScript. Agent manages an Obsidian-like file system via ConnectRPC APIs, scored on task completion + trustworthiness.

## Documentation Files

| File | Contents | Audience |
|------|----------|----------|
| [01-api-reference.md](01-api-reference.md) | Complete Harness + PCM Runtime API specs, all RPCs, messages, enums, TypeScript SDK install | Opus (building) |
| [02-agent-architecture.md](02-agent-architecture.md) | Control flow, agent loop, SGR pattern, Zod schemas, conversation format, project setup | Opus (building) |
| [03-scoring-and-trust.md](03-scoring-and-trust.md) | Scoring mechanics, penalty categories, trustworthiness rubric, injection defense, outcome decision tree | Opus (building) + Haiku (reference) |
| [04-haiku-system-prompt.md](04-haiku-system-prompt.md) | Compact system prompt template for Haiku at runtime (~2000 tokens), tool list, safety rules | Haiku (runtime) |
| [05-competition-rules.md](05-competition-rules.md) | Timeline, prerequisites, allowed/prohibited, submission process, ERC3 context | General reference |

## Key Links
- Challenge: https://bitgn.com/challenge/PAC
- Sample agents: https://github.com/bitgn/sample-agents/
- Challenge docs: https://github.com/bitgn/challenges/blob/main/pac/
- Buf SDK registry: https://buf.build/bitgn/api
- SGR technique: https://abdullin.com/schema-guided-reasoning/
- LLM benchmarks: https://abdullin.com/llm-benchmarks
- Previous challenge (ERC3): https://erc.timetoact-group.at/benchmarks/erc3-prod
