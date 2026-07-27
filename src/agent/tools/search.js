import { search, searchImages, SafeSearchType } from 'duck-duck-scrape';
import { EmbedBuilder } from 'discord.js';
import { randomEmbedColor } from '../../discord/colors.js';

export const defs = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web for current information. Returns numbered titles, URLs, and snippets. Always include the relevant links (wrapped in <>) in your reply — cite sources inline or at the end.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'integer', description: 'Number of results (1-8, default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch and read the full content of a specific web page URL as clean text/markdown. Use after web_search to read a promising result, or when the user gives you a link to read/summarize. Returns the page title and readable content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL to fetch (must start with http:// or https://)' },
          max_chars: { type: 'integer', description: 'Max characters of content to return (default 6000)' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'image_search',
      description:
        'Search for images. Returns numbered results with bold titles, image URLs, and source page links in <>. Use these results verbatim in your reply. (When used as a slash command the results render as Discord embeds with a coloured left strip.)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to find pictures of' },
          count: { type: 'integer', description: 'Number of images (1-5, default 3)' },
        },
        required: ['query'],
      },
    },
  },
];

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '');
const clampCount = (n, dflt, max) => Math.min(Math.max(1, Number(n) || dflt), max);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny in-memory TTL cache so repeated identical lookups don't re-hit any
// provider (the cheapest way to never approach a rate limit).
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;
function cached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  cache.delete(key);
  return null;
}
function store(key, value) {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

async function fetchWithRetry(url, opts = {}, { retries = 2, timeoutMs = 30000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ac.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(800 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr ?? new Error('request failed');
}

const jinaHeaders = (config) => (config.jinaApiKey ? { Authorization: `Bearer ${config.jinaApiKey}` } : {});

// --- Search providers ---------------------------------------------------

// Primary: the self-hosted SearXNG metasearch instance (docker, loopback).
// It's our own server with the bot-limiter disabled, so there is no external
// rate limit at all.
async function searxngSearch(query, count, config) {
  const url = `${config.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, { retries: 1, timeoutMs: 20000 });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.results || [])
    .filter((r) => r.url)
    .slice(0, count)
    .map((r) => ({ title: stripHtml(r.title || r.url), url: r.url, snippet: stripHtml(r.content || '') }));
  if (!results.length) throw new Error('SearXNG returned no results');
  return results;
}

async function braveSearch(query, count, apiKey) {
  const res = await fetchWithRetry(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { 'X-Subscription-Token': apiKey, Accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.web?.results || []).map((r) => ({
    title: stripHtml(r.title),
    url: r.url,
    snippet: stripHtml(r.description),
  }));
  if (!results.length) throw new Error('Brave returned no results');
  return results;
}

function decodeUddg(ddgUrl) {
  const m = String(ddgUrl).match(/[?&]uddg=([^&]+)/);
  try {
    return m ? decodeURIComponent(m[1]) : ddgUrl;
  } catch {
    return ddgUrl;
  }
}

const cleanMd = (s) =>
  String(s || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // drop images
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

// Parse the markdown that Jina Reader returns for a DuckDuckGo HTML results
// page into {title,url,snippet} objects. Pure + exported for tests.
export function parseDdgMarkdown(content) {
  const results = [];
  const seen = new Set();
  const blocks = String(content || '').split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const titleMatch = block.match(/^\[([^\]]+)\]\((https:\/\/duckduckgo\.com\/l\/\?uddg=[^)]+)\)/);
    if (!titleMatch) continue;
    const url = decodeUddg(titleMatch[2]);
    if (seen.has(url)) continue;
    seen.add(url);
    const texts = [...block.matchAll(/\[([^\]]{25,})\]\(https:\/\/duckduckgo\.com\/l\//g)].map((m) => m[1]);
    const snippet = cleanMd(texts.sort((a, b) => b.length - a.length)[0] || '');
    results.push({ title: cleanMd(titleMatch[1]), url, snippet });
  }
  return results;
}

// Jina Reader fetches the DDG results page from ITS OWN ip pool, so the bot is
// never the one hitting DuckDuckGo → no client-side rate limiting.
async function jinaDdgSearch(query, config) {
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithRetry(`https://r.jina.ai/${target}`, {
    headers: { Accept: 'application/json', 'X-Retain-Images': 'none', ...jinaHeaders(config) },
  });
  if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
  const data = await res.json();
  const results = parseDdgMarkdown(data?.data?.content || '');
  if (!results.length) throw new Error('Jina/DDG returned no parseable results');
  return results;
}

async function ddgDirectSearch(query) {
  const res = await search(query, { safeSearch: SafeSearchType.MODERATE });
  if (res.noResults || !res.results?.length) throw new Error('DDG direct: no results');
  return res.results.map((r) => ({ title: stripHtml(r.title), url: r.url, snippet: stripHtml(r.description) }));
}

// --- Tools --------------------------------------------------------------

export async function webSearch({ query, count }, invocation) {
  const n = clampCount(count, 5, 8);
  const key = `search:${query}`;
  let results = cached(key);

  if (!results) {
    const providers = [];
    if (invocation.config.searxngUrl) providers.push(['searxng', () => searxngSearch(query, n, invocation.config)]);
    if (invocation.config.braveApiKey) providers.push(['brave', () => braveSearch(query, n, invocation.config.braveApiKey)]);
    providers.push(['jina/ddg', () => jinaDdgSearch(query, invocation.config)]);
    providers.push(['ddg-direct', () => ddgDirectSearch(query)]);

    const errors = [];
    for (const [name, run] of providers) {
      try {
        results = await run();
        if (results?.length) {
          store(key, results);
          break;
        }
      } catch (err) {
        errors.push(`${name}: ${String(err.message || err).slice(0, 80)}`);
        results = null;
      }
    }
    if (!results?.length) {
      return `No web results for "${query}" (all providers failed: ${errors.join(' | ')}).`;
    }
  }

  // URLs are wrapped in <> — Discord's embed-suppression syntax. Keep them
  // wrapped when citing links in replies.
  return results
    .slice(0, n)
    .map((r, i) => `${i + 1}. ${r.title}\n<${r.url}>${r.snippet ? `\n${r.snippet}` : ''}`)
    .join('\n\n');
}

export async function webFetch({ url, max_chars }, invocation) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return 'Provide a full URL starting with http:// or https://';
  const cap = clampCount(max_chars, 6000, 20000);
  const key = `fetch:${target}`;
  let payload = cached(key);

  if (!payload) {
    try {
      const res = await fetchWithRetry(`https://r.jina.ai/${target}`, {
        headers: { Accept: 'application/json', 'X-Retain-Images': 'none', ...jinaHeaders(invocation.config) },
      });
      if (!res.ok) return `Couldn't fetch that page (HTTP ${res.status}).`;
      const data = await res.json();
      payload = {
        title: data?.data?.title || target,
        url: data?.data?.url || target,
        content: data?.data?.content || '',
      };
      if (!payload.content) return `Fetched ${target} but it had no readable content.`;
      store(key, payload);
    } catch (err) {
      return `Failed to fetch ${target}: ${String(err.message || err).slice(0, 150)}`;
    }
  }

  const body = payload.content.slice(0, cap);
  return `# ${payload.title}\n<${payload.url}>\n\n${body}${payload.content.length > cap ? '\n…(truncated)' : ''}`;
}

