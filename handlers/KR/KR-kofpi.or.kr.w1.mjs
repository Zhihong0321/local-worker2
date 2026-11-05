// KR-kofpi.or.kr / w1 -- Korea Forestry Promotion Institute (KOFPI)
// Korea Forest Certification scheme (KFCC, run by KOFPI): per-company wood / forest
// product certification records.
//
// Two plain-HTTP sources on kfcc.kofpi.or.kr (the certification site KOFPI links to):
//   1) HTML board /coc  "임산물 생산유통인증 CoC 인증" -- one post per certified company,
//      searchable with a normal GET: /bbs/search.php?bo_table=coc&sfl=wr_subject&stx=<name>
//      detail post /coc/<id> carries 인증번호, 인증제품군, 인증기관, 인증기간.
//   2) The full certified-organisation list (FM + CoC, ~65 orgs) published as an XLSX
//      attachment on the /product board ("... 인증조직 현황 ...xlsx"). The download needs
//      the session cookie + nonce of the post page (plain HTTP, no login).
// Nothing here is a CAPTCHA / bot check / login: all pages are public.

import zlib from 'node:zlib';

const BASE = 'https://kfcc.kofpi.or.kr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/* ---------------------------------- helpers --------------------------------- */

let lastHit = 0;
async function polite() {
  const wait = 1000 - (Date.now() - lastHit);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit = Date.now();
}

async function req(url, { headers = {}, timeout = 25000 } = {}) {
  await polite();
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
      ...headers,
    },
    signal: AbortSignal.timeout(timeout),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf, url: res.url || url };
}

function text(buf) {
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function squeeze(s) {
  return String(s || '').replace(/[\s\u00a0]+/g, ' ').trim();
}

// Normalise a company name for comparison: drop legal-form tokens, punctuation, spaces.
function normName(s) {
  return stripTags(s)
    .replace(/\(주\)|\(유\)|\(사\)|\(합\)|㈜|주식회사|유한회사|합자회사|합명회사/g, '')
    .replace(/[\s\u00a0·.,'"“”‘’()\[\]\-‐_/\\&+]/g, '')
    .toUpperCase();
}

function nameMatches(listName, kw) {
  const a = normName(listName);
  const b = normName(kw);
  if (!a || !b) return false;
  if (a === b) return true;
  if (b.length >= 2 && a.startsWith(b)) return true;
  return false;
}

function firstLine(s) {
  return squeeze(String(s || '').split(/\r?\n/)[0]);
}

/* ------------------------------ ZIP / XLSX read ------------------------------ */

function zipEntries(buf) {
  let eocd = -1;
  const start = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: no end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf, e) {
  const p = e.localOff;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('zip: bad local header');
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + e.compSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('zip: unsupported compression ' + e.method);
}

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml) {
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    let s = '';
    const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tre.exec(m[1]))) s += t[1];
    out.push(
      s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&'),
    );
  }
  return out;
}

function parseSheet(xml, sst) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let auto = 0;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const rAttr = /\br="([^"]+)"/.exec(attrs);
      const idx = rAttr ? colIndex(rAttr[1]) : auto;
      auto = Math.max(auto, idx) + 1;
      let val = '';
      const isTag = /<is>([\s\S]*?)<\/is>/.exec(body);
      if (isTag) {
        const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        while ((t = tre.exec(isTag[1]))) val += t[1];
        val = stripTags(val);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        if (v) {
          const raw = v[1];
          if (/\bt="s"/.test(attrs)) {
            const i = parseInt(raw, 10);
            val = Number.isFinite(i) && sst[i] != null ? sst[i] : '';
          } else {
            val = stripTags(raw);
          }
        }
      }
      if (idx >= 0) cells[idx] = squeeze(val);
    }
    rows.push(cells);
  }
  return rows;
}

/* ------------------------------ source 1: /coc board ------------------------ */

const COC_DETAIL_MARK = '인증조직명';

