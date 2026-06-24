import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedSubscriptionOfferingsAvailable } from './managedSubscriptionOfferingsAvailable';

// Control the underlying OSS seam. The predicate is the single source of truth
// for "can this build offer Mindstone-managed subscriptions?" — today that is
// exactly "not the OSS build".
const isOssMock = vi.hoisted(() => ({ value: false }));
vi.mock('./rendererIsOss', () => ({
  rendererIsOss: () => isOssMock.value,
}));

describe('managedSubscriptionOfferingsAvailable', () => {
  afterEach(() => {
    isOssMock.value = false;
  });

  it('is available in a non-OSS (enterprise) build', () => {
    isOssMock.value = false;
    expect(managedSubscriptionOfferingsAvailable()).toBe(true);
  });

  it('is NOT available in an OSS build (no Mindstone auth/checkout backend)', () => {
    isOssMock.value = true;
    expect(managedSubscriptionOfferingsAvailable()).toBe(false);
  });
});
