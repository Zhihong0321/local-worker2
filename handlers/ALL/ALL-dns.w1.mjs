// Global handler: DNS beyond DMARC. Input is the company's website domain, not a company name.
// Reads MX, TXT (SPF and domain-verification records) and NS with the worker PC's own resolver. No key, no cost.
// Gathers only: it reports what the records say and which known vendor each one belongs to.
import { Resolver } from 'node:dns/promises';

export const meta = {
  task: 'ALL-dns',
  want: 'w1',
  tier: 1,
  method: 'dns',
  input: 'domain',
  host: 'dns',
  question: 'Which email provider, sending services and SaaS tools does this domain\'s DNS show, and how is its email authentication set up?',
  why_it_matters: 'MX, SPF includes and verification TXT records show which mail provider and tools the company really uses, and how mature its email setup is.',
  source_name: 'Public DNS records (MX, SPF, TXT, NS)',
  source_url: 'https://www.iana.org/domains/root/db',
  fields: ['domain', 'mx', 'mail_provider', 'spf', 'ns', 'txt_verifications'],
  canary: { found: 'google.com', not_found: 'canary-no-such-domain.invalid' },
};

const MAIL = [
  [/(^|\.)(google|googlemail)\.com$/, 'Google Workspace'],
  [/(protection\.outlook|outlook)\.com$/, 'Microsoft 365'],
  [/(^|\.)zoho\.(com|eu|in|com\.au|com\.cn)$/, 'Zoho Mail'],
  [/mimecast/, 'Mimecast (mail filter)'],
  [/pphosted\.com$|ppe-hosted\.com$|proofpoint/, 'Proofpoint (mail filter)'],
  [/messagelabs\.com$/, 'Symantec email security (mail filter)'],
  [/barracudanetworks\.com$|barracuda/, 'Barracuda (mail filter)'],
  [/secureserver\.net$/, 'GoDaddy email'],
  [/emailsrvr\.com$/, 'Rackspace email'],
  [/titan\.email$/, 'Titan email'],
  [/(^|\.)yandex\.(net|ru|com)$/, 'Yandex Mail'],
  [/exmail\.qq\.com$|(^|\.)qq\.com$/, 'Tencent Exmail'],
  [/mxhichina\.com$|aliyun|alibaba/, 'Alibaba Mail'],
  [/icloud\.com$/, 'iCloud Mail'],
  [/mailgun\.org$/, 'Mailgun'],
  [/improvmx\.com$|forwardemail\.net$|registrar-servers\.com$/, 'Email forwarding service'],
];

const SPF = [
  [/_spf\.google\.com$|google\.com$/, 'Google Workspace'],
  [/spf\.protection\.outlook\.com$|outlook\.com$/, 'Microsoft 365'],
  [/sendgrid\.net$/, 'SendGrid'],
  [/mailgun\.org$/, 'Mailgun'],
  [/amazonses\.com$/, 'Amazon SES'],
  [/mcsv\.net$|mailchimp\.com$/, 'Mailchimp'],
  [/mandrillapp\.com$/, 'Mandrill (Mailchimp)'],
  [/hubspotemail\.net$|hubspot\.com$/, 'HubSpot'],
  [/salesforce\.com$|exacttarget\.com$|pardot\.com$/, 'Salesforce / Pardot'],
  [/mktomail\.com$/, 'Marketo'],
  [/zendesk\.com$/, 'Zendesk'],
  [/freshdesk\.com$|freshworks\.com$|freshemail\.io$/, 'Freshworks'],
  [/mailjet\.com$/, 'Mailjet'],
  [/sparkpostmail\.com$/, 'SparkPost'],
  [/postmarkapp\.com$/, 'Postmark'],
  [/sendinblue\.com$|brevo\.com$/, 'Brevo (Sendinblue)'],
  [/helpscoutemail\.com$/, 'Help Scout'],
  [/intercom\.io$|intercomcdn\.com$/, 'Intercom'],
  [/shopify\.com$/, 'Shopify'],
  [/zoho\.(com|eu|in)$/, 'Zoho'],
  [/secureserver\.net$/, 'GoDaddy'],
  [/atlassian\.net$|atlassian\.com$/, 'Atlassian'],
  [/activecampaign\.com$|emsmtp\.com$/, 'ActiveCampaign'],
  [/mimecast\.com$/, 'Mimecast'],
  [/pphosted\.com$|ppe-hosted\.com$/, 'Proofpoint'],
  [/emailsrvr\.com$/, 'Rackspace'],
  [/constantcontact\.com$|ctctcdn\.com$/, 'Constant Contact'],
  [/campaignmonitor\.com$|cmail\d*\.com$/, 'Campaign Monitor'],
];

