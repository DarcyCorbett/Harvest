import { describe, expect, it, vi } from 'vitest';

import { createGenerationDispatcher } from '../services/generationDispatcher';

describe('generation dispatcher', () => {
  it('uses only catalogue generation when the operator flag is catalogue', async () => {
    const legacyGenerate = vi.fn();
    const catalogueGenerate = vi.fn(async () => ['catalogue']);
    const dispatcher = createGenerationDispatcher({
      getMode: vi.fn(async (): Promise<'catalogue'> => 'catalogue'),
      legacyGenerate,
      catalogueGenerate,
      legacyRegenerate: vi.fn(),
      catalogueRegenerate: vi.fn(),
    });

    await expect(dispatcher.generate('config', 'household', vi.fn()))
      .resolves.toEqual(['catalogue']);
    expect(catalogueGenerate).toHaveBeenCalledOnce();
    expect(legacyGenerate).not.toHaveBeenCalled();
  });

  it('keeps legacy behavior available only when the operator flag is legacy', async () => {
    const legacyRegenerate = vi.fn(async () => ['legacy']);
    const catalogueRegenerate = vi.fn();
    const dispatcher = createGenerationDispatcher({
      getMode: vi.fn(async (): Promise<'legacy'> => 'legacy'),
      legacyGenerate: vi.fn(),
      catalogueGenerate: vi.fn(),
      legacyRegenerate,
      catalogueRegenerate,
    });

    await expect(dispatcher.regenerate('meals', [0], 'config', 'household', vi.fn()))
      .resolves.toEqual(['legacy']);
    expect(legacyRegenerate).toHaveBeenCalledOnce();
    expect(catalogueRegenerate).not.toHaveBeenCalled();
  });

  it('does not fall back when catalogue generation fails', async () => {
    const legacyGenerate = vi.fn();
    const dispatcher = createGenerationDispatcher({
      getMode: vi.fn(async (): Promise<'catalogue'> => 'catalogue'),
      legacyGenerate,
      catalogueGenerate: vi.fn(async () => {
        throw new Error('No exact recipe match.');
      }),
      legacyRegenerate: vi.fn(),
      catalogueRegenerate: vi.fn(),
    });

    await expect(dispatcher.generate('config', 'household', vi.fn()))
      .rejects.toThrow('No exact recipe match.');
    expect(legacyGenerate).not.toHaveBeenCalled();
  });

  it('propagates configuration read failures without choosing a generator', async () => {
    const legacyGenerate = vi.fn();
    const catalogueGenerate = vi.fn();
    const dispatcher = createGenerationDispatcher({
      getMode: vi.fn(async () => {
        throw new Error('Generation mode is unavailable.');
      }),
      legacyGenerate,
      catalogueGenerate,
      legacyRegenerate: vi.fn(),
      catalogueRegenerate: vi.fn(),
    });

    await expect(dispatcher.generate('config', 'household', vi.fn()))
      .rejects.toThrow('Generation mode is unavailable.');
    expect(legacyGenerate).not.toHaveBeenCalled();
    expect(catalogueGenerate).not.toHaveBeenCalled();
  });
});
