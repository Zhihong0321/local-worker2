// Global handler: YouTube activity. Input is the company's website domain.
// Finds the YouTube channel the website itself links to, then reads that channel's public RSS feed (no key, no cost):
// the 15 newest videos with dates. TikTok and Instagram are not read; they sit behind login walls.
// Gathers only: dates and counts. Whether a channel looks abandoned is for the later step.

export const meta = {
  task: 'ALL-youtube',
  want: 'w1',
  tier: 1,
  method: 'html_rss',
  input: 'domain',
  host: 'youtube.com',
  question: 'Does the website link a YouTube channel, and when did that channel last post and how often?',
  why_it_matters: 'A channel the company advertises but stopped feeding long ago is a sign of abandoned marketing; an active one backs up claims of activity.',
  source_name: 'YouTube channel feed (linked from the company website)',
  source_url: 'https://www.youtube.com/',
  fields: ['channels', 'last_post', 'days_since_last_post', 'posts_last_90_days', 'posts_last_365_days'],
  canary: { found: 'nasa.gov', not_found: 'canary-no-such-domain.invalid' },
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const LINK = /(?:https?:)?\/\/(?:www\.|m\.)?youtube\.com\/(channel\/(UC[\w-]{22})|@[\w.%-]+|user\/[\w.%-]+|c\/[\w.%-]+)/gi;

function hostOf(input) {
  let s = String(input ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  try { s = new URL('http://' + s).hostname; } catch { /* keep as typed */ }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

function result(status, reason, records, excerpt, sourceUrl) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt ?? '') };
}

async function get(url, timeoutMs, extra = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en', ...extra }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const text = (await res.text()).slice(0, 3_000_000);
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    const cause = err?.cause?.code ?? err?.code ?? null;
    return { ok: false, status: 0, text: '', error: String(cause ?? (err?.name === 'TimeoutError' ? 'timeout' : err?.message ?? err)).slice(0, 120) };
  }
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const tag = (xml, name) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
const day = (t) => new Date(t).toISOString().slice(0, 10);

async function channelId(path) {
  const m = path.match(/^channel\/(UC[\w-]{22})/i);
  if (m) return { id: m[1] };
  const page = await get(`https://www.youtube.com/${path}`, 20_000, { cookie: 'CONSENT=YES+1; SOCS=CAI' });
  if (!page.text) return { error: page.error ?? `HTTP ${page.status}` };
  const id = page.text.match(/channel_id=(UC[\w-]{22})/)?.[1] ?? page.text.match(/"externalId":"(UC[\w-]{22})"/)?.[1] ?? page.text.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
  return id ? { id } : { error: `no channel id on the page (HTTP ${page.status})` };
}

export default async function lookup(keyword) {
  const host = hostOf(keyword);
  const source = host ? `https://${host}/` : 'https://www.youtube.com/';
  if (!host) return result('couldnt_check', 'keyword_not_a_domain', [], `The keyword "${String(keyword ?? '').slice(0, 80)}" is not a domain name, so no website was read.`, source);
  try {
    // 1. The website's own home page: which YouTube channels does it link?
    let site = null;
    const siteErrors = [];
    for (const name of [`https://${host}/`, `https://www.${host}/`]) {
      const res = await get(name, 25_000);
      if (res.text) { site = { url: name, text: res.text }; break; }
      siteErrors.push(`${name}: ${res.error ?? `HTTP ${res.status}`}`);
    }
    if (!site) {
      if (siteErrors.every((e) => /ENOTFOUND/.test(e))) return result('not_found', 'domain_does_not_resolve', [], `${host} does not resolve, so its website could not be read for a YouTube link.`, source);
      return result('couldnt_check', 'website_unreadable', [], `The website for ${host} could not be read (${siteErrors.join('; ')}), so a YouTube link could not be looked for.`, source);
    }
    const found = new Map();
    for (const m of site.text.matchAll(LINK)) {
      const path = m[1];
      const key = path.toLowerCase();
      if (!found.has(key)) found.set(key, path);
      if (found.size >= 3) break;
    }
    if (!found.size) return result('not_found', 'no_youtube_link_on_website', [], `The home page of ${host} (${site.url}) links no YouTube channel.`, site.url);

    // 2. Each channel's feed (at most two).
    const channels = [];
    const notes = [];
    const seen = new Set();
    for (const path of [...found.values()].slice(0, 3)) {
      if (channels.length >= 2) break;
      const idr = await channelId(path);
      if (!idr.id) { notes.push(`${path}: ${idr.error}`); continue; }
      if (seen.has(idr.id)) continue;
      seen.add(idr.id);
      const feed = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${idr.id}`, 20_000);
      if (!feed.ok || !/<feed\b/i.test(feed.text)) { notes.push(`${path} (${idr.id}): feed unreadable (${feed.error ?? `HTTP ${feed.status}`})`); continue; }
      const entries = [...feed.text.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((e) => ({ title: tag(e[1], 'title').slice(0, 120), published: Date.parse(tag(e[1], 'published')), id: tag(e[1], 'yt:videoId') })).filter((e) => Number.isFinite(e.published)).sort((a, b) => b.published - a.published);
      const feedHead = feed.text.split(/<entry>/i)[0];
      const now = Date.now();
      const within = (days) => entries.filter((e) => now - e.published <= days * 86_400_000).length;
      const last = entries[0]?.published ?? null;
      const span = entries.length > 1 ? (entries[0].published - entries[entries.length - 1].published) / 86_400_000 : null;
      channels.push({
        path, channel_id: idr.id, channel_url: `https://www.youtube.com/channel/${idr.id}`, title: tag(feedHead, 'title'),
        feed_videos: entries.length,
        last_post: last ? day(last) : null,
        days_since_last_post: last ? Math.floor((now - last) / 86_400_000) : null,
        posts_last_90_days: within(90), posts_last_365_days: within(365),
        average_days_between_posts: span && entries.length > 1 ? Math.round((span / (entries.length - 1)) * 10) / 10 : null,
        newest: entries.slice(0, 5).map((e) => ({ date: day(e.published), title: e.title, url: e.id ? `https://www.youtube.com/watch?v=${e.id}` : null })),
        feed_is_capped_at_15: entries.length >= 15,
      });
    }
    if (!channels.length) return result('couldnt_check', 'channel_feed_unreadable', [], `The website of ${host} links YouTube (${[...found.values()].join(', ')}) but no channel feed could be read (${notes.join('; ')}).`, site.url);

    const lines = [`YouTube channels linked from ${site.url}:`];
    for (const c of channels) {
      lines.push(`${c.title || c.path} (${c.channel_url}): ${c.feed_videos ? `last video ${c.last_post}, ${c.days_since_last_post} days ago; ${c.posts_last_90_days} videos in the last 90 days, ${c.posts_last_365_days} in the last 365${c.average_days_between_posts !== null ? `; about ${c.average_days_between_posts} days between the newest ${c.feed_videos}` : ''}` : 'the feed holds no public videos'}.`);
      for (const v of c.newest.slice(0, 3)) lines.push(`  ${v.date}  ${v.title}`);
    }
    lines.push('The feed lists only the newest 15 videos, so older history is not shown.');
    if (notes.length) lines.push(`Other links not read: ${notes.join('; ')}`);
    return result('found', null, channels, lines.join('\n'), site.url);
  } catch (err) {
    return result('couldnt_check', 'handler_error', [], `The YouTube handler hit an error: ${String(err?.message ?? err).slice(0, 200)}`, source);
  }
}