const VERIFY = [
  [/^google-site-verification=/i, 'Google Search Console / Google Workspace'],
  [/^MS=/i, 'Microsoft 365 domain verification'],
  [/^facebook-domain-verification=/i, 'Meta (Facebook) domain verification'],
  [/^atlassian-domain-verification=/i, 'Atlassian'],
  [/^docusign=/i, 'DocuSign'],
  [/^zoho-verification=/i, 'Zoho'],
  [/^stripe-verification=/i, 'Stripe'],
  [/^apple-domain-verification=/i, 'Apple'],
  [/^adobe-idp-site-verification=|^adobe-sign-verification=/i, 'Adobe'],
  [/^hubspot-developer-verification=/i, 'HubSpot'],
  [/^miro-verification=/i, 'Miro'],
  [/^slack-domain-verification=/i, 'Slack'],
  [/^dropbox-domain-verification=/i, 'Dropbox'],
  [/^cisco-ci-domain-verification=|^webexdomainverification/i, 'Cisco Webex'],
  [/^smartsheet-site-validation=/i, 'Smartsheet'],
  [/^status-page-domain-verification=/i, 'Atlassian Statuspage'],
  [/^canva-site-verification=/i, 'Canva'],
  [/^asana-verification=/i, 'Asana'],
  [/^ZOOM_verify_/i, 'Zoom'],
  [/^onetrust-domain-verification=/i, 'OneTrust'],
  [/^shopify-verification-code=/i, 'Shopify'],
  [/^amazonses:/i, 'Amazon SES'],
  [/^pinterest-site-verification=/i, 'Pinterest'],
  [/^yandex-verification:/i, 'Yandex'],
  [/^baidu-site-verification=/i, 'Baidu'],
  [/^globalsign-domain-verification=/i, 'GlobalSign (certificate)'],
  [/^_?github-pages-challenge/i, 'GitHub Pages'],
  [/^ahrefs-site-verification_/i, 'Ahrefs'],
  [/^mailchimp=?/i, 'Mailchimp'],
];

const NS = [
  [/cloudflare\.com$/, 'Cloudflare'],
  [/awsdns/, 'Amazon Route 53'],
  [/googledomains\.com$|google\.com$/, 'Google Cloud DNS / Google Domains'],
  [/azure-dns\./, 'Azure DNS'],
  [/domaincontrol\.com$/, 'GoDaddy'],
  [/registrar-servers\.com$/, 'Namecheap'],
  [/dnspod\.net$|dnsv\d\.com$/, 'DNSPod (Tencent)'],
  [/hichina\.com$|alidns\.com$/, 'Alibaba Cloud DNS'],
  [/wixdns\.net$/, 'Wix'],
  [/squarespace/, 'Squarespace'],
  [/nsone\.net$/, 'NS1'],
  [/dnsmadeeasy\.com$/, 'DNS Made Easy'],
];

