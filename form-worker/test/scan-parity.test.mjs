// The form check must give the same verdict as the hub (agy-lab processLead) on every fixture site.
// test/fixtures/scan-parity.json was made by running the hub's own code on these pages; see its header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanWebsite } from '../scan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { cases } = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'scan-parity.json'), 'utf8'));

for (const c of cases) {
  test(`scan parity with the hub: ${c.name}`, async () => {
    const fetchPage = async (url) => {
      const hit = c.pages[url];
      if (!hit || hit.error) throw new Error(hit?.error ?? 'HTTP 404');
      return { url, html: hit.html };
    };
    const got = await scanWebsite(c.website, fetchPage);
    assert.deepEqual({ status: got.status, url: got.url ?? null, detail: got.detail }, c.expected);
  });
}
