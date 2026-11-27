// Which addresses web_fetch may reach: the public internet only. An allow rule for IPv6 (global
// unicast 2000::/3) and deny rules for everything special in IPv4, so a block that is missing
// from a list fails closed for IPv6. IPv4-mapped IPv6 addresses are judged as the IPv4 inside.
import net from 'node:net';

/** Special-purpose IPv4 blocks (RFC 6890 and successors): none of them is the public internet. */
const V4_SPECIAL: readonly [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((n, p) => ((n << 8) | Number(p)) >>> 0, 0);
}

export function isPublicIPv4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return false;
  return !V4_SPECIAL.some(([base, bits]) => ((n ^ v4ToInt(base)!) >>> (32 - bits)) === 0);
}

/** The eight 16-bit groups of an IPv6 address (embedded IPv4 and a zone allowed), or null. */
export function parseIPv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[2]!);
    if (n === null) return null;
    s = `${v4[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  const groups = (h: string | undefined) => (h ? h.split(':').map(g => parseInt(g, 16)) : []);
  const head = groups(halves[0]);
  const tail = halves.length > 1 ? groups(halves[1]) : [];
  const all = halves.length > 1 ? [...head, ...Array<number>(8 - head.length - tail.length).fill(0), ...tail] : head;
  return all.length === 8 && all.every(g => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

export function isPublicIPv6(ip: string): boolean {
  const g = parseIPv6(ip);
  if (!g) return false;
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isPublicIPv4(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`);
  if ((g[0]! & 0xe000) !== 0x2000) return false; // only global unicast 2000::/3
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0x0db8 || (g[1]! & 0xfe00) === 0)) return false; // 2001::/23: IETF protocol assignments (Teredo, benchmarking, ORCHID, …); documentation
  if (g[0] === 0x2002) return false; // 6to4: an IPv4 address inside, possibly a private one
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false; // documentation 3fff::/20
  return true;
}

/** Whether `ip` is an address on the public internet. Not an IP address: false. */
export function isPublicAddress(ip: string): boolean {
  const kind = net.isIP(ip.replace(/%.*$/, ''));
  return kind === 4 ? isPublicIPv4(ip) : kind === 6 ? isPublicIPv6(ip) : false;
}
