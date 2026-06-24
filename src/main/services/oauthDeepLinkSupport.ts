import { app } from 'electron';

/**
 * Mirrors the protocol-registration branch in src/main/index.ts. Packaged apps
 * can receive the registered protocol normally; unpackaged Windows dev builds
 * can receive it when Electron is launched with the app path as an argument.
 */
export function isDeepLinkDeliverySupported(): boolean {
  return app.isPackaged
    || (process.platform === 'win32' && Boolean(process.defaultApp) && process.argv.length >= 2);
}
