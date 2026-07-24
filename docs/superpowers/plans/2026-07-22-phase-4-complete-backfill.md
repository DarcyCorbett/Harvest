# Phase 4 — Simplified Complete Catalogue Backfill

## Summary

Phase 4 starts only after Phase 3 recipe/reference migration is complete and its evidence is committed. Create `codex/phase-4-complete-backfill` from that final commit, then save this plan as `docs/superpowers/plans/2026-07-22-phase-4-complete-backfill.md` and commit it separately.

Use a hybrid, stored-content-first approach:

1. Classify migrated content without fetching websites.
2. Use Gemini only when required meal type or cuisine remains ambiguous.
3. Refresh websites only for unresolved `review` recipes, and only for sources that pass a five-recipe canary.
4. Keep protected or unreliable sources documented and excluded from refresh rather than bypassing access controls.

Keep Cloud Scheduler `PAUSED`, `generationMode=legacy`, and the production generator unchanged. Use manual batches capped at 8,000 catalogue writes and 500 Gemini calls per Pacific quota day.

## Implementation Changes

### Stored-content classification

- Add `classification.classifierVersion`, with version `1` representing the Phase 4 classifier. Existing documents without it are treated as version `0`.
- Scan schema-v2 `ready` and `review` recipes in document-ID order using a durable Phase 4 cursor and the existing catalogue lease/budget.
- Apply deterministic rules first. Call Gemini only if meal type or cuisine remains empty; an empty modifier list is valid and must not trigger Gemini.
- Preserve content, source URLs, manual overrides, `search.randomKey`, original ingestion time, and parser version.
- Rebuild effective metadata and search fields. Promote to `ready` only when `validateReadyRecipe` passes; missing time remains `review`.
- On provider or validation failure, preserve the existing recipe and status, record a bounded ingestion error, and advance safely so one recipe cannot block the run.
- Reruns skip classifier-version-1 documents and produce no recipe writes.

### Safe website refresh

- Harden the ingestion store before backfill:
  - Refresh failures must never replace an existing `ready` or `review` document with an operational error record.
  - Preserve manual overrides, deterministic random key, and `firstIngestedAt`.
  - Change `lastChangedAt` only when content changes.
  - Set `parserVersion=1` only after a successful fetch and parse.
- Add a server-only source-backfill record for each approved source containing its canary state: `eligible`, `unsupported`, or `failed`, plus bounded counts and reason codes.
- Canary up to five unresolved recipes per source using stored canonical URLs. A source is eligible when all available samples succeed, allowing at most one transient failure when five are tested. Repeated 401/402/403 results mark it unsupported.
- Refresh only `review`, parser-version-0 documents from eligible sources. Protected or failed sources retain their migrated content and remain review where incomplete.
- Continue normal discovery for eligible sources only, using the existing adapters, request delays, manifest, lease, and budget.

### Operator interface and safety

- Extend the existing catalogue ingestion job rather than creating another scheduled service. Add modes:
  - `classify-backfill`
  - `refresh-canary`
  - `refresh-backfill`
  - `verify-backfill`
  - `retry-failed`
- Add `--gemini-call-cap`, hard-limited to 500 for Phase 4, and retain `--write-cap` with an 8,000 default and 18,000 absolute ceiling.
- Default refresh fairness to 250 recipes per source per invocation, rotating sources round-robin.
- Add one PowerShell runner that verifies Scheduler and generation mode before and after every command and reports sanitized summaries without recipe IDs, URLs, or content.
- Explicitly deny client access to Phase 4 checkpoint/source/run collections.
- Do not add mobile APIs, enable the selector, rewrite references, delete legacy data, or activate Scheduler.

## Verification and Rollout

### Focused tests

- Deterministic classification skips Gemini when only modifiers are empty.
- Gemini is called only for missing required taxonomy and respects the 500-call cap.
- Classification preserves content, overrides, timestamps, and random keys; reruns are write-free.
- Missing time remains review after successful classification.
- Fetch, parse, protected-access, and Gemini failures preserve existing complete documents.
- Successful refresh alone advances parser version and merges manual overrides correctly.
- Source canaries gate full refresh and never bypass protected access.
- Cursor, lease, write-cap, provider-cap, resume, and reconciliation behavior are idempotent.
- Firestore Rules deny all client access to Phase 4 operational state.

Local acceptance is limited to focused Phase 4 tests, existing Functions tests, Functions build, Firestore Rules tests, secret scan, and static checks proving no generator, Scheduler, or generation-mode change.

### Production rollout

1. Confirm Phase 3 completion, clean reviewed commit, backup availability, Scheduler paused, and legacy mode.
2. Deploy the updated ingestion image dormant.
3. Run a zero-write inventory reporting counts by source, status, parser version, classifier version, and missing required metadata.
4. Run a classification canary of at most 25 recipes and 25 Gemini calls.
5. Run manual classification batches capped at 8,000 writes and 500 Gemini calls per Pacific day.
6. Rerun classification and require zero recipe changes apart from operational summaries.
7. Run five-recipe refresh canaries for every source and record eligibility.
8. Refresh unresolved recipes from eligible sources in manual 8,000-write batches, with at most 250 recipes per source per run.
9. Run Phase 3 reconciliation for late legacy recipes, migrate their references, then classify the newly created v2 documents.
10. Run `verify-backfill` and commit sanitized Phase 4 evidence.

Phase 4 completes when every v2 recipe has classifier version 1; every ready recipe validates; every parser-version-0 exception belongs to a documented unsupported/failed source or remains safely review; no existing complete content was lost; all eligible-source work is exhausted; and Scheduler/mode remain `PAUSED`/`legacy`.

## Assumptions

- The unanswered strategy choices use the recommended hybrid stored-first approach, manual operation, and 500 Gemini calls per day.
- Phase 4 improves taxonomy and unresolved content but does not require every protected-source recipe to become ready.
- Selector evaluation and catalogue-generation cutover remain Phase 5.
- The final pre-cutover Phase 3 reconciliation is still repeated in Phase 5 to catch late legacy writes.