function parseCocSearchResults(html) {
  // Returns { checked:boolean, matches:[{id,title}] }
  const hasShell = html.includes('search.php') || html.includes('sch_res_list');
  const empty = html.includes('검색된 자료가 하나도 없습니다');
  const items = [];
  const re =
    /<a\s+href="https:\/\/kfcc\.kofpi\.or\.kr\/coc\/(\d+)"\s+class="sch_res_title"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    items.push({ id: m[1], title: squeeze(stripTags(m[2])) });
  }
  if (!items.length && !empty && !hasShell) return { checked: false, matches: [] };
  if (!items.length && !empty) {
    // page shape unknown: fall back to any /coc/N links on the page
    const re2 = /<a\s+href="https:\/\/kfcc\.kofpi\.or\.kr\/coc\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re2.exec(html))) {
      const t = squeeze(stripTags(m[2]));
      if (t && !/새창/.test(t)) items.push({ id: m[1], title: t });
    }
  }
  const seen = new Set();
  const uniq = items.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  return { checked: true, empty, matches: uniq };
}

function parseCocDetail(html, url) {
  if (!html.includes(COC_DETAIL_MARK)) return null;
  const fields = {};
  const re = /<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const k = squeeze(stripTags(m[1]));
    const v = squeeze(stripTags(m[2]));
    if (k) fields[k] = v;
  }
  const titleM = /<div\s+id="bo_v_title"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  const title = titleM ? squeeze(stripTags(titleM[1])) : '';
  const bodyM = /<div\s+id="bo_v_con">([\s\S]*?)<\/div>/.exec(html);
  const body = bodyM ? squeeze(stripTags(bodyM[1])) : '';
  const name = fields['인증조직명'] || title || body;
  if (!name) return null;
  return {
    name,
    cert_no: fields['인증번호'] || '',
    products: fields['인증제품군'] || '',
    certifier: fields['인증기관'] || '',
    site: fields['사업장'] || '',
    category: fields['업종구분'] || '',
    valid: [fields['최초 인증일'], fields['인증 만료일']].filter(Boolean).join(' ~ '),
    status: fields['상황'] || '',
    scheme: 'KFCC CoC (임산물 생산·유통인증)',
    source: url,
  };
}

/* --------------------- source 2: XLSX certified-org list -------------------- */

let orgListCache = null; // { at, rows, sourceUrl }

function htmlCookieJar(res) {
  let list = [];
  if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
  else if (res.headers.get('set-cookie')) list = [res.headers.get('set-cookie')];
  return list.map((c) => String(c).split(';')[0].trim()).filter(Boolean).join('; ');
}

