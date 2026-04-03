# Competition Rules & Logistics

## Timeline (Vienna Time — Europe/Vienna)

| Phase | When | What |
|-------|------|------|
| Phase 1 | March 2026 | API smoke testing, sandbox access |
| Phase 2 | ≥2 weeks before Apr 11 | Full API, limited practice tasks, open scoring |
| Phase 3 | **April 11, 2026, 13:00–15:00** | Competition window — blind scoring, suppressed feedback |
| Phase 4 | Post-event | Challenge stays runnable, live leaderboard continues |

**April 11 Schedule:**
- 13:00 — Blind evaluation opens
- 15:00 — Evaluation closes
- 16:00 — Leaderboard reveal and awards

## Prerequisites

1. Google account (for platform login)
2. Local machine or VM to run the agent
3. LLM access (cloud or local — any provider allowed)
4. BitGN API key (generated after registration at bitgn.com)

## What's Allowed

- Any LLMs (cloud-hosted or local models)
- Any programming language (we chose TypeScript)
- External tools, wrappers, libraries
- Collaboration, open-source code sharing
- Multiple sessions during competition window
- Modifying agent code between runs

## What's Prohibited

- **Human-in-the-loop** during a run (once started, agent must be fully autonomous)
- Manual tool selection or answer writing during a run
- Exploiting platform bugs or security vulnerabilities
- Circumventing rate limits or degrading platform reliability
- Extracting hidden scoring signals during the blind window
- Hard-coding answers (task instances are seeded, different seeds in competition)

## Submission

- **Unlimited sessions** during the competition window
- To enter the Hall of Fame: select one completed session via "Submit to Hall of Fame"
- If no manual selection: last completed session auto-submits before cutoff
- Hall of Fame = frozen blind submissions (canonical results)
- Live Leaderboard = ongoing, all runs, with filters (hub, model, speed, open-source)

## Scoring Summary

- 1.0 points per task, penalties reduce toward 0.0
- ~100 tasks per session
- ~1000 API calls per task cap
- Deterministic evaluation (no LLM judging)
- Blind window: scores hidden until 16:00
- Open window: immediate feedback after each trial

## Benchmarks

| ID | Purpose |
|----|---------|
| `bitgn/sandbox` | Free sandbox, no API key needed |
| `bitgn/pac1-dev` | Practice benchmark (open scoring) |
| Competition benchmark | Revealed on April 11 (blind scoring) |

## Key Contacts

- **Platform:** https://bitgn.com
- **Status:** https://status.bitgn.com
- **Newsletter:** https://bitgn.substack.com
- **Support:** biz@abdullin.com
- **Organizer:** Rinat Abdullin (Vienna, Austria)

## ERC3 Context (Previous Challenge)

The predecessor "Enterprise RAG Challenge 3" had:
- 525 registered teams, 10,000+ sessions
- 103 tasks (HR, projects, finance, customers, wiki)
- Top teams scored 100/100 with systematic + parallel approaches
- Tasks included multilingual inputs, permission checks, conflicting constraints
- PAC is the next evolution: personal vault agent instead of enterprise RAG
