import { describe, expect, it, vi } from 'vitest';
import { drainShoppingChecks, shoppingCheckObserved, type QueuedShoppingCheck } from '../services/shoppingCheckSync';
import type { Period } from '../functions/src/connected/model';

const entry = (id = 'a'): QueuedShoppingCheck => ({ id,
  command: { periodId: 'trip', itemId: id, expectedRevision: 2, action: 'check' } });

describe('background shopping checks', () => {
  it('starts immediately, retains an in-flight check, and drains taps queued during the request', async () => {
    let release!: (value: { shoppingRevision: number }) => void;
    let entries = [entry()];
    const send = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ shoppingRevision: 5 });
    const running = drainShoppingChecks({ active: () => true, entries: () => entries, send,
      acknowledge: async (e, revision) => { entries = entries.map(p => p.id === e.id ? { ...p, acknowledgedRevision: revision } : p); },
      fail: async () => { throw new Error('unexpected failure'); },
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(entries).toEqual([entry()]);
    entries.push(entry('b'));
    release({ shoppingRevision: 4 });
    await running;
    expect(send).toHaveBeenCalledTimes(2);
    expect(entries.map(e => e.acknowledgedRevision)).toEqual([4, 5]);
  });

  it('holds the overlay after a response until the matching snapshot arrives', () => {
    const acknowledged = { ...entry(), acknowledgedRevision: 5 };
    const period = { id: 'trip', revision: 4, items: [] } as unknown as Period;
    expect(shoppingCheckObserved(entry(), { ...period, revision: 5 })).toBe(false);
    expect(shoppingCheckObserved(acknowledged, period)).toBe(false);
    expect(shoppingCheckObserved(acknowledged, { ...period, revision: 5 })).toBe(true);
    expect(shoppingCheckObserved(acknowledged, { ...period, id: 'another', revision: 10 })).toBe(false);
  });

  it('keeps transient failures queued for retry with the same request ID', async () => {
    const entries = [entry()];
    const acknowledge = vi.fn(), fail = vi.fn();
    await drainShoppingChecks({ active: () => true, entries: () => entries,
      send: async () => { throw { code: 'functions/unavailable' }; }, acknowledge, fail });
    expect(entries).toEqual([entry()]);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it('surfaces a conflict without blocking unrelated items', async () => {
    let entries = [entry(), entry('b')];
    await drainShoppingChecks({ active: () => true, entries: () => entries,
      send: async e => { if (e.id === 'a') throw new Error('Item changed'); return { shoppingRevision: 6 }; },
      acknowledge: async (e, revision) => { entries = entries.map(p => p.id === e.id ? { ...p, acknowledgedRevision: revision } : p); },
      fail: async (e, error) => { entries = entries.map(p => p.id === e.id ? { ...p, error } : p); },
    });
    expect(entries[0].error).toBe('Item changed');
    expect(entries[1].acknowledgedRevision).toBe(6);
  });

  it('ignores responses after leaving the household', async () => {
    let active = true;
    const acknowledge = vi.fn();
    await drainShoppingChecks({ active: () => active, entries: () => [entry()],
      send: async () => { active = false; return { shoppingRevision: 5 }; }, acknowledge, fail: vi.fn() });
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
