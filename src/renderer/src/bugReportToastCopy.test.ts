import { describe, expect, it } from 'vitest';
import { bugReportStatusToastCopy } from './bugReportToastCopy';

describe('bugReportStatusToastCopy', () => {
  it('maps status queued to the quietly-confident positive copy (the one positive toast)', () => {
    const toast = bugReportStatusToastCopy({ status: 'queued' });
    expect(toast).toEqual({
      title: 'Got it',
      description: 'Your report is safe with Rebel, and on its way to the team.',
      variant: 'success',
    });
    // No recovery action on the happy path.
    expect(toast?.action).toBeUndefined();
  });

  it('maps status delivered to null (silent upgrade — no second toast)', () => {
    // Confirmed 2xx must NOT fire a second toast: the queued toast already
    // reassured; another would be noise and undermine the first.
    expect(bugReportStatusToastCopy({ status: 'delivered' })).toBeNull();
  });

  describe('delivery-unavailable (warning, 12s, Copy-report affordance)', () => {
    const LOCKED_TITLE = "Saved, but we couldn't reach the team yet";
    const LOCKED_BODY =
      "Your report is safe on this device and Rebel will keep trying. If it's urgent, copy it and send it to us directly, or post it in the Rebels community.";
    const OSS_LOCKED_TITLE = 'Saved on your device';
    const OSS_LOCKED_BODY =
      'In the open build, reports stay on your device for now. To share this one, copy it and post it in the Rebels community.';

    it("maps reason 'no-dsn' to the locked recovery copy with a Copy-report action", () => {
      const toast = bugReportStatusToastCopy({ status: 'delivery-unavailable', reason: 'no-dsn' });
      expect(toast).not.toBeNull();
      expect(toast?.title).toBe(LOCKED_TITLE);
      expect(toast?.description).toBe(LOCKED_BODY);
      expect(toast?.variant).toBe('warning');
      expect(toast?.duration).toBe(12000);
      expect(toast?.action).toBe('copy-report');
      // A packaged build missing its DSN must NOT be described as dev-mode, and
      // the copy must never leak enum/dev-mode internals.
      expect(toast?.description).not.toContain('development');
      expect(toast?.description).not.toContain('SENTRY_ENABLED');
      expect(toast?.description).not.toContain('dev mode');
    });

    it("maps reason 'env-disabled' to the same locked recovery copy", () => {
      const toast = bugReportStatusToastCopy({ status: 'delivery-unavailable', reason: 'env-disabled' });
      expect(toast?.title).toBe(LOCKED_TITLE);
      expect(toast?.description).toBe(LOCKED_BODY);
      expect(toast?.variant).toBe('warning');
      expect(toast?.duration).toBe(12000);
      expect(toast?.action).toBe('copy-report');
    });

    it("maps reason 'dead-letter' (retries exhausted) to the same locked recovery copy", () => {
      const toast = bugReportStatusToastCopy({ status: 'delivery-unavailable', reason: 'dead-letter' });
      expect(toast?.title).toBe(LOCKED_TITLE);
      expect(toast?.description).toBe(LOCKED_BODY);
      expect(toast?.variant).toBe('warning');
      expect(toast?.duration).toBe(12000);
      expect(toast?.action).toBe('copy-report');
    });

    it("maps reason 'oss-egress-unavailable' to the open-build local-only copy", () => {
      const toast = bugReportStatusToastCopy({
        status: 'delivery-unavailable',
        reason: 'oss-egress-unavailable',
      });
      expect(toast?.title).toBe(OSS_LOCKED_TITLE);
      expect(toast?.description).toBe(OSS_LOCKED_BODY);
      expect(toast?.variant).toBe('warning');
      expect(toast?.duration).toBe(12000);
      expect(toast?.action).toBe('copy-report');
      expect(toast?.description).not.toContain('SENTRY_ENABLED');
      expect(toast?.description).not.toContain('DSN');
      expect(toast?.description).not.toContain('dev mode');
      expect(toast?.description).not.toContain('development');
    });

    it('maps delivery-unavailable with no reason to the same locked recovery copy', () => {
      const toast = bugReportStatusToastCopy({ status: 'delivery-unavailable' });
      expect(toast?.title).toBe(LOCKED_TITLE);
      expect(toast?.variant).toBe('warning');
      expect(toast?.duration).toBe(12000);
      expect(toast?.action).toBe('copy-report');
    });

    it('mentions the Rebels community in the recovery copy', () => {
      const toast = bugReportStatusToastCopy({ status: 'delivery-unavailable', reason: 'dead-letter' });
      expect(toast?.description).toContain('Rebels community');
    });
  });

  it('maps status failed to the durable-save-failed error copy', () => {
    expect(bugReportStatusToastCopy({ status: 'failed' })).toEqual({
      title: "Couldn't save your report",
      description:
        'Something went wrong saving it. Please try again, or copy it and contact us directly.',
      variant: 'error',
    });
  });

  it('uses no em-dashes anywhere in the copy (brand rule)', () => {
    const statuses = [
      { status: 'queued' },
      { status: 'delivery-unavailable', reason: 'no-dsn' },
      { status: 'delivery-unavailable', reason: 'dead-letter' },
      { status: 'delivery-unavailable', reason: 'oss-egress-unavailable' },
      { status: 'failed' },
    ];
    for (const data of statuses) {
      const toast = bugReportStatusToastCopy(data);
      expect(toast).not.toBeNull();
      expect(toast?.title).not.toContain('—');
      expect(toast?.description).not.toContain('—');
    }
  });

  it('returns null for unknown / legacy statuses (no misleading toast)', () => {
    // Old vocabulary (sent / sentry-disabled / gathering) is gone; forward-compat
    // default must no-op rather than show a stale toast.
    expect(bugReportStatusToastCopy({ status: 'sent' })).toBeNull();
    expect(bugReportStatusToastCopy({ status: 'sentry-disabled', reason: 'no-dsn' })).toBeNull();
    expect(bugReportStatusToastCopy({ status: 'gathering' })).toBeNull();
    expect(bugReportStatusToastCopy({ status: 'in-progress' })).toBeNull();
    expect(bugReportStatusToastCopy({ status: '' })).toBeNull();
  });
});
