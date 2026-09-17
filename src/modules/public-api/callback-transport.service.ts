import { BadRequestException, Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';

const blocked = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(ip, bits, 'ipv4');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
export function isPublicAddress(address: string) {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, 'ipv4')
    : family === 6 &&
        globalV6.check(address, 'ipv6') &&
        !blocked.check(address, 'ipv6');
}
export function callbackUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('Invalid callback URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    raw.length > 2048 ||
    url.protocol !== 'https:' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    (isIP(host) && !isPublicAddress(host))
  )
    throw new BadRequestException('Callback URL not allowed');
  return url;
}
@Injectable()
export class CallbackTransport {
  async resolve(raw: string) {
    const url = callbackUrl(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let timer: NodeJS.Timeout;
    try {
      const addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await Promise.race([
            lookup(host, { all: true, verbatim: true }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), 2000);
            }),
          ]);
      if (
        !addresses.length ||
        addresses.some((item) => !isPublicAddress(item.address))
      )
        throw new BadRequestException('Callback address not allowed');
      return {
        url,
        address: addresses[0].address,
        family: addresses[0].family,
      };
    } finally {
      clearTimeout(timer);
    }
  }
  async send(raw: string, body: string, headers: Record<string, string>) {
    const pinned = await this.resolve(raw);
    if (Buffer.byteLength(body) > 16384)
      throw new Error('CALLBACK_PAYLOAD_TOO_LARGE');
    await new Promise<void>((resolve, reject) => {
      // DNS is never repeated by the socket; TLS still verifies the URL hostname.
      const req = request(
        pinned.url,
        {
          method: 'POST',
          agent: false,
          headers: {
            ...headers,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body).toString(),
          },
          lookup: ((_host: string, options: any, done: any) =>
            options.all
              ? done(null, [{ address: pinned.address, family: pinned.family }])
              : done(null, pinned.address, pinned.family)) as any,
        },
        (res) => {
          let bytes = 0;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536)
              req.destroy(new Error('CALLBACK_RESPONSE_TOO_LARGE'));
          });
          res.on('error', reject);
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve();
            else reject(new Error('CALLBACK_HTTP_REJECTED'));
          });
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error('CALLBACK_TIMEOUT')),
        5000,
      );
      req.on('error', reject);
      req.on('close', () => clearTimeout(timer));
      req.end(body);
    });
  }
}