async function searxngImages(query, config) {
  const url = `${config.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=images&safesearch=1`;
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/json' } }, { retries: 1, timeoutMs: 20000 });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  const data = await res.json();
  const results = (data.results || [])
    .filter((r) => r.img_src)
    .map((r) => ({ title: r.title || 'image', image: r.img_src, source: r.url || '' }));
  if (!results.length) throw new Error('SearXNG: no images');
  return results;
}

// --- Image search --------------------------------------------------------

export async function imageSearch({ query, count }, invocation) {
  const n = clampCount(count, 3, 5);
  const key = `img:${query}`;
  let results = cached(key);
  if (!results) {
    // Primary: self-hosted SearXNG (no rate limit); fall back to DDG images.
    try {
      results = await searxngImages(query, invocation.config);
      store(key, results);
    } catch {
      try {
        const res = await searchImages(query, { safeSearch: SafeSearchType.MODERATE });
        if (res.noResults || !res.results?.length) return `No images found for "${query}".`;
        results = res.results.map((r) => ({ title: r.title || 'image', image: r.image, source: r.url || '' }));
        store(key, results);
      } catch (err) {
        return `Image search failed for "${query}": ${String(err.message || err).slice(0, 120)}`;
      }
    }
  }

  const items = results.slice(0, n);

  // Build one Discord embed per result, following the menu.js pattern:
  // randomEmbedColor() provides the left coloured strip; setImage() embeds
  // the image natively large and clickable; the title sits on top as a
  // description; setURL() makes the title a clickable link to the source.
  const embeds = items.map((r) => {
    const embed = new EmbedBuilder()
      .setColor(randomEmbedColor())
      .setTitle(r.title || 'Image');
    if (r.image) embed.setImage(r.image);
    if (r.source) {
      embed.setURL(r.source);
      try {
        embed.setFooter({ text: new URL(r.source).hostname });
      } catch {
        embed.setFooter({ text: r.source });
      }
    }
    return embed;
  });

  // Plain-text representation for the model (the agent path feeds tool
  // results into the model, which needs readable text to work with).
  const text = items
    .map((r, i) => {
      const lines = [`${i + 1}. **${r.title}**`, r.image];
      if (r.source) lines.push(`*Source:* <${r.source}>`);
      return lines.join('\n');
    })
    .join('\n\n');

  return { embeds, text };
}
