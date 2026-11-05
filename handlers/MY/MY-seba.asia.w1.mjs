export const meta = {
  task: 'MY-seba.asia',
  want: 'w1',
  tier: 1,
  method: 'static_list',
  input: 'company name',
  fields: ['name', 'edition', 'award', 'entrepreneur', 'website'],
  canary: { found: 'MANDRILL TECH SDN BHD', not_found: 'Dezeno' },
};

const PAGE = 'https://seba.asia/past-winners/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const STOP = new Set(['the','a','an','and','of','for','sdn','bhd','berhad','plc','m','my','malaysia','co','company','ltd','limited','enterprise','enterprises','corp','corporation','inc','award','awards','awardee','awardees','winner','winners','seba']);
const GENERIC = new Set(['group','groups','holding','holdings','technology','technologies','solution','solutions','service','services','system','systems','logistics','shipping','transport','trading','trade','engineering','resources','venture','ventures','global','international','management','construction','healthcare','health','dental','clinic','centre','center','media','agency','consulting','consultancy','design','printing','print','food','foods','bistro','cafe','restaurant','event','events','digital','marketing','business','industries','industrial','supply','supplies','academy','education','learning','tuition','tuisyen','property','properties','realty','nutrition','wellness','care','beauty','fashion','network','networks','capital','finance','financial','advisory','advisor','advisors','security','automotive','motor','electrical','hardware','software','data','smart']);
const JUNK = /^(awardees?|boa|img|image|logo|untitled|artboard|picture|photo)\s*\d*$/i;

