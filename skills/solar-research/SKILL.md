---
name: solar-research
description: Gather bounded public evidence, submit a typed provenance contract to the host, and return to the requesting workflow stage. Optimized for Solar Pro4 Max: targeted queries, rapid evidence synthesis, honest uncertainty signaling.

---

# Solar Research — Solar Pro4 Optimized

**Goal**: Produce a validated ResearchContractV2 in minimal passes. Research supplies evidence for the original intention; it does not replace that intention, choose user preferences, or claim search snippets as read evidence.

**Solar Pro4 advantage**: Large context window enables comparative source analysis in a single pass. Use it. Read multiple sources, compare claims across them, and synthesize before submitting.

## Rapid Research Pass

### 1. Frame the gap precisely (before searching)

Read the host contract context. Identify **one** consequential gap:

- **Factual gap**: A specific fact needed for planning or interview readiness that current evidence does not establish.
- **Feasibility gap**: Whether a stated constraint or approach is actually achievable.
- **Comparison gap**: Tradeoffs between options the user has not yet evaluated.

Write the gap in one sentence. If you cannot name it precisely, the research will drift.

### 2. Search with intent (one focused query per gap)

Call `solar_web_search` with a **generalized, focused query** — not the full task. Example:

- Bad: "How to build a React dashboard with authentication and real-time updates using Firebase"
- Good: "React Firebase authentication real-time data patterns"

Use `domains` only when you deliberately need to narrow (e.g., academic sources, official docs). Prefer authoritative primary sources: official documentation, peer-reviewed papers, reputable technical blogs from known authors, standards bodies.

**Solar Pro4 optimization**: Search results are discovery aids. Do not treat snippets as evidence. Identify 2-4 most promising URLs per search; read them; compare.

### 3. Read and verify (batch when possible)

Call `solar_web_read` with up to 3 URLs from the current search. For PDFs, DOCX, PPTX, or other documents, use `solar_document_read` with `fast` first (text-native) and `hi_res` only when scans or complex layout require it.

For each source read:

- Extract the **specific claim** it supports.
- Note the **page section, table, or paragraph** where the claim appears.
- Record limitations: truncation, outdated version, access restrictions, conflicting information elsewhere.

**Do not** summarize generically. Extract concrete, citable content.

### 4. Synthesize before submitting

Cross-reference sources:

- Where do sources agree? → strong evidence claim.
- Where do they conflict? → uncertainty claim with both sources cited.
- Where is information missing? → uncertainty claim, do not fabricate.

Separate clearly:

| Kind | Meaning |
|------|---------|
| `evidence` | A factual claim backed by at least one read receipt |
| `inference` | A logical conclusion from evidence, not directly stated |
| `uncertainty` | What is not established; do not fill with model memory |
| `user_decision` | Something only the user can decide |

### 5. Submit via `solar_research_ready`

Call with the exact host-provided `expectedArtifactRevision`, `gapId`, `answerHeadId` (for detours). Never derive, shorten, or invent these.

```text
solar_research_ready({
  contract: {
    version: 2,
    mode: 'initial' | 'detour',
    gapId: 'exact host-provided detour gap ID (detour only)',
    answerHeadId: 'exact host-provided detour answer-head ID (detour only)',
    outcome: 'ready' | 'narrowed' | 'blocked',
    claims: [
      {id: 'C1', kind: 'evidence' | 'inference' | 'uncertainty' | 'user_decision',
       text: 'bounded, specific claim', sourceIds: ['SRC1']}
    ],
    sources: [
      {id: 'SRC1', url: 'exact public URL that was read',
       title: 'source title', receiptIds: ['exact current-pass receipt ID'],
       limitation: 'scope, currency, extraction, or other limitation'}
    ],
    learnedClaimIds: ['C1'],
    remainingGap: 'what remains unknown, or explicit statement that none remains',
    nextQuestion: {
      text: 'specific improved interview question',
      addressesGapId: 'exact active gap ID',
      rationale: 'how materially new evidence makes this question more useful'
    }
  },
  expectedArtifactRevision: null | 'exact full host-provided SHA-256 revision'
})
```

### Solar Pro4 Contract Quality Rules

**Claims must be bounded and specific:**

- Good: "React 18's `useId` hook generates unique IDs suitable for accessibility label pairing in SSR contexts (source: React official docs, `useId` page)"
- Bad: "React has some hooks for IDs"

**Sources must be citable:**

- Every `evidence` claim cites ≥1 source ID.
- Every source URL is backed by a successful current-pass `solar_web_read` or `solar_document_read` receipt.
- Search receipts and snippets are **not** source evidence.
- Every source is cited by at least one claim; omit unused sources.

**Detour discipline:**

- A ready or narrowed detour **must** include `nextQuestion` addressing the same `gapId` with a rationale explaining why the new evidence improves the question.
- Repeating the prior question or returning unrelated facts is invalid.
- A `blocked` outcome preserves a concrete uncertainty or source limitation.

**learnedClaimIds**: Only claims that represent materially new understanding this pass. New IDs, URLs, titles, or duplicate bytes are not new evidence.

### Access and Limits

- Each pass: 3 searches, 3 page-reads, 2 document reads.
- Search returns ≤5 results; page read accepts ≤3 URLs.
- Documents: ≤10 MiB input, 120-second extraction timeout.

These are application safeguards, not provider guarantees.

### When to Stop Early

Submit `blocked` when:

- Public web access is disabled and no receipted sources exist.
- Searches return no relevant results after 2 focused attempts.
- Sources exist but none support a concrete evidence claim for the gap.
- The gap is genuinely unresolvable with available evidence.

A blocked contract is **valid progress** — it preserves the limitation honestly rather than fabricating evidence.

### Local-Only Mode

When `--local-only` or `--no-web`:

- Use only authorized host-provided local context.
- Keep `sourceIds` empty when no receipted public source exists.
- Submit only truthful uncertainty, inference, or user-decision claims with limitations stated.
- Never fabricate web receipts.

### Solar Pro4 Efficiency Notes

- **One pass target**: With Solar Pro4's context capacity, aim to search → read → synthesize → submit in a single pass when the gap is well-defined.
- **Avoid drift**: If research starts covering unrelated topics, return to the named gap.
- **Reuse receipts**: Do not re-read sources already captured in the current pass.
- **Compact prose**: Keep the serialized contract under 128 KiB. Trim verbose descriptions, not required evidence or limitations.

Completion occurs **only** when `solar_research_ready` succeeds. An ordinary final reply, a hand-written report path, or a claim that research is complete cannot advance the controller.
