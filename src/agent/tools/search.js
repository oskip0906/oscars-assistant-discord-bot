import { EmbedBuilder } from 'discord.js';
import { randomEmbedColor } from '../../discord/colors.js';
import { getPublic, htmlToText } from './page.js';

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
        'Search Google Images for pictures and return numbered results with bold titles, full-size image URLs, and source page links.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to find pictures of' },
          count: { type: 'integer', description: 'Number of images (1-3, default 3)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'video_search',
      description: 'Search YouTube for videos. Returns numbered titles, video URLs, and descriptions.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to find videos about' },
          count: { type: 'integer', description: 'Number of videos (1-8, default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'news_search',
      description: 'Search recent news articles. Returns numbered headlines, URLs, and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'News topic' },
          count: { type: 'integer', description: 'Number of articles (1-8, default 5)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wiki_search',
      description: 'Search Wikipedia. Returns numbered article titles, URLs, and summaries.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Topic to look up' },
          count: { type: 'integer', description: 'Number of articles (1-8, default 3)' },
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

// Quick HEAD check to validate an image URL is actually reachable.
async function headOk(url, timeoutMs = 5000) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(url, { method: 'HEAD', signal: ac.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// --- Search providers ---------------------------------------------------

// One main engine plus two fallbacks for general web search, tried in order
// when the previous one errors or comes back empty.
const WEB_ENGINES = ['bing', 'yahoo', 'mojeek'];
// One dedicated engine each for the other kinds of search.
const IMAGE_ENGINE = 'google images';
const VIDEO_ENGINE = 'youtube';
const NEWS_ENGINE = 'bing news';
const WIKI_ENGINE = 'wikipedia';

// The self-hosted SearXNG metasearch instance (docker, loopback) is the only
// provider. It's our own server with the bot-limiter disabled, so there is no
// external rate limit at all.
async function searxngQuery(query, { engines, categories }, config, headers = { Accept: 'application/json' }) {
  const url = `${config.searxngUrl}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1&engines=${encodeURIComponent(engines)}${categories ? `&categories=${categories}` : ''}`;
  const res = await fetchWithRetry(url, { headers }, { retries: 1, timeoutMs: 20000 });
  if (!res.ok) throw new Error(`SearXNG HTTP ${res.status}`);
  return res.json();
}

const failingEngines = (data) => (data.unresponsive_engines || []).map(([name, why]) => `${name}: ${why}`).join(', ');

async function searxngSearch(query, count, config, { engines = WEB_ENGINES, categories } = {}) {
  const errors = [];
  for (const engine of engines) {
    try {
      const data = await searxngQuery(query, { engines: engine, categories }, config);
      const results = (data.results || [])
        .filter((r) => r.url)
        .slice(0, count)
        .map((r) => ({ title: stripHtml(r.title || r.url), url: r.url, snippet: stripHtml(r.content || '') }));
      if (results.length) return results;
      // Name why the engine failed (blocked, CAPTCHA, timeout), so "no results"
      // says why in the logs and to the model.
      errors.push(`${engine}: ${failingEngines(data) || 'no results'}`);
    } catch (err) {
      errors.push(`${engine}: ${err.message}`);
    }
  }
  console.warn(`[search] no results for "${query.slice(0, 80)}"; ${errors.join('; ')}`);
  throw new Error(`SearXNG returned no results (${errors.join('; ')})`);
}

// --- Tools --------------------------------------------------------------

// Structured search: SearXNG plus the cache, without the model-facing
// formatting. webSearch renders this; deep research consumes it directly.
export async function searchResults(query, count, config) {
  const key = `search:${query}`;
  const hit = cached(key);
  if (hit) return hit.slice(0, count);
  return store(key, await searxngSearch(query, count, config)).slice(0, count);
}

// URLs are wrapped in <> — Discord's embed-suppression syntax. Keep them
// wrapped when citing links in replies.
const formatResults = (results) =>
  results.map((r, i) => `${i + 1}. ${r.title}\n<${r.url}>${r.snippet ? `\n${r.snippet}` : ''}`).join('\n\n');

export async function webSearch({ query, count }, invocation) {
  const n = clampCount(count, 5, 8);
  try {
    return formatResults(await searchResults(query, n, invocation.config));
  } catch (err) {
    return `No web results for "${query}" (${err.message}).`;
  }
}

// Single-engine searches: video, news and wiki each have one dedicated engine.
async function kindSearch(kind, engine, categories, dflt, { query, count }, invocation) {
  const n = clampCount(count, dflt, 8);
  const key = `${kind}:${query}`;
  let results = cached(key);
  if (!results) {
    try {
      results = store(key, await searxngSearch(query, 8, invocation.config, { engines: [engine], categories }));
    } catch (err) {
      return `No ${kind} results for "${query}" (${err.message}).`;
    }
  }
  return formatResults(results.slice(0, n));
}

export const videoSearch = (args, invocation) => kindSearch('video', VIDEO_ENGINE, 'videos', 5, args, invocation);
export const newsSearch = (args, invocation) => kindSearch('news', NEWS_ENGINE, 'news', 5, args, invocation);
export const wikiSearch = (args, invocation) => kindSearch('wiki', WIKI_ENGINE, 'general', 3, args, invocation);

// Structured page fetch: returns { title, url, content } or throws with a
// human-readable reason. webFetch renders this; research consumes it directly.
export async function fetchPage(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('not an http(s) URL');
  const key = `fetch:${target}`;
  const hit = cached(key);
  if (hit) return hit;

  const page = await getPublic(target);
  if (page.type && !/html|xml|text|json/i.test(page.type)) throw new Error(`not a web page (${page.type.split(';')[0]})`);
  const { title, text } = /html|xml/i.test(page.type) || /^\s*</.test(page.body) ? htmlToText(page.body) : { title: '', text: page.body.trim() };
  if (!text) throw new Error('no readable content');
  return store(key, { title: title || target, url: page.url, content: text });
}

export async function webFetch({ url, max_chars }, invocation) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return 'Provide a full URL starting with http:// or https://';
  const cap = clampCount(max_chars, 6000, 20000);
  let payload;
  try {
    payload = await fetchPage(target);
  } catch (err) {
    const reason = String(err.message || err);
    if (/^HTTP /.test(reason)) return `Couldn't fetch that page (${reason}).`;
    if (reason === 'no readable content') return `Fetched ${target} but it had no readable content.`;
    return `Failed to fetch ${target}: ${reason.slice(0, 150)}`;
  }

  const body = payload.content.slice(0, cap);
  return `# ${payload.title}\n<${payload.url}>\n\n${body}${payload.content.length > cap ? '\n…(truncated)' : ''}`;
}

// --- Image search (Google Images via SearXNG) ---------------------------

// Google-realistic desktop headers so the upstream Google engine sees a
// normal browser request through SearXNG.
const googleUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const googleHeaders = {
  'Accept': 'application/json',
  'User-Agent': googleUA,
  'Accept-Language': 'en-US,en;q=0.9',
};

async function searxngImages(query, config) {
  const data = await searxngQuery(query, { engines: IMAGE_ENGINE, categories: 'images' }, config, googleHeaders);
  const raw = (data.results || []).filter((r) => r.img_src);
  if (!raw.length) throw new Error('SearXNG: no images');

  // Validate image URLs with parallel HEAD checks; drop any that are
  // unreachable and fall through to the next result.
  const checks = await Promise.allSettled(
    raw.map(async (r) => {
      if (await headOk(r.img_src)) {
        return { title: r.title || 'image', image: r.img_src, source: r.url || '' };
      }
      return null;
    }),
  );
  const results = checks
    .filter((c) => c.status === 'fulfilled' && c.value !== null)
    .map((c) => c.value);
  if (!results.length) throw new Error('SearXNG: all image URLs unreachable');
  return results;
}

export async function imageSearch({ query, count }, invocation) {
  const n = clampCount(count, 3, 3);
  const key = `img:${query}`;
  let results = cached(key);
  if (!results) {
    try {
      results = await searxngImages(query, invocation.config);
      store(key, results);
    } catch (err) {
      return `Image search backend (SearXNG) is unreachable — check SEARXNG_URL and that the "google images" engine is enabled. (${err.message})`;
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