function dec(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#0*38;/g, '&').replace(/&#821[0-9];/g, '-')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)));
}
const txt = (h) => dec(String(h || '').replace(/<\/?br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const parts = (h) => String(h || '').split(/<\/?br\s*\/?>/i).map(txt).filter(Boolean);
const norm = (s) => dec(String(s || '')).replace(/[\u2018\u2019\u201c\u201d]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().toLowerCase();
const toks = (s) => norm(s).split(' ').filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t));
const conc = (s) => norm(s).replace(/ /g, '');
const cap = (s) => String(s || '').replace(/\s+/g, ' ').trim().replace(/\b([a-z0-9])([a-z0-9]*)/g, (m, a, b) => (/[0-9]/.test(m) ? m.toUpperCase() : a.toUpperCase() + b));

function altName(alt) {
  let s = dec(alt).replace(/([a-z])([A-Z])/g, '$1 $2');
  s = s.replace(/^(awardees?|boa)\s*[\dA-Za-z]*\s*[_\-. ]*/i, '');
  return s.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function slugOf(p) {
  return String(p || '').replace(/\/+$/, '').split('/').filter(Boolean).pop().replace(/-\d+$/, '').replace(/[-_]+/g, ' ').trim() || '';
}
function domainOf(href) {
  try {
    const u = new URL(href, PAGE);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const ls = host.split('.');
    let core = ls.slice(0, -1).join('');
    if (ls.length >= 3 && /^(com|net|org|co|gov|edu)$/i.test(ls[ls.length - 2])) core = ls.slice(0, -2).join('');
    return { host, core, self: /(^|\.)seba\.asia$/i.test(host) };
  } catch {
    return { host: '', core: '', self: false };
  }
}

function parse(html) {
  if (!html || html.length < 50000) return null;
  if (!/Past Winners/i.test(html) || !/TOP COMPANIES/i.test(html)) return null;
  const ev = [];
  for (const m of html.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = txt(m[2]);
    if (t) ev.push({ pos: m.index, k: 'h', lv: Number(m[1]), t });
  }
  const tabs = new Map();
  for (const m of html.matchAll(/elementor-tab-title-\d+"[^>]*data-tab="(\d+)"[^>]*>([^<]*)</gi)) if (!tabs.has(m[1])) tabs.set(m[1], txt(m[2]));
  for (const m of html.matchAll(/elementor-tab-content[^>]*data-tab="(\d+)"/gi)) {
    const t = tabs.get(m[1]);
    if (t) ev.push({ pos: m.index, k: 'tab', t });
  }
  for (const m of html.matchAll(/<figcaption[^>]*gallery-caption[^>]*>([\s\S]*?)<\/figcaption>/gi)) ev.push({ pos: m.index, k: 'cap', raw: m[1] });
  const logos = [...html.matchAll(/class="pksl-single-logo-items/gi)].map((m) => m.index);
  for (let i = 0; i < logos.length; i++) ev.push({ pos: logos[i], k: 'logo', end: i + 1 < logos.length ? logos[i + 1] : logos[i] + 3000 });
  ev.sort((a, b) => a.pos - b.pos);

  let h1 = '';
  let sub = [];
  const out = [];
  for (const e of ev) {
    if (e.k === 'h' || e.k === 'tab') {
      if (e.k === 'tab' || e.lv === 1) {
        h1 = e.t;
        sub = [];
      } else if (e.lv <= 3) {
        sub = sub.slice(0, e.lv - 2);
        sub[e.lv - 2] = e.t;
        sub = sub.filter(Boolean);
      }
      continue;
    }
    const where = [h1, ...sub].filter(Boolean).join(' / ');
    if (e.k === 'cap') {
      const strong = (e.raw.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i) || [])[1] || '';
      const sl = parts(strong);
      const smalls = [...e.raw.matchAll(/<small[^>]*>([\s\S]*?)<\/small>/gi)].map((m) => txt(m[1])).filter(Boolean);
      const outside = txt(e.raw.replace(/<strong[^>]*>[\s\S]*?<\/strong>/i, ' ').replace(/<small[^>]*>[\s\S]*?<\/small>/gi, ' '));
      const person = sl[0] || outside || '';
      let co = sl.slice(1);
      let aw = smalls;
      if (!co.length && smalls.length >= 2) {
        co = [smalls[0]];
        aw = smalls.slice(1);
      }
      const company = co.join(' ').trim();
      const award = [...aw, sl.length >= 2 ? outside : ''].filter(Boolean).join(' / ').replace(/\s*presented by\b[\s\S]*$/i, '').trim();
      const name = company || person;
      if (!name) continue;
      out.push({ type: 'award', name, entrepreneur: company ? person : '', award, edition: where, cands: [company, person, ...sl].filter(Boolean), website: '', link: '', raw: txt(e.raw) });
      continue;
    }
    const b = html.slice(e.pos, e.end);
    const title = (b.match(/^[^>]*?\btitle="([^"]*)"/) || [])[1] || '';
    const href = (b.match(/<a\s[^>]*href="([^"]*)"/i) || [])[1] || '';
    const alt = (b.match(/<img[^>]*\balt="([^"]*)"/i) || [])[1] || '';
    const a = altName(alt);
    const aOk = a && !JUNK.test(a.replace(/\s/g, '')) && /[A-Za-z]{2}/.test(a);
    const cands = [];
    let website = '';
    let pageLink = '';
    if (title.trim()) cands.push(dec(title).trim());
    if (aOk) cands.push(a);
    if (href) {
      const d = domainOf(href);
      if (d.self) {
        const s = slugOf(new URL(href, PAGE).pathname);
        if (s) {
          cands.push(s);
          pageLink = new URL(href, PAGE).href;
        }
      } else if (d.core) {
        cands.push(d.core);
        website = 'https://' + d.host + '/';
      }
    }
    if (!cands.length) continue;
    const name = (title.trim() && dec(title).trim()) || (aOk && cap(a)) || (website ? website.replace(/^https:\/\//, '').replace(/\/$/, '') : '') || cap(slugOf(pageLink.replace(PAGE, '')) || cands[0]);
    out.push({ type: 'awardee logo', name, edition: where, award: '', entrepreneur: '', cands: cands.filter(Boolean), website, link: pageLink || website, alt: dec(alt), title: dec(title) });
  }
  return out;
}

function score(kw, c) {
  const kt = toks(kw);
  const kc = conc(kw);
  if (!kt.length && !kc) return 0;
  for (const x of c.cc) if (x && x === kc) return 100;
  for (const x of c.cc) if (x && x.length >= 6 && kc.length >= 6 && (x.includes(kc) || kc.includes(x))) return 85;
  if (kt.length) {
    let hit = 0;
    for (const t of kt) {
      let ok = c.tk.has(t);
      if (!ok && t.length >= 4) ok = c.cc.some((x) => x.includes(t));
      if (ok) hit++;
    }
    if (hit === kt.length) return 80;
    const brand = kt[0];
    if (brand && brand.length >= 3 && !GENERIC.has(brand) && c.tk.has(brand)) return 60;
  }
  return 0;
}

export default async function lookup(keyword) {
  const res0 = { status: 'couldnt_check', reason: '', records: [], source_url: PAGE, excerpt: '' };
  const kw = String(keyword || '').trim();
  if (!kw) {
    res0.reason = 'other';
    return res0;
  }
  let resp;
  let html;
  try {
    resp = await fetch(PAGE, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-MY,en;q=0.9' },
    });
  } catch (err) {
    const n = (err && err.name) || '';
    res0.reason = n === 'TimeoutError' || n === 'AbortError' ? 'timeout' : 'other';
    res0.excerpt = 'GET ' + PAGE + ' failed: ' + String((err && err.message) || err).slice(0, 150);
    return res0;
  }
  try {
    html = await resp.text();
  } catch {
    res0.reason = 'http_error';
    return res0;
  }
  if (resp.status !== 200) {
    const ch = /just a moment|cf-chl|checking your browser|captcha|are you a robot|access denied|forbidden/i.test(html.slice(0, 4000));
    res0.reason = ch || [401, 403, 429, 503].includes(resp.status) ? 'blocked' : 'http_error';
    res0.excerpt = 'HTTP ' + resp.status + ' for ' + PAGE;
    return res0;
  }
  if (/just a moment|cf-chl|checking your browser|enable javascript and cookies/i.test(html.slice(0, 3000))) {
    res0.reason = 'blocked';
    return res0;
  }
  const entries = parse(html);
  if (!entries) {
    res0.reason = 'layout_changed';
    res0.excerpt = 'winners page no longer carries the "Past Winners" award tables and logo walls we parse';
    return res0;
  }
  const nCap = entries.filter((e) => e.type === 'award').length;
  const nLogo = entries.filter((e) => e.type === 'awardee logo').length;
  if (nCap < 100 || nLogo < 100) {
    res0.reason = 'layout_changed';
    res0.excerpt = 'only ' + nCap + ' award captions and ' + nLogo + ' logos parsed (expected 100+ of each)';
    return res0;
  }
  const prep = entries.map((e) => ({ e, tk: new Set(e.cands.flatMap((c) => toks(c))), cc: e.cands.map(conc).filter(Boolean) }));
  const hits = [];
  for (const c of prep) {
    const s = score(kw, c);
    if (s > 0) hits.push({ c, s });
  }
  hits.sort((a, b) => b.s - a.s);
  if (!hits.length) {
    res0.status = 'not_found';
    res0.excerpt = 'parsed ' + nCap + ' award captions and ' + nLogo + ' awardee logos (editions 2017-2024); no record matches "' + kw + '"';
    return res0;
  }
  const top = hits[0].s;
  const seen = new Set();
  for (const { c, s } of hits.filter((h) => h.s >= Math.max(top - 20, 60)).slice(0, 5)) {
    const e = c.e;
    const key = norm(e.name) + '|' + norm(e.edition);
    if (seen.has(key)) continue;
    seen.add(key);
    const r = { name: e.name, edition: e.edition, type: e.type, matched_by: s >= 80 ? 'name' : 'leading_brand' };
    if (e.award) r.award = e.award;
    if (e.entrepreneur) r.entrepreneur = e.entrepreneur;
    if (e.website) r.website = e.website;
    if (e.link) r.link = e.link;
    res0.records.push(r);
  }
  res0.status = 'found';
  const f = hits[0].c.e;
  res0.excerpt = (f.type === 'award'
    ? 'gallery caption under "' + f.edition + '": ' + f.raw
    : 'awardee logo on the "' + f.edition + '" wall: alt="' + f.alt + '"' + (f.title ? ' title="' + f.title + '"' : '') + (f.link ? ' linking ' + f.link : '')
  ).slice(0, 500);
  return res0;
}
