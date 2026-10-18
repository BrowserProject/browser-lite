import type { HostService } from '../types.js';
import { AudioService } from './audio.js';
import { CaptureService } from './capture.js';
import { type DevicesOptions, DevicesService } from './devices.js';
import { MediaService } from './media.js';
import { WebRTCService } from './webrtc.js';

/** Web Audio of the pages through an AudioWorklet of the host. */
export function audio(): HostService {
  return new AudioService();
}

/**
 * `<video>` and `<audio>` of the pages through hidden media elements of the host. Needs the
 * `serviceWorker` option (media-sw.js) for media files. Picture-in-picture is on by default.
 */
export function media(options?: { pictureInPicture?: boolean }): HostService {
  return new MediaService(options?.pictureInPicture !== false);
}

/** Camera, microphone and screen capture through the devices of the host. */
export function capture(): HostService {
  return new CaptureService();
}

/**
 * WebRTC of the pages through RTCPeerConnection of the host. Opt-in: the connections bypass
 * the transport and reveal the IP address of the device to the remote side.
 */
export function webrtc(): HostService {
  return new WebRTCService();
}

/**
 * Devices and platform APIs (geolocation, sensors, gamepads, speech, notifications, file system
 * access, navigator.clipboard, eyedropper, battery, keyboard, network information, image decoder,
 * touch input). Every part is on unless set to false; `notifications` also takes a handler.
 */
export function devices(options?: DevicesOptions): HostService {
  return new DevicesService(options);
}

/** The services of a browser without options: audio(), media(), capture(), devices(). */
export function defaultServices(): HostService[] {
  return [audio(), media(), capture(), devices()];
}
