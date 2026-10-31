export const VIRTUAL_NETWORK = {
  cidr: "10.240.0.0/16",
  gateway_suffix: 1,
  first_allocatable_ordinal: 1,
  last_allocatable_ordinal: 64767,
} as const;

/**
 * Allocate one usable host address from each /24 in the /16.
 * .0 is the subnet address, .1 is the local virtual gateway, and .255 is broadcast.
 */
export function virtualIpForOrdinal(ordinal: number): string | null {
  if (!Number.isInteger(ordinal) ||
      ordinal < VIRTUAL_NETWORK.first_allocatable_ordinal ||
      ordinal > VIRTUAL_NETWORK.last_allocatable_ordinal) return null;
  const subnet = Math.floor(ordinal / 253);
  const host = 2 + (ordinal % 253);
  return `10.240.${subnet}.${host}`;
}

export function virtualGatewayForIp(value: string): string | null {
  if (!isVirtualPrivateIp(value)) return null;
  const parts = value.split(".");
  return `10.240.${Number(parts[2])}.${VIRTUAL_NETWORK.gateway_suffix}`;
}

export function isVirtualPrivateIp(value: string): boolean {
  const match = /^(10\.240)\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  const third = Number(match[2]);
  const fourth = Number(match[3]);
  return third >= 0 && third <= 255 && fourth >= 2 && fourth <= 254;
}
