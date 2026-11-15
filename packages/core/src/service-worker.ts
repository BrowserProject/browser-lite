import type { ServiceWorkerOption, WarningCode } from './types.js';

/**
 * The worker of the `serviceWorker` option, registered (or taken) once per browser: media files
 * go through media-sw.js, downloads through download-sw.js. Null, after a `sw-missing` warning,
 * when there is none or it fails.
 */
export async function registerServiceWorker(
  option: ServiceWorkerOption | undefined,
  warn: (code: WarningCode, message: string) => void,
): Promise<ServiceWorkerRegistration | null> {
  const missing = 'media files do not play and downloads are kept in memory';
  if (!option) {
    warn('sw-missing', `No service worker given (serviceWorker option): ${missing}`);
    return null;
  }
  if (!('serviceWorker' in navigator)) {
    warn('sw-missing', `Service workers are not available: ${missing}`);
    return null;
  }
  try {
    const registration =
      'registration' in option
        ? option.registration
        : await navigator.serviceWorker.register(
            option.url,
            option.scope ? { scope: option.scope } : {},
          );
    // On the first visit the worker controls the page only after clients.claim(). Firefox also
    // leaves later visits of a cross-origin isolated page uncontrolled: the worker claims it on
    // request (media-sw.js).
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        navigator.serviceWorker.addEventListener(
          'controllerchange',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        registration.active?.postMessage({ bl: 'claim' });
      });
    if (!navigator.serviceWorker.controller) {
      warn(
        'sw-missing',
        'The service worker does not control this page (scope or clients.claim): media files do not play',
      );
    }
    return registration;
  } catch (error) {
    warn('sw-missing', `Service worker failed: ${(error as Error)?.message ?? error}: ${missing}`);
    return null;
  }
}
