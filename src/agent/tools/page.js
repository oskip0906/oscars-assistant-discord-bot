import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

// Pages are read straight from this machine, on behalf of anyone on Discord, so
// a URL must never reach the machine itself or its network (SearXNG on
// loopback, the router, cloud metadata). The check runs in the socket's own DNS
// lookup, so every redirect hop, and a DNS answer that changes after a first
// harmless one, is checked too.
const PRIVATE = new net.BlockList();
for (const [range, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3],
]) PRIVATE.addSubnet(range, bits, 'ipv4');
// No ::ffff:0:0/96 entry: BlockList already checks IPv4-mapped addresses against
// the IPv4 rules, and that range would match every IPv4 address.
for (const [range, bits] of [['::', 127], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) {
  PRIVATE.addSubnet(range, bits, 'ipv6');
}

const isPrivate = (address, family) => PRIVATE.check(address, family === 6 || family === 'IPv6' ? 'ipv6' : 'ipv4');
const NOT_PUBLIC = 'that address is not on the public internet';

function publicLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    // Node asks for every address at once when it races IPv4 against IPv6.
    const all = Array.isArray(address) ? address : [{ address, family }];
    if (!err && all.some((a) => isPrivate(a.address, a.family))) err = new Error(NOT_PUBLIC);
    callback(err, address, family);
  });
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_BYTES = 3 * 1024 * 1024; // past this the page is cut off, not failed
const MAX_REDIRECTS = 5;

// GET a public http(s) URL, following redirects. Resolves { url, type, body }.
export function getPublic(url, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('not an http(s) URL'));
    // An IP literal never goes through DNS, so the lookup hook would not see it.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivate(host, net.isIP(host))) return reject(new Error(NOT_PUBLIC));

    const req = (u.protocol === 'https:' ? https : http).get(
      u,
      { lookup: publicLookup, timeout: 15000, headers: { 'User-Agent': UA, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
          return resolve(getPublic(new URL(res.headers.location, u).href, hops + 1));
        }
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        let size = 0;
        const done = () => resolve({ url: u.href, type: String(res.headers['content-type'] || ''), body: Buffer.concat(chunks).toString('utf8') });
        res.on('data', (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size > MAX_BYTES) {
            res.destroy();
            done();
          }
        });
        res.on('end', done);
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

// shortcut: regex extraction, not a real parser; pages that build their text in JavaScript come back near-empty. Add a headless browser if that matters.
export function htmlToText(html) {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim());
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head|header|nav|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  // Most articles mark their own text; the menus and sidebars around it are noise.
  body = body.match(/<(main|article)\b[\s\S]*<\/\1>/i)?.[0] ?? body;
  const text = decodeEntities(
    body
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/tr|\/section|\/blockquote|\/pre)\b[^>]*>/gi, '\n')
      .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, ' '), // quoted attributes may contain >

  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
