export function validateCatalogueSmokeEvidence({ first, second, generationMode }) {
  for (const [label, run] of [['First', first], ['Second', second]]) {
    if (run.reservedWrites > 25 || run.consumedWrites > 25) {
      throw new Error(`${label} smoke exceeded the 25-write cap`);
    }
  }
  const resolvedPilotSources = (first.metrics?.written ?? 0) + (first.metrics?.permanentSkipped ?? 0);
  if (
    first.metrics?.fetched !== 2
    || resolvedPilotSources !== 2
    || first.metrics?.failed !== 0
    || first.metrics?.retryable !== 0
  ) {
    throw new Error('First smoke did not resolve both pilot sources safely');
  }
  if (second.metrics?.fetched !== 0 || second.metrics?.written !== 0) {
    throw new Error('Second smoke was not idempotent');
  }
  if (generationMode !== 'legacy') {
    throw new Error('Catalogue generation is not pinned to legacy');
  }
}
