---
name: solar-research
description: "Start or resume the Solar research harness for evidence gathering, a named factual gap, or updating prior research. Research-only requests stop after validated evidence; research does not grant planning or execution authority."
---

# Solar Research Harness

This is the public entry point, not the Researcher's procedural skill. The package controller binds `researcher` and injects `solar-researcher-practice` into the active system prompt. Do not locate or read package skill files yourself. Copying this file alone does not install the harness.

## Execution

1. Use the current host research context: original request, named gap, caller, web policy, current-pass receipts and submission identity.
2. Follow the bound Researcher agent's evidence collection procedure. Use only the host-enabled tools: `read`, `solar_web_search`, `solar_web_read`, `solar_document_read`, and eligible `solar_revisit`.
3. Submit the complete `ResearchContractV2` through `solar_research_ready({contract, expectedArtifactRevision})`. Take revision and detour identities exactly from the host; do not author `research.md` directly.
4. Wait for host validation and persistence. An ordinary final reply cannot advance the workflow.

## Handoff and recovery

- Successful initial research returns to interview; successful `--research-only` stops at `research_complete`. A blocked result instead pauses with its validated evidence and limitations preserved.
- A detour returns only to its saved caller with relevant learned evidence and the named improved question, or honest blockage. It does not restart the whole workflow.
- `--local-only`/`--no-web` excludes external retrieval. Local context is not a public read receipt; never invent one.
- Source errors or contradictions remain visible. A failed or stale submission does not authorize advancing, overwriting state, or mutating product files.
- Updating prior research uses the current host heads; new evidence invalidates dependent readiness/review where required.

## Scenarios

- Normal: a named feasibility gap → read relevant sources → typed supported claims → host-owned artifact → original caller.
- Failure: only search snippets or duplicate source bytes → uncertainty/blocked result, not fabricated evidence or claimed progress.