async function fetchOrgRows() {
  if (orgListCache && Date.now() - orgListCache.at < 3 * 3600 * 1000) return orgListCache;

  // 1. newest post on the product board that publishes the certified-org status file
  const listRes = await req(BASE + '/product');
  if (listRes.status !== 200) throw new Error('product board http ' + listRes.status);
  const listHtml = text(listRes.buf);
  const posts = [];
  const re = /<a\s+href="https:\/\/kfcc\.kofpi\.or\.kr\/product\/(\d+)"\s+class="bo_tit"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(listHtml))) posts.push({ id: m[1], title: squeeze(stripTags(m[2])) });
  if (!posts.length) throw new Error('product board layout changed (no posts)');
  const pick =
    posts.find((p) => /인증조직/.test(p.title)) ||
    posts.find((p) => /인증\s*기업|현황/.test(p.title)) ||
    posts[0];
  const postUrl = `${BASE}/product/${pick.id}`;

  // 2. the post page: session cookie + nonce-signed attachment link
  const postRes = await req(postUrl);
  if (postRes.status !== 200) throw new Error('post http ' + postRes.status);
  const cookie = htmlCookieJar(postRes);
  const postHtml = text(postRes.buf);
  const links = [];
  const lre =
    /<a\s+href="(https:\/\/kfcc\.kofpi\.or\.kr\/bbs\/download\.php[^"]*)"[^>]*class="view_file_download"[^>]*>\s*<strong>([\s\S]*?)<\/strong>/g;
  while ((m = lre.exec(postHtml))) {
    links.push({ url: m[1].replace(/&amp;/g, '&'), file: squeeze(stripTags(m[2])) });
  }
  if (!links.length) throw new Error('post has no attachments (layout changed)');
  const xlsx = links.find((l) => /\.xlsx$/i.test(l.file));
  if (!xlsx) throw new Error('no .xlsx attachment on the post');

  // 3. download (plain HTTP, needs the post page session cookie)
  const dlRes = await req(xlsx.url, {
    headers: {
      cookie,
      referer: postUrl,
      accept: '*/*',
    },
  });
  if (dlRes.status !== 200) throw new Error('xlsx http ' + dlRes.status);
  if (dlRes.buf.length < 4 || dlRes.buf[0] !== 0x50 || dlRes.buf[1] !== 0x4b) {
    throw new Error('xlsx download did not return a zip file');
  }

  // 4. unzip + read sheets
  const entries = zipEntries(dlRes.buf);
  const get = (n) => {
    const e = entries.find((x) => x.name === n);
    return e ? readEntry(dlRes.buf, e) : null;
  };
  const sstBuf = get('xl/sharedStrings.xml');
  const sst = sstBuf ? parseSharedStrings(text(sstBuf)) : [];
  const rows = [];
  const sheetNames = entries
    .map((e) => e.name)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)/)[1], 10) - parseInt(b.match(/(\d+)/)[1], 10));

  for (const sn of sheetNames) {
    const sheetRows = parseSheet(text(readEntry(dlRes.buf, entries.find((e) => e.name === sn))), sst);
    // find header row
    let headerIdx = -1;
    for (let i = 0; i < Math.min(sheetRows.length, 6); i++) {
      if ((sheetRows[i] || []).some((c) => c && c.includes('기업명'))) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) continue;
    const header = sheetRows[headerIdx];
    const col = {};
    header.forEach((h, i) => {
      if (!h) return;
      if (/기업명|인증조직명|업체명/.test(h)) col.name = i;
      if (/인증제품/.test(h)) col.products = i;
      if (/인증기관/.test(h) && col.certifier == null) col.certifier = i;
      if (/인증번호/.test(h)) col.cert_no = i;
      if (/사업장|소재지|주소/.test(h)) col.site = i;
      if (/인증\s*산림형태/.test(h)) col.forest = i;
    });
    if (col.name == null) continue;
    const label = (sheetRows.slice(0, headerIdx).flat().find((c) => c && c.length > 5) || '');
    const scheme = /CoC|코크|생산·유통|생산유통/.test(label)
      ? 'KFCC CoC (임산물 생산·유통인증)'
      : /FM|산림경영/.test(label)
        ? 'KFCC FM (산림경영인증)'
        : 'KFCC 인증';
    for (let i = headerIdx + 1; i < sheetRows.length; i++) {
      const r = sheetRows[i] || [];
      const name = firstLine(r[col.name] || '');
      if (!name || /^합계|^계$|^총/.test(name)) continue;
      rows.push({
        name,
        full_name: squeeze(r[col.name] || ''),
        cert_no: squeeze((col.cert_no != null ? r[col.cert_no] : '') || ''),
        products: squeeze((col.products != null ? r[col.products] : '') || ''),
        certifier: squeeze((col.certifier != null ? r[col.certifier] : '') || ''),
        site: squeeze((col.site != null ? r[col.site] : '') || ''),
        scheme,
        source: postUrl,
      });
    }
  }
  if (!rows.length) throw new Error('xlsx: no company rows found');
  orgListCache = { at: Date.now(), rows, sourceUrl: postUrl, file: xlsx.file };
  return orgListCache;
}

/* ---------------------------------- lookup ---------------------------------- */

function result(status, reason, records, source_url, excerpt) {
  return { status, reason, records: records || [], source_url: source_url || '', excerpt: squeeze(excerpt || '').slice(0, 500) };
}

