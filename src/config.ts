// Local environment constants — standalone replacement for the monorepo's
// @config/environment package (config/environment/src/host.ts + src/port.ts),
// which cannot be published to npm. Keep in sync with the monorepo originals;
// the constant names are unchanged so imports are a drop-in swap.

// Standard local area network host name (config/environment/src/host.ts).
export const LOCAL_AREA_NETWORK_HOST_NAME = '192.168.8.128';

// List of ports available (config/environment/src/port.ts).
export const LOCAL_AREA_NETWORK_DATABASE_PORT = 5000;
export const LOCAL_AREA_NETWORK_STORYBOARD_PORT = 5252;
export const LOCAL_AREA_NETWORK_PROVIDER_PORT = 5500;
