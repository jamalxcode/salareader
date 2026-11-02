// Checks every feed in directory.json through the relay (as the reader would)
// and writes directory.checked.json with the ones that work.
// RELAY=https://... node scripts/check-directory.mjs
import { readFile, writeFile } from 'node:fs/promises';

const RELAY = (process.env.RELAY || 'https://salareader-relay.jamal-akuna-matata.workers.dev').replace(/\/$/, '');
const dir = JSON.parse(await readFile('directory.json', 'utf8'));
const results = [];
for (const cat of dir.categories) {
  for (const f of cat.feeds) {
    let status = '', items = 0;
    try {
      const res = await fetch(`${RELAY}/?url=${encodeURIComponent(f.url)}`, { headers: { Origin: 'https://reader.sala.company' }, signal: AbortSignal.timeout(30000) });
      const text = await res.text();
      items = (text.match(/<item[\s>]|<entry[\s>]/g) || []).length;
      status = res.ok && items ? 'ok' : `${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}`;
    } catch (e) { status = 'error ' + e.message; }
    results.push({ cat: cat.name, ...f, status, items });
    console.log(`${status === 'ok' ? 'OK  ' : 'FAIL'} ${cat.name.padEnd(24)} ${f.title.padEnd(26)} ${status === 'ok' ? items + ' items' : status}`);
    await new Promise((r) => setTimeout(r, 1200)); // stay under the relay's limit
  }
}
const bad = results.filter((r) => r.status !== 'ok');
console.log(`\n${results.length - bad.length} of ${results.length} feeds work`);
await writeFile('directory.checked.json', JSON.stringify(results, null, 2));
