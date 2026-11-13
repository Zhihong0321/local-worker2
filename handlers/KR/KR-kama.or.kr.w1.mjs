export const meta = {
  task: 'KR-kama.or.kr',
  want: 'w1',
  tier: 1,
  method: 'get',
  pdf: false,
  input: 'company name',
  fields: ['name', 'legal_name', 'english_name', 'address', 'phone', 'homepage', 'founded', 'plants'],
  canary: { found: '현대자동차', not_found: '다라마바사 주식회사' },
};

// KAMA's member-company pages. The ids are the site's own page codes; enLabel is the site's English nav text.
const BASE = 'https://www.kama.or.kr/InfoController?cmd=L';
const LIST_URL = `${BASE}&boardmaster_id=Hyundai&menunum=0006`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MEMBERS = [
  { kr: 'Hyundai', en: 'enghyundai', enLabel: 'HYUNDAI' },
  { kr: 'Kia', en: 'engkia', enLabel: 'KIA' },
  { kr: 'Gm', en: 'enggm', enLabel: 'GM KOREA' },
  { kr: 'Renaultsamsung', en: 'engrenault', enLabel: 'Renault Korea' },
  { kr: 'Ssangyong', en: 'engssangyong', enLabel: 'KG Mobility' },
];

function clean(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

/** Compare names: lower case, no legal form (주식회사, ㈜, Co., Ltd, Corporation, Company...), no spaces or punctuation. */
function norm(s) {
  return (s || '').toLowerCase()
    .replace(/㈜|주식회사|유한회사|합자회사/g, ' ')
    .replace(/\b(co|ltd|inc|corp|corporation|company|limited|llc|the)\b/g, ' ')
    .replace(/[^a-z0-9가-힣]/g, '');
}

function fail(reason, message, url) {
  const e = new Error(message);
  e.reason = reason;
  e.url = url;
  return e;
}

function reasonOf(err) {
  if (err && err.reason) return err.reason;
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timeout';
  return 'other';
}

async function getPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(25000),
  });
  if (res.status === 403 || res.status === 429) throw fail('blocked', `HTTP ${res.status}`, url);
  if (!res.ok) throw fail('http_error', `HTTP ${res.status}`, url);
  // The site is served as EUC-KR (its own meta tag says utf-8, which is wrong), so decode the bytes as EUC-KR.
  return new TextDecoder('euc-kr').decode(await res.arrayBuffer());
}

function infoTable(html) {
  const out = {};
  for (const m of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    out[clean(m[1])] = clean(m[2]);
  }
  return out;
}

/** Read the Korean and English page of one member company. Throws (with a reason) if either page is not what we expect. */
async function readCompany(m) {
  const krUrl = `${BASE}&boardmaster_id=${m.kr}&menunum=0006`;
  const enUrl = `${BASE}&boardmaster_id=${m.en}&menunum=0082`;
  const [kr, en] = await Promise.all([getPage(krUrl), getPage(enUrl)]);

  const krName = clean(kr.match(/<h3><span>([\s\S]*?)<\/span><\/h3>/)?.[1]);
  const info = infoTable(kr);
  if (!krName || !info['주소']) throw fail('layout_changed', 'member page has no company heading or address row', krUrl);
  if (!en.includes(`>${m.enLabel}<`)) throw fail('layout_changed', `English member page has no "${m.enLabel}" label`, enUrl);

  // Legal names are in <p class="con_tit">. The Korean page keeps its copy inside an HTML comment; the text is still served.
  const krLegal = clean(kr.match(/con_tit">([^<]+)</)?.[1]);
  const enLegal = clean(en.match(/con_tit">([^<]+)</)?.[1]);

  return {
    names: [krName, krLegal, m.enLabel, enLegal],
    source_url: krUrl,
    record: {
      name: krName,
      legal_name: krLegal || krName,
      english_name: enLegal || m.enLabel,
      address: info['주소'] || '',
      phone: info['연락처'] || '',
      homepage: info['홈페이지'] || '',
      founded: info['설립연도'] || info['설립일'] || '',
      plants: info['공장소재지'] || '',
    },
  };
}

function out(status, reason, records, source_url, excerpt) {
  return { status, reason, records, source_url, excerpt: String(excerpt || '').slice(0, 300) };
}

/** Look one company up. Must never throw: every failure is a couldnt_check with a reason. */
export default async function lookup(keyword) {
  try {
    const kn = norm(String(keyword ?? ''));
    if (!kn) return out('couldnt_check', 'other', [], LIST_URL, 'empty company name');

    const settled = await Promise.allSettled(MEMBERS.map(readCompany));
    const hits = [];
    const failures = [];
    for (const s of settled) {
      if (s.status === 'rejected') failures.push(s.reason);
      else if (s.value.names.some((n) => norm(n) === kn)) hits.push(s.value);
    }

    if (hits.length) {
      const h = hits[0];
      return {
        status: 'found',
        reason: '',
        records: hits.map((x) => x.record),
        source_url: h.source_url,
        excerpt: `${h.record.legal_name} | ${h.record.english_name} | ${h.record.address}`.slice(0, 300),
      };
    }
    if (failures.length) {
      const f = failures[0];
      return out('couldnt_check', reasonOf(f), [], f.url || LIST_URL,
        `${failures.length} of ${MEMBERS.length} KAMA member pages could not be read: ${f.message || f}`);
    }
    return out('not_found', '', [], LIST_URL, 'KAMA member list (5 companies): no match for this name');
  } catch (err) {
    return out('couldnt_check', reasonOf(err), [], LIST_URL, String(err?.message || err));
  }
}
