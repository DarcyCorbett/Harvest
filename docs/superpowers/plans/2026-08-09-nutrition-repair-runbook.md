# Nutrition repair runbook

The nutrition repair is intentionally separate from normal weekly discovery. It never calls
Gemini, never changes generator mode, excludes frozen Serious Eats and Akis recipes, and
requires the catalogue Scheduler to remain paused throughout each operation.

## Local gate

```powershell
npm.cmd run verify:final:local
```

## Deploy the dormant ingestion image

```powershell
pwsh -File scripts/deploy-phase4-backfill.ps1 -ProjectId meal-wizard-ad202
```

The deployment preserves whichever valid generation mode is already active.

## Canary and inventory

```powershell
pwsh -File scripts/run-phase4-backfill.ps1 -ProjectId meal-wizard-ad202 -Mode nutrition-canary
pwsh -File scripts/run-phase4-backfill.ps1 -ProjectId meal-wizard-ad202 -Mode verify-nutrition
```

Review the sanitized per-source canary counts before allowing recipe writes.

## Bounded repair

```powershell
pwsh -File scripts/run-phase4-backfill.ps1 -ProjectId meal-wizard-ad202 -Mode nutrition-backfill -WriteCap 8000 -MaxPerSource 250
```

Repeat on later Pacific quota days until `verify-nutrition` reports `pending: 0`. A recipe
whose publisher has no nutrition is recorded as checked at parser version 3 and remains
displayable with “Nutrition unavailable”. Transient failures remain pending for a later run;
terminal source or parse outcomes preserve the existing recipe and are recorded as checked.

Do not resume Scheduler until the intended maintenance window is complete.