function hostOf(input) {
  let s = String(input ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  try { s = new URL('http://' + s).hostname; } catch { /* keep as typed */ }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

const label = (table, value) => table.find(([re]) => re.test(value))?.[1] ?? null;
const NONE = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

async function ask(fn) {
  try { return { ok: true, data: await fn() }; } catch (err) {
    const code = String(err?.code ?? err?.message ?? 'ERROR');
    return NONE.has(code) ? { ok: true, none: code, data: [] } : { ok: false, code };
  }
}

function result(status, reason, records, excerpt, sourceUrl) {
  return { status, reason, records, source_url: sourceUrl, excerpt: String(excerpt ?? '') };
}

export default async function lookup(keyword) {
  const host = hostOf(keyword);
  const source = host ? `https://dnschecker.org/all-dns-records-of-domain.php?query=${host}&rtype=ALL` : 'https://www.iana.org/domains/root/db';
  if (!host) return result('couldnt_check', 'keyword_not_a_domain', [], `The keyword "${String(keyword ?? '').slice(0, 80)}" is not a domain name, so no DNS lookup was made.`, source);
  try {
    const r = new Resolver({ timeout: 4000, tries: 2 });
    const [mx, txt, ns] = await Promise.all([ask(() => r.resolveMx(host)), ask(() => r.resolveTxt(host)), ask(() => r.resolveNs(host))]);
    const all = [mx, txt, ns];
    const errors = all.filter((x) => !x.ok).map((x) => x.code);
    if (all.every((x) => !x.ok)) return result('couldnt_check', 'dns_unreachable', [], `The DNS lookup for ${host} failed on all three queries (${[...new Set(errors)].join(', ')}). This says nothing about the company.`, source);
    if (all.every((x) => x.ok && (x.none === 'ENOTFOUND' || x.none === 'NXDOMAIN'))) return result('not_found', 'domain_not_in_dns', [], `${host} does not exist in DNS (no such domain).`, source);

    const mxRows = [...(mx.data ?? [])].sort((a, b) => a.priority - b.priority).map((m) => ({ priority: m.priority, exchange: String(m.exchange).toLowerCase().replace(/\.$/, '') }));
    const mailProviders = [...new Set(mxRows.map((m) => label(MAIL, m.exchange) ?? null).filter(Boolean))];
    const txtRows = (txt.data ?? []).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)));
    const spfRecords = txtRows.filter((t) => /^v=spf1\b/i.test(t.trim()));
    const spfText = spfRecords[0] ?? '';
    const includes = [...spfText.matchAll(/(?:^|\s)[+\-~?]?(?:include:|redirect=)(\S+)/gi)].map((m) => m[1].toLowerCase());
    const spfSenders = [...new Set(includes.map((i) => ({ host: i, vendor: label(SPF, i) })).map((x) => JSON.stringify(x)))].map((s) => JSON.parse(s));
    const ending = spfText.match(/(?:^|\s)([+\-~?]?)all\b/i);
    const strictness = !spfText ? 'no SPF record' : !ending ? 'SPF record with no "all" ending'
      : ending[1] === '-' ? 'strict (-all: unlisted senders fail)' : ending[1] === '~' ? 'soft fail (~all)' : ending[1] === '?' ? 'neutral (?all)' : 'open (+all: anyone may send)';
    const verifications = txtRows.map((t) => ({ service: label(VERIFY, t.trim()), record: t.slice(0, 60) })).filter((v) => v.service);
    const nsRows = (ns.data ?? []).map((n) => String(n).toLowerCase().replace(/\.$/, '')).sort();
    const nsProviders = [...new Set(nsRows.map((n) => label(NS, n)).filter(Boolean))];

    const records = [{
      domain: host,
      mx: mxRows,
      mail_provider: mailProviders,
      spf: { present: spfRecords.length > 0, record_count: spfRecords.length, record: spfText.slice(0, 400), strictness, senders: spfSenders },
      ns: nsRows,
      ns_provider: nsProviders,
      txt_verifications: verifications,
      txt_record_count: txtRows.length,
      query_errors: errors,
    }];
    const lines = [`DNS records for ${host} (read from the worker PC's resolver):`];
    lines.push(mxRows.length ? `Mail (MX): ${mxRows.map((m) => `${m.priority} ${m.exchange}`).join(', ')}${mailProviders.length ? ` -> ${mailProviders.join(', ')}` : ' -> no known provider matched'}` : 'Mail (MX): no MX records');
    lines.push(spfText ? `SPF: present, ${strictness}${spfSenders.length ? `; senders listed: ${spfSenders.map((s) => (s.vendor ? `${s.vendor} (${s.host})` : s.host)).join(', ')}` : ''}${spfRecords.length > 1 ? `; WARNING ${spfRecords.length} SPF records published (only one is valid)` : ''}` : 'SPF: no SPF record');
    lines.push(verifications.length ? `Tools shown by verification records: ${[...new Set(verifications.map((v) => v.service))].join(', ')}` : 'Tools shown by verification records: none recognised');
    lines.push(nsRows.length ? `Name servers: ${nsRows.join(', ')}${nsProviders.length ? ` -> ${nsProviders.join(', ')}` : ''}` : 'Name servers: none returned');
    if (errors.length) lines.push(`Some queries failed (${[...new Set(errors)].join(', ')}); the lines above may be incomplete.`);
    const anything = mxRows.length || txtRows.length || nsRows.length;
    return result(anything ? 'found' : 'not_found', anything ? null : 'no_records', anything ? records : [], lines.join('\n'), source);
  } catch (err) {
    return result('couldnt_check', 'handler_error', [], `The DNS handler hit an error: ${String(err?.message ?? err).slice(0, 200)}`, source);
  }
}
