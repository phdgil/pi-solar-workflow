---
name: solar-interview
description: Clarify the user's intention through saved, evidence-grounded answers, current readiness, and explicit closure choices. Optimized for Solar Pro4 Max: rapid convergence, precise gap targeting, honest readiness signaling.

---

# Solar Interview — Solar Pro4 Optimized

**Goal**: Reach interview readiness in minimal turns. Readiness = one clear goal sentence, explicit constraints, observable success evidence, no material gaps, contradictions, or blockers.

**Solar Pro4 advantage**: Strong reasoning about intent and constraints from limited evidence. Use each turn to narrow the gap, not to collect every possible detail.

## Rapid Convergence Strategy

### Before Each Turn

1. **Read saved state**: answers, research head, materialState, readiness.
2. **Identify the single biggest open item**: one gap, one contradiction, or one blocker.
3. **Decide the strategy**:
   - `question`: One targeted question closes the biggest open item.
   - `reframe`: The current question isn't landing; rephrase it.
   - `research`: A factual gap needs targeted research, not another user question.
   - `ready`: Goal, constraints, success evidence are clear; no blocker remains.
   - `blocked`: No path forward without user decision or external evidence.

**Rule**: At most one consequential question per turn. Implementation details wait for planning.

### Calling `solar_interview_round`

After each answer or research return, call exactly once with the complete V2 payload:

```json
{
  "goal": {"score": 0..1, "evidence": ["answer-id"], "gap": "remaining goal ambiguity"},
  "constraints": {"score": 0..1, "evidence": ["answer-id"], "gap": "remaining constraint ambiguity"},
  "success": {"score": 0..1, "evidence": ["answer-id"], "gap": "remaining success-evidence ambiguity"},
  "blockers": ["specific unresolved decision or conflict"],
  "deferred": [{"topic": "topic", "evidence": ["answer-id"], "reason": "why user left this to planning"}],
  "intent": "one-sentence statement of current understood intention",
  "changeReason": "what changed in this turn (new answer, correction, research return)",
  "question": "at most one question, at most one question mark (omit when ready)",
  "strategy": "question" | "reframe" | "research" | "ready" | "blocked",
  "currentGapId": "required while not ready; omit when ready",
  "materialState": {
    "topics": [{"topicId": "id", "kind": "decision"|"correction"|"constraint"|"success",
                "normalizedValue": "normalized settled value", "sourceContentHashes": ["hash"]}],
    "gaps": [{"gapId": "id", "status": "open"|"narrowed"|"resolved", "normalizedSummary": "summary"}],
    "claims": [{"gapId": "id", "normalizedClaim": "claim", "sourceContentHashes": ["hash"]}]
  },
  "readiness": {
    "status": "not_ready" | "ready",
    "goalSentence": "exact one-sentence goal (when ready)",
    "materialGaps": [{"id": "id", "issue": "issue", "evidenceIds": ["id"], "researchable": true|false}],
    "contradictions": [{"id": "id", "issue": "issue", "evidenceIds": ["id"]}]
  }
}
```

### Solar Pro4 Readiness Criteria

Report `ready` **only when all of these hold**:

1. **One goal sentence** that captures the intended deliverable/outcome.
2. **Explicit constraints** that bound the work (format, platform, offline/online, timeline, scope).
3. **Observable success evidence** — how will we know it worked? (a test, a report, a verified output).
4. **No material gap** — every open item is either resolved, explicitly deferred to planning, or acknowledged as a known unknown.
5. **No contradiction** — saved answers do not conflict on a consequential point.
6. **No blocker** — no unresolved user decision that prevents planning.

**Scores are advisory only.** A rising score does not mean ready. Readiness is a binary state based on the criteria above.

### Gap Resolution Priority

When multiple gaps exist, address in this order:

1. **Goal ambiguity** — What is the user trying to produce? (highest priority)
2. **Success criteria** — How will they know it's done correctly?
3. **Hard constraints** — Platform, format, offline requirement, timeline.
4. **Scope boundaries** — What's explicitly out of scope?
5. **Preferences** — Style, approach, tool choice (often defer to planning).

### Researchable Gaps → Targeted Detour

When a gap is factual and the research head is stale or missing:

```text
solar_revisit({stage:'research', gap:'one named material gap',
  evidence:'saved answer IDs and the observed reason current evidence cannot resolve it'})
```

The detour preserves all answer history, the original request, and the return route. On return, use new relevant source bytes and a named question rationale, or record truthful blockage.

**After one same-gap response with no material information**, change strategy: reframe or request research. Do not repeat the same wording.

### Closure

**Normal closure**: User enters `/solar-interview confirm <exact 12-character token>`. The host displays this token when readiness is reached. Any new answer or research invalidates it.

**Early finish**: `/solar-interview finish` or `/solar-interview finish plan-only` at any score. This preserves unresolved gaps, contradictions, deferred items, and any unconfirmed goal. Grants planning authority only — not execution. `finish plan-only` also disables the execute path after planning.

**Not closure**: Plain "yes", "enough", "sufficient", planning mentions, quotations, hypothetical wording, assistant prose, `/solar-interview stop`.

### Solar Pro4 Efficiency Notes

- **Reuse aggressively**: Before asking anything, check if saved answers + research already resolve it.
- **One gap per turn**: Don't try to close everything at once. Pick the biggest blocker.
- **Honest blocking**: If you genuinely cannot proceed without information you cannot get, report `blocked` with the specific missing item. Do not manufacture progress.
- **Compact materialState**: Normalize values to canonical forms. Use hashes for provenance, not for information content.

### Recovery Commands

| Command | When |
|---------|------|
| `/solar-interview continue` | Another useful question is available |
| `/solar-interview review` | Reassess current heads without claiming new progress |
| `/solar-interview retry` | Retry the V2 report against same saved evidence |
| `/solar-interview resume` | Reopen supported saved state |
| `/solar-interview pause` | Pause with V2 evidence and recovery state preserved |

### What Counts as Progress

A changed decision or correction, narrowed/resolved gap, relevant claim backed by different source bytes, changed diagnostic, passing gate, resolved plan finding, or changed output.

**Not progress**: New IDs, URLs, hashes, scores, receipt IDs, reworded prose, repeated same-gap answers, duplicate claims, duplicate source bytes.

Identical short text may matter for a different substantive `topicId`; do not discard it globally.

### Common Solar Pro4 Failures to Avoid

- Treating a score increase as readiness
- Asking the user to re-answer something the saved answer already resolves
- Reporting ready while a material gap, contradiction, or blocker remains
- Inventing a new answer head or research head instead of reusing the saved one
- Closing early with unresolved items still present
- Asking multiple questions in one turn when one would suffice
- Collecting implementation details before the goal and success criteria are clear
