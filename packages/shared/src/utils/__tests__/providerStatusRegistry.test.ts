import { describe, expect, it } from 'vitest';

import {
  STATUSPAGE_REGISTRY,
  statusPageEntryForProvider,
  statusProviderIdForProvider,
} from '../providerStatusRegistry';

describe('providerStatusRegistry', () => {
  describe('STATUSPAGE_REGISTRY', () => {
    it('registers the canonical Anthropic (status.claude.com) endpoints', () => {
      // status.anthropic.com 302-redirects to status.claude.com; we register
      // the canonical host directly.
      expect(STATUSPAGE_REGISTRY.anthropic).toEqual({
        label: 'Anthropic',
        humanUrl: 'https://status.claude.com/',
        summaryJsonUrl: 'https://status.claude.com/api/v2/summary.json',
      });
    });

    it('registers the OpenAI status endpoints', () => {
      expect(STATUSPAGE_REGISTRY.openai).toEqual({
        label: 'OpenAI',
        humanUrl: 'https://status.openai.com/',
        summaryJsonUrl: 'https://status.openai.com/api/v2/summary.json',
      });
    });

    it('registers OpenRouter with a null summaryJsonUrl (no public JSON API)', () => {
      expect(STATUSPAGE_REGISTRY.openrouter).toEqual({
        label: 'OpenRouter',
        humanUrl: 'https://status.openrouter.ai/',
        summaryJsonUrl: null,
      });
      expect(STATUSPAGE_REGISTRY.openrouter.summaryJsonUrl).toBeNull();
    });

    it('exposes exactly the three known status provider ids', () => {
      expect(Object.keys(STATUSPAGE_REGISTRY).sort()).toEqual([
        'anthropic',
        'openai',
        'openrouter',
      ]);
    });
  });

  describe('statusProviderIdForProvider', () => {
    it('maps anthropic → anthropic', () => {
      expect(statusProviderIdForProvider('anthropic')).toBe('anthropic');
    });

    it('maps openai → openai', () => {
      expect(statusProviderIdForProvider('openai')).toBe('openai');
    });

    it('maps codex → openai (Codex rides OpenAI API)', () => {
      expect(statusProviderIdForProvider('codex')).toBe('openai');
    });

    it('maps openrouter → openrouter', () => {
      expect(statusProviderIdForProvider('openrouter')).toBe('openrouter');
    });

    it('maps mindstone → openrouter (managed pool routes via OpenRouter)', () => {
      expect(statusProviderIdForProvider('mindstone')).toBe('openrouter');
    });

    it('is case-insensitive', () => {
      expect(statusProviderIdForProvider('Anthropic')).toBe('anthropic');
      expect(statusProviderIdForProvider('OPENAI')).toBe('openai');
      expect(statusProviderIdForProvider('Codex')).toBe('openai');
      expect(statusProviderIdForProvider('OpenRouter')).toBe('openrouter');
      expect(statusProviderIdForProvider('MINDSTONE')).toBe('openrouter');
    });

    it('tolerates surrounding whitespace', () => {
      expect(statusProviderIdForProvider('  anthropic  ')).toBe('anthropic');
      expect(statusProviderIdForProvider('\tcodex\n')).toBe('openai');
      expect(statusProviderIdForProvider(' MindStone ')).toBe('openrouter');
    });

    it('returns null for unknown providers', () => {
      expect(statusProviderIdForProvider('google')).toBeNull();
      expect(statusProviderIdForProvider('rebel-cloud')).toBeNull();
      expect(statusProviderIdForProvider('')).toBeNull();
      expect(statusProviderIdForProvider('   ')).toBeNull();
    });

    it('returns null for null/undefined', () => {
      expect(statusProviderIdForProvider(null)).toBeNull();
      expect(statusProviderIdForProvider(undefined)).toBeNull();
    });
  });

  describe('statusPageEntryForProvider', () => {
    it('returns the Anthropic entry for anthropic', () => {
      expect(statusPageEntryForProvider('anthropic')).toBe(STATUSPAGE_REGISTRY.anthropic);
    });

    it('returns the OpenAI entry for codex (mapped)', () => {
      expect(statusPageEntryForProvider('codex')).toBe(STATUSPAGE_REGISTRY.openai);
    });

    it('returns the OpenRouter entry for mindstone (mapped)', () => {
      expect(statusPageEntryForProvider('mindstone')).toBe(STATUSPAGE_REGISTRY.openrouter);
    });

    it('is case-insensitive and whitespace-tolerant', () => {
      expect(statusPageEntryForProvider('  OpenAI ')).toBe(STATUSPAGE_REGISTRY.openai);
    });

    it('returns null for unknown / null / undefined providers', () => {
      expect(statusPageEntryForProvider('google')).toBeNull();
      expect(statusPageEntryForProvider(null)).toBeNull();
      expect(statusPageEntryForProvider(undefined)).toBeNull();
    });
  });
});
