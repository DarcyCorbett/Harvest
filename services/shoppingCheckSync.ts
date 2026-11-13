import type { Period } from '../functions/src/connected/model';

export interface QueuedShoppingCheck {
  id: string;
  command: unknown;
  error?: string;
  acknowledgedRevision?: number;
}

/** Keep the optimistic overlay until the subscription has observed the committed write. */
export function shoppingCheckObserved(entry: QueuedShoppingCheck, period: Period | null): boolean {
  if (entry.acknowledgedRevision === undefined || !period) return false;
  const command = entry.command as { periodId: string; itemId: string; expectedRevision: number; action: string };
  if (command.periodId !== period.id) return false;
  if (entry.acknowledgedRevision >= 0) return period.revision >= entry.acknowledgedRevision;
  // Compatibility with receipts written before the server returned period revisions.
  const item = period.items.find(i => i.id === command.itemId);
  return command.action === 'delete' ? !item : !!item && item.revision > command.expectedRevision;
}

/** Drain newly enqueued entries too, without waiting for another polling tick. */
export async function drainShoppingChecks(options: {
  active: () => boolean;
  entries: () => QueuedShoppingCheck[];
  send: (entry: QueuedShoppingCheck) => Promise<{ shoppingRevision?: number }>;
  acknowledge: (entry: QueuedShoppingCheck, revision: number) => Promise<void>;
  fail: (entry: QueuedShoppingCheck, message: string) => Promise<void>;
}): Promise<void> {
  while (options.active()) {
    const entry = options.entries().find(e => !e.error && e.acknowledgedRevision === undefined);
    if (!entry) return;
    try {
      const response = await options.send(entry);
      if (!options.active()) return;
      await options.acknowledge(entry, response.shoppingRevision ?? -1);
    } catch (error) {
      if (!options.active()) return;
      const code = (error as { code?: string }).code ?? '';
      if (/unavailable|deadline|network/.test(code)) return;
      await options.fail(entry, error instanceof Error ? error.message : 'Review this change.');
    }
  }
}
