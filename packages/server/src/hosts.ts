import net from 'node:net';

/**
 * Check of the `Host` header against DNS rebinding: IP addresses and `localhost` always pass,
 * names only when listed in `hosts` (an entry starting with `.` matches every name ending with
 * it). Returns a function that takes the header.
 */
export function hostCheck(hosts: readonly string[]): (header: string | undefined) => boolean {
  const names = hosts.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return (header) => {
    const host = (header ?? '').toLowerCase();
    const ipv6 = /^\[(.*)\](?::\d*)?$/.exec(host);
    if (ipv6) return net.isIPv6(ipv6[1] as string);
    const name = host.replace(/:\d*$/, '');
    return (
      net.isIPv4(name) ||
      name === 'localhost' ||
      names.some((entry) => (entry.startsWith('.') ? name.endsWith(entry) : name === entry))
    );
  };
}
