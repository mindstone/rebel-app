import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatformConfig, setPlatformConfig } from '@core/platform';
import {
  githubCredentialSource,
  googleCredentialSource,
  hubspotCredentialSource,
  microsoftCredentialSource,
  oauthCredentialEnvVars,
  resolveDigitalOceanCredentials,
  resolveMicrosoftClientId,
  resolveOAuthCredentials,
  resolvePlaudCredentials,
  resolveSalesforceCredentials,
  salesforceCredentialSource,
  setOAuthCredentialsProvider,
  slackCredentialSource,
  type OAuthCredentialsProvider,
} from '../oauthCredentials';

// The connector setup UI persists user-provided OAuth credentials to settings.
// Mock the settings store so tests control that input without touching disk.
let mockSettings: Record<string, unknown> = {};
vi.mock('@core/services/settingsStore', () => ({
  getSettings: () => mockSettings,
}));

describe('oauthCredentials', () => {
  const originalPlatformConfig = getPlatformConfig();

  const setOssBuild = (isOss: boolean) => {
    setPlatformConfig({ ...getPlatformConfig(), isOss });
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    setOAuthCredentialsProvider(null);
    mockSettings = {};
    setPlatformConfig(originalPlatformConfig);
  });

  const settingsBackedCredentialCases = [
    {
      name: 'Google',
      source: googleCredentialSource,
      settingsKey: 'googleWorkspace',
      envClientId: 'GOOGLE_CLIENT_ID',
      envClientSecret: 'GOOGLE_CLIENT_SECRET',
      settingsClientId: 'settings-google-client-id',
      settingsClientSecret: 'settings-google-client-secret',
    },
    {
      name: 'Slack',
      source: slackCredentialSource,
      settingsKey: 'slack',
      envClientId: 'SLACK_CLIENT_ID',
      envClientSecret: 'SLACK_CLIENT_SECRET',
      settingsClientId: 'settings-slack-client-id',
      settingsClientSecret: 'settings-slack-client-secret',
    },
    {
      name: 'HubSpot',
      source: hubspotCredentialSource,
      settingsKey: 'hubspot',
      envClientId: 'HUBSPOT_CLIENT_ID',
      envClientSecret: 'HUBSPOT_CLIENT_SECRET',
      settingsClientId: 'settings-hubspot-client-id',
      settingsClientSecret: 'settings-hubspot-client-secret',
    },
  ] as const;

  it('resolves provider credentials only from provider env vars', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', ' google-client-id ');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', ' google-client-secret ');

    expect(resolveOAuthCredentials(googleCredentialSource)).toEqual({
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
    });
  });

  it('returns null when required provider env vars are missing', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client-id');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', '');

    expect(resolveOAuthCredentials(googleCredentialSource)).toBeNull();
  });

  it('uses the OSS env naming convention for all registered client credentials', () => {
    expect(oauthCredentialEnvVars).toMatchObject({
      google: { envClientId: 'GOOGLE_CLIENT_ID', envClientSecret: 'GOOGLE_CLIENT_SECRET' },
      slack: { envClientId: 'SLACK_CLIENT_ID', envClientSecret: 'SLACK_CLIENT_SECRET' },
      hubspot: { envClientId: 'HUBSPOT_CLIENT_ID', envClientSecret: 'HUBSPOT_CLIENT_SECRET' },
      github: { envClientId: 'GITHUB_CLIENT_ID', envClientSecret: 'GITHUB_CLIENT_SECRET' },
      digitalocean: {
        envClientId: 'DIGITAL_OCEAN_CLIENT_ID',
        envClientSecret: 'DIGITAL_OCEAN_CLIENT_SECRET',
      },
      salesforce: { envClientId: 'SALESFORCE_CLIENT_ID', envClientSecret: 'SALESFORCE_CLIENT_SECRET' },
      plaud: { envClientId: 'PLAUD_CLIENT_ID', envClientSecret: 'PLAUD_CLIENT_SECRET' },
      discourse: { envClientId: 'DISCOURSE_CLIENT_ID', envClientSecret: 'DISCOURSE_CLIENT_SECRET' },
    });
  });

  it('resolves Microsoft public-client ID from env first', () => {
    expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBeNull();

    vi.stubEnv('MICROSOFT_CLIENT_ID', ' microsoft-client-id ');

    expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBe('microsoft-client-id');
  });

  describe('OSS-only settings tier for catalog OAuth credentials', () => {
    it.each(settingsBackedCredentialCases)(
      'resolves $name credentials from settings when OSS env/provider inputs are absent',
      ({ source, settingsKey, settingsClientId, settingsClientSecret }) => {
        setOssBuild(true);
        mockSettings = {
          [settingsKey]: {
            clientId: ` ${settingsClientId} `,
            clientSecret: ` ${settingsClientSecret} `,
          },
        };

        expect(resolveOAuthCredentials(source)).toEqual({
          clientId: settingsClientId,
          clientSecret: settingsClientSecret,
        });
      },
    );

    it.each(settingsBackedCredentialCases)(
      'keeps env precedence over $name settings in OSS',
      ({ source, settingsKey, envClientId, envClientSecret, settingsClientId, settingsClientSecret }) => {
        setOssBuild(true);
        mockSettings = {
          [settingsKey]: {
            clientId: settingsClientId,
            clientSecret: settingsClientSecret,
          },
        };
        vi.stubEnv(envClientId, `env-${settingsKey}-client-id`);
        vi.stubEnv(envClientSecret, `env-${settingsKey}-client-secret`);

        expect(resolveOAuthCredentials(source)).toEqual({
          clientId: `env-${settingsKey}-client-id`,
          clientSecret: `env-${settingsKey}-client-secret`,
        });
      },
    );

    it.each(settingsBackedCredentialCases)(
      'returns null for $name in OSS when env, provider, and settings are absent',
      ({ source }) => {
        setOssBuild(true);

        expect(resolveOAuthCredentials(source)).toBeNull();
      },
    );

    it('resolves Microsoft clientId-only settings in OSS', () => {
      setOssBuild(true);
      mockSettings = { microsoft: { clientId: ' settings-microsoft-client-id ' } };

      expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBe('settings-microsoft-client-id');
    });

    it('keeps env precedence over Microsoft settings in OSS', () => {
      setOssBuild(true);
      mockSettings = { microsoft: { clientId: 'settings-microsoft-client-id' } };
      vi.stubEnv('MICROSOFT_CLIENT_ID', ' env-microsoft-client-id ');

      expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBe('env-microsoft-client-id');
    });

    it('returns null for Microsoft in OSS when env, provider, and settings are absent', () => {
      setOssBuild(true);

      expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBeNull();
    });

    it('ignores settings for out-of-scope providers and still resolves env/provider only', () => {
      setOssBuild(true);
      mockSettings = {
        github: { clientId: 'settings-github-id', clientSecret: 'settings-github-secret' },
        plaud: { clientId: 'settings-plaud-id', clientSecret: 'settings-plaud-secret' },
        digitalocean: { clientId: 'settings-digitalocean-id', clientSecret: 'settings-digitalocean-secret' },
      };

      expect(resolveOAuthCredentials(githubCredentialSource)).toBeNull();
      expect(resolvePlaudCredentials()).toBeNull();
      expect(resolveDigitalOceanCredentials()).toBeNull();

      setOAuthCredentialsProvider({
        get: (provider) => {
          if (provider === 'github') {
            return { clientId: 'provider-github-id', clientSecret: 'provider-github-secret' };
          }
          if (provider === 'plaud') {
            return { clientId: 'provider-plaud-id', clientSecret: 'provider-plaud-secret' };
          }
          if (provider === 'digitalocean') {
            return { clientId: 'provider-digitalocean-id', clientSecret: 'provider-digitalocean-secret' };
          }
          return null;
        },
      });

      expect(resolveOAuthCredentials(githubCredentialSource)).toEqual({
        clientId: 'provider-github-id',
        clientSecret: 'provider-github-secret',
      });
      expect(resolvePlaudCredentials()).toEqual({
        clientId: 'provider-plaud-id',
        clientSecret: 'provider-plaud-secret',
      });
      expect(resolveDigitalOceanCredentials()).toEqual({
        clientId: 'provider-digitalocean-id',
        clientSecret: 'provider-digitalocean-secret',
      });
    });
  });

  describe('injected credentials provider (commercial-build fallback)', () => {
    const fakeProvider: OAuthCredentialsProvider = {
      get: (provider) => {
        if (provider === 'slack') return { clientId: 'commercial-slack-id', clientSecret: 'commercial-slack-secret' };
        if (provider === 'microsoft') return { clientId: 'commercial-ms-id' };
        return null; // salesforce/discourse never supplied — BYOK preserved
      },
    };

    it('stays broken-by-default (null) when no provider is registered and env is unset', () => {
      expect(resolveOAuthCredentials(slackCredentialSource)).toBeNull();
    });

    it('falls back to the provider when env is unset', () => {
      setOAuthCredentialsProvider(fakeProvider);
      expect(resolveOAuthCredentials(slackCredentialSource)).toEqual({
        clientId: 'commercial-slack-id',
        clientSecret: 'commercial-slack-secret',
      });
    });

    it('env vars take precedence over the provider', () => {
      setOAuthCredentialsProvider(fakeProvider);
      vi.stubEnv('SLACK_CLIENT_ID', 'env-slack-id');
      vi.stubEnv('SLACK_CLIENT_SECRET', 'env-slack-secret');
      expect(resolveOAuthCredentials(slackCredentialSource)).toEqual({
        clientId: 'env-slack-id',
        clientSecret: 'env-slack-secret',
      });
    });

    it('falls through to the provider when only one half of the env pair is set (regression guard)', () => {
      setOAuthCredentialsProvider(fakeProvider);
      vi.stubEnv('SLACK_CLIENT_ID', 'env-slack-id');
      // SLACK_CLIENT_SECRET intentionally unset → env pair incomplete
      expect(resolveOAuthCredentials(slackCredentialSource)).toEqual({
        clientId: 'commercial-slack-id',
        clientSecret: 'commercial-slack-secret',
      });
    });

    it('returns null for a provider that supplies only a clientId (no secret) for a secret-requiring connector', () => {
      setOAuthCredentialsProvider({ get: () => ({ clientId: 'id-only' }) });
      expect(resolveOAuthCredentials(slackCredentialSource)).toBeNull();
    });

    it('does not supply credentials for always-BYOK connectors (salesforce)', () => {
      setOAuthCredentialsProvider(fakeProvider);
      expect(resolveOAuthCredentials(salesforceCredentialSource)).toBeNull();
    });

    it('resolves Microsoft client ID from the provider when env is unset', () => {
      setOAuthCredentialsProvider(fakeProvider);
      expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBe('commercial-ms-id');
    });

    it('an empty provider (OSS stub shape) keeps every connector broken-by-default', () => {
      setOAuthCredentialsProvider({ get: () => null });
      expect(resolveOAuthCredentials(slackCredentialSource)).toBeNull();
      expect(resolveOAuthCredentials(googleCredentialSource)).toBeNull();
      expect(resolveMicrosoftClientId(microsoftCredentialSource)).toBeNull();
    });
  });

  describe('resolveSalesforceCredentials — BYOK user-provided creds from settings', () => {
    it.each([true, false])(
      'reads the Connected App creds the setup UI saved to settings when env + provider are empty (isOss=%s)',
      (isOss) => {
        setOssBuild(isOss);
        // Trimming mirrors readEnv behaviour and the UI .trim() on save.
        mockSettings = { salesforce: { clientId: ' 3MVG9.consumer-key ', clientSecret: ' consumer-secret ' } };
        expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
          clientId: '3MVG9.consumer-key',
          clientSecret: 'consumer-secret',
        });
      },
    );

    it('env still takes precedence over settings (dev/CI override preserved)', () => {
      mockSettings = { salesforce: { clientId: 'settings-id', clientSecret: 'settings-secret' } };
      vi.stubEnv('SALESFORCE_CLIENT_ID', 'env-id');
      vi.stubEnv('SALESFORCE_CLIENT_SECRET', 'env-secret');
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
        clientId: 'env-id',
        clientSecret: 'env-secret',
      });
    });

    it('returns null when neither env nor settings supply both halves', () => {
      mockSettings = { salesforce: { clientId: 'only-id' } }; // missing secret
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toBeNull();
    });

    it('falls through to settings when the env pair is incomplete (only client id set)', () => {
      mockSettings = { salesforce: { clientId: 'settings-id', clientSecret: 'settings-secret' } };
      vi.stubEnv('SALESFORCE_CLIENT_ID', 'env-id'); // SALESFORCE_CLIENT_SECRET intentionally unset
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
        clientId: 'settings-id',
        clientSecret: 'settings-secret',
      });
    });

    it('returns null when settings has no salesforce block at all', () => {
      mockSettings = {};
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toBeNull();
    });

    it.each([true, false])('user settings win over an injected provider in both builds (isOss=%s)', (isOss) => {
      setOssBuild(isOss);
      // A Salesforce provider is intentionally empty today, but if one ever appears the
      // user's typed Connected App creds must still take precedence.
      setOAuthCredentialsProvider({
        get: (p) => (p === 'salesforce' ? { clientId: 'provider-id', clientSecret: 'provider-secret' } : null),
      });
      mockSettings = { salesforce: { clientId: 'settings-id', clientSecret: 'settings-secret' } };
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
        clientId: 'settings-id',
        clientSecret: 'settings-secret',
      });
    });

    it('falls back to the provider only when env and settings are both empty', () => {
      setOAuthCredentialsProvider({
        get: (p) => (p === 'salesforce' ? { clientId: 'provider-id', clientSecret: 'provider-secret' } : null),
      });
      mockSettings = {};
      expect(resolveSalesforceCredentials(salesforceCredentialSource)).toEqual({
        clientId: 'provider-id',
        clientSecret: 'provider-secret',
      });
    });
  });
});