export default async function lookup(keyword) {
  const kw = squeeze(keyword);
  if (!kw) return result('couldnt_check', 'other', [], '', 'empty keyword');

  const searchTerm = kw.replace(/\(주\)|\(유\)|\(사\)|㈜|주식회사|유한회사/g, '').trim() || kw;
  const altTerm = (searchTerm.match(/[가-힣A-Za-z0-9]{4,}/g) || []).sort((a, b) => b.length - a.length)[0];
  const terms = [...new Set([searchTerm, altTerm].filter(Boolean))];

  let cocChecked = false;
  let cocErr = '';
  const boardSeen = [];

  for (const term of terms) {
    const url = `${BASE}/bbs/search.php?bo_table=coc&sfl=wr_subject&sop=and&stx=${encodeURIComponent(term)}`;
    let html;
    try {
      const res = await req(url);
      if (res.status !== 200) {
        cocErr = 'http ' + res.status;
        continue;
      }
      html = text(res.buf);
    } catch (e) {
      cocErr = String(e && e.message ? e.message : e);
      continue;
    }
    const parsed = parseCocSearchResults(html);
    if (!parsed.checked) {
      cocErr = 'search page layout changed';
      continue;
    }
    cocChecked = true;
    for (const it of parsed.matches) boardSeen.push(it);
    const hit = parsed.matches.find((it) => nameMatches(it.title, kw)) || null;
    if (hit) {
      const detailUrl = `${BASE}/coc/${hit.id}`;
      try {
        const d = await req(detailUrl);
        const rec = d.status === 200 ? parseCocDetail(text(d.buf), detailUrl) : null;
        if (rec) {
          return result(
            'found',
            '',
            [rec],
            detailUrl,
            `${rec.name} | ${rec.cert_no} | ${rec.products} | ${rec.certifier} | ${rec.valid}`,
          );
        }
        // title matched but detail page did not look as expected -> keep the title record
        return result(
          'found',
          '',
          [{ name: hit.title, cert_no: '', products: '', certifier: '', scheme: 'KFCC CoC', source: detailUrl }],
          detailUrl,
          `board search hit: ${hit.title}`,
        );
      } catch (e) {
        return result(
          'found',
          '',
          [{ name: hit.title, cert_no: '', products: '', certifier: '', scheme: 'KFCC CoC', source: detailUrl }],
          detailUrl,
          `board search hit: ${hit.title}`,
        );
      }
    }
    if (parsed.empty) break; // site says: nothing on the board for this term
  }

  // full certified-organisation list (FM + CoC)
  let orgErr = '';
  try {
    const idx = await fetchOrgRows();
    const hits = idx.rows.filter((r) => nameMatches(r.name, kw) || nameMatches(r.full_name, kw));
    if (hits.length) {
      return result(
        'found',
        '',
        hits.map((h) => ({
          name: h.name,
          cert_no: h.cert_no,
          products: h.products,
          certifier: h.certifier,
          site: h.site,
          scheme: h.scheme,
          source: h.source,
        })),
        idx.sourceUrl,
        `${hits[0].name} | ${hits[0].cert_no} | ${hits[0].products} | ${hits[0].certifier}`,
      );
    }
  } catch (e) {
    orgErr = String(e && e.message ? e.message : e);
  }

  if (!cocChecked && orgErr) {
    return result('couldnt_check', 'layout_changed', [], `${BASE}/bbs/search.php?bo_table=coc`, `board search failed: ${cocErr}`);
  }
  if (orgErr) {
    return result(
      'couldnt_check',
      'other',
      [],
      `${BASE}/coc`,
      `CoC board had no record; the certified-org list could not be read (${orgErr}) so the list is only partially checked`,
    );
  }
  return result(
    'not_found',
    '',
    [],
    `${BASE}/coc`,
    `no CoC board record and no row in the KFCC-PEFC certified-organisation list for "${kw}"`,
  );
}

export const meta = {
  task: 'KR-kofpi.or.kr',
  want: 'w1',
  tier: 2,
  method: 'other',
  input: 'company name',
  fields: ['name', 'cert_no', 'products', 'certifier', 'site', 'scheme'],
  canary: { found: '무림피앤피', not_found: '세무법인 혜움' },
};
