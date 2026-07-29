# Complete Catalogue Snapshot Before Gemini Tagging

## Summary

Create `codex/complete-catalogue-snapshot` from commit `917193e`. Save this plan as `docs/superpowers/plans/2026-07-29-complete-catalogue-snapshot.md` and commit it separately.

Complete a gap-filling crawl across all 13 approved sources before Gemini backfill. Existing displayable recipes remain untouched; only new, operational-failure, or structurally incomplete recipes are fetched.

Current production findings:

- 38,943 displayable schema-v2 recipes.
- 1,354 operational records, mainly WordPress parse failures.
- Spend With Pennies is affected by rate limiting plus a fixable lease-renewal bug.
- NYT Cooking has the largest apparent unprocessed backlog and requires a public-access canary.
- America’s Test Kitchen and Akis are already close to their discovered totals.
- Serious Eats’ legacy index overcounts recipes because its broad URL pattern included non-recipe pages.

No Gemini calls occur during the snapshot crawl. Generation mode remains unchanged and the app stays usable throughout.

## Implementation Changes

### Complete all-source discovery

- Extend the ingestion job with operator-only modes:
  - `snapshot-inventory`
  - `snapshot-canary`
  - `snapshot-crawl`
  - `snapshot-verify`
  - `tag-batch-prepare`, `tag-batch-submit`, and `tag-batch-collect`
  - `weekly-new`
- Support all 13 sources with source-specific sitemap and recipe-URL filters.
- At the start of the crawl, save an immutable canonical-URL inventory and per-source hash in Cloud Storage.
- Skip existing `ready` or `review` recipes with valid display content. Fetch only missing, operational, or structurally incomplete candidates.
- After completing the frozen inventory, rescan every sitemap. Continue until two consecutive inventories have the same canonical-ID hash, then freeze the Gemini backlog.

### Fetching and parsing fallbacks

- Replace URL-count lease renewal with a 60-second heartbeat and renew before and after long cooldowns.
- Keep single-task execution and source-specific delays. Honor `Retry-After`, add jittered exponential backoff, and isolate heavily throttled sources into their own runs.
- For Spend With Pennies, retain the 10-second minimum delay and restart from its durable cursor after fixing the lease.
- Apply the following public-data fallback ladder:
  1. Normal HTTP with compression, redirects, and standard browser headers.
  2. JSON-LD `Recipe` graph/list parsing.
  3. WordPress Recipe Maker, Tasty Recipes, microdata, and other known public recipe markup.
  4. Public embedded application state.
  5. Playwright rendering when JavaScript is required.
- Do not impersonate Googlebot or bypass login, paywall, robots, CAPTCHA, or other access controls.
- Replace the broad parse failure code with bounded reasons such as `non-recipe-page`, `missing-recipe-markup`, `missing-display-content`, `protected-access`, `rate-limited`, and `unsupported-markup`.
- Canary up to ten pages per source, including prior failures where available. A source is deferred only after all applicable public fallbacks have failed.
- Preserve existing content, overrides, timestamps, random keys, and valid classification. The crawl uses deterministic taxonomy only and never invokes Gemini.

### Gemini batch preparation

- After snapshot verification, calculate the exact backlog from stored content. AI is required only when meal type or cuisine remains unresolved; missing time or empty modifiers do not require Gemini.
- Stop and present the final recipe count, estimated tokens, cost, and completion estimate before submitting the first paid batch.
- Implement the real Gemini Batch API using stable `gemini-3.1-flash-lite`, rather than the current synchronous per-recipe loop. Gemini supports structured output and Batch API; file-based batch input supports files up to 2 GB and receives discounted batch pricing. [Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite), [Batch API](https://ai.google.dev/gemini-api/docs/batch-api)
- Build deterministic JSONL shards capped at 5,000 recipes and 8 million estimated queued tokens each.
- Permit only one active initial-backfill batch at a time. Store durable prepared/submitted/completed state because batch creation is not idempotent.
- Validate every response against the fixed taxonomy, preserve raw invalid output server-side, and retry only failed or invalid responses.
- Apply at most 18,000 recipe writes per Pacific quota day, leaving Firestore headroom for normal app usage.

### Weekly new-recipe maintenance

- Keep Cloud Scheduler paused until the initial crawl and Gemini backlog are complete.
- Then change the existing catalogue schedule to Sunday at 03:00 `Asia/Nicosia` and run `weekly-new`.
- Every weekly run rescans sitemap indexes from the beginning and compares canonical IDs with the completed baseline. This catches sites that prepend new URLs.
- Fetch only previously unseen recipe IDs. Existing valid recipes are not refreshed when `lastmod` changes.
- Classify new recipes deterministically first, then synchronously tag only new recipes still missing meal type or cuisine, capped at 500 Gemini calls per weekly run.
- Retain overflow and transient failures for the next run. Never rewrite existing valid recipes or scrape as a generation fallback.

No mobile API, callable, selector, or generator behavior changes are required.

## Operational Sequence

1. Implement and locally verify the new modes, source filters, lease heartbeat, fallback parsers, and failure reporting.
2. Deploy the ingestion image dormant with Scheduler still paused.
3. Run the all-source zero-write inventory and record expected counts.
4. Run source canaries and diagnose every high failure-rate source.
5. Crawl the immutable baseline in restartable 18,000-write daily batches.
6. Retry operational and incomplete candidates using the applicable fallback strategies.
7. Run reconciliation inventories until two consecutive canonical-ID hashes match.
8. Require an idempotency run with zero recipe writes.
9. Produce the exact AI-required inventory and revised Gemini Batch cost.
10. After explicit cost confirmation, submit and collect the initial Gemini batches.
11. Verify the tagging backlog is exhausted apart from documented failures.
12. Enable the Sunday `weekly-new` schedule and verify its first no-op or new-recipe run.

## Tests and Completion Gates

- Sitemap insertion at the beginning is detected by weekly discovery.
- Existing canonical IDs and valid documents are not refetched or rewritten.
- Missing and operational recipes are retried safely.
- Slow requests and long 429 cooldowns cannot expire the ingestion lease.
- Each parser fallback is covered with representative fixtures.
- Non-recipe posts are distinguished from unsupported recipe markup.
- Baseline crawling makes zero Gemini calls.
- Batch submission is restartable without duplicate jobs or duplicate recipe writes.
- Batch results preserve manual overrides and reject out-of-taxonomy values.
- Weekly maintenance fetches and tags only new recipes.
- Generation mode is unchanged and no generation path invokes crawling or Gemini.
- Final evidence reconciles, per source: discovered, already complete, newly parsed, non-recipe, inaccessible, unsupported, retryable, and AI-required counts.

The snapshot is complete when every canonical URL present at the final reconciliation timestamp is either represented by a displayable schema-v2 recipe or has a documented terminal reason after all permitted public-access fallbacks have been exhausted.
