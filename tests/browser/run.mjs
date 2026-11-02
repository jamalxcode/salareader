// Runs Sala Reader's browser tests: starts the local stand-ins (the site with test
// data, feed sites, the relay running relay/worker.js), then each case in cases/
// in a headless Chromium, and checks what it printed against tests.json.
//
//   cd tests/browser && npm ci && npx playwright install chromium && node run.mjs [t16 t39 …]
//
// A case passes when it exits cleanly, prints "errors []" (no page errors), and
// every expected line in tests.json matches its output.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdir, symlink, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const FIX = path.join(HERE, 'fixtures');
const WORK = path.join(HERE, '.work'); // what the cases call T: fixtures, node_modules, screenshots
const manifest = JSON.parse(await readFile(path.join(HERE, 'tests.json'), 'utf8'));

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.opml': 'text/xml' };

/** A small static server. map(urlPath) gives the file to send, or null. */
function serve(port, map, headers = () => ({})) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const file = map(decodeURIComponent(url.pathname), url);
      try {
        if (!file || !(await stat(file)).isFile()) throw new Error('missing');
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...headers(url) });
        res.end(await readFile(file));
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain', ...headers(url) });
        res.end('not found');
      }
    });
    server.listen(port, () => resolve(server));
  });
}

const inside = (root, p) => { const f = path.join(root, p); return f.startsWith(root) ? f : null; };

async function setup() {
  await rm(WORK, { recursive: true, force: true });
  await mkdir(path.join(WORK, 'pw'), { recursive: true });
  // The cases were written against a scratch folder T with T/pw/… helpers; recreate it.
  await symlink(path.join(HERE, 'node_modules'), path.join(WORK, 'pw', 'node_modules'));
  for (const f of ['fake-tf.js', 'dup.opml']) await symlink(path.join(FIX, f), path.join(WORK, 'pw', f));
  for (const f of ['backup.json', 'backup2.json', 'bad.json', 'big.opml', 'gn.opml', 'yt.opml', 'two.opml', 'health.opml']) await copyFile(path.join(FIX, f), path.join(WORK, f));
  // A bundle of the OpenAI SDK, as the page would load it from a CDN (for the Grok case).
  const bundle = path.join(WORK, 'pw', 'openai.mjs');
  if (!existsSync(bundle)) {
    const esbuild = await import('esbuild');
    await esbuild.build({ entryPoints: [path.join(FIX, 'oa-entry.mjs')], bundle: true, format: 'esm', platform: 'browser', outfile: bundle, logLevel: 'silent', nodePaths: [path.join(HERE, 'node_modules')] });
  }
}

const SITE_FILES = /^\/(index\.html|style\.css|app\.js|ai\.js|smart\.js|embed-worker\.js|sw\.js|manifest\.webmanifest|icon[\w-]*\.(svg|png)|feeds\.json|directory\.json)$/;

async function startServers() {
  const servers = [
    // The site, from this repository, with test data in data/.
    await serve(8770, (p) => (p === '/' ? path.join(REPO, 'index.html') : p.startsWith('/data/') ? inside(FIX, p) : SITE_FILES.test(p) ? path.join(REPO, p) : null)),
    // Feed sites: one that lets web pages read it (/cors/…), and plain ones.
    await serve(8765, (p) => inside(path.join(FIX, 'srv'), p)),
    await serve(8766, (p) => inside(path.join(FIX, 'srv'), p.replace(/^\/(cors|plain)\//, '/')), (u) => (u.pathname.startsWith('/cors/') ? { 'Access-Control-Allow-Origin': '*' } : {})),
  ];
  const kids = ['relay-dev.mjs', 'feeds-dev.mjs'].map((f) => spawn(process.execPath, [path.join(HERE, 'servers', f)], { stdio: 'inherit' }));
  // Wait until the relay answers.
  for (let i = 0; i < 50; i++) { try { await fetch('http://localhost:8902/'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  return () => { for (const s of servers) s.close(); for (const k of kids) k.kill(); };
}

function runCase(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, 'cases', file), WORK], { cwd: HERE, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 300000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, ms: Date.now() - started }); });
  });
}

const only = process.argv.slice(2);
const cases = Object.entries(manifest).filter(([f]) => !only.length || only.some((o) => f.startsWith(o + '.') || f === o));
await setup();
const stop = await startServers();
const results = [];
for (const [file, spec] of cases) {
  const { code, out, ms } = await runCase(file);
  const problems = [];
  if (code !== 0) problems.push(`exited with code ${code}`);
  if (!/^errors \[\]$/m.test(out)) problems.push('page errors (no "errors []" line)');
  for (const want of spec.expect || []) if (!new RegExp(want, 'm').test(out)) problems.push(`expected /${want}/`);
  results.push({ file, name: spec.name, ok: !problems.length, problems, ms, out });
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${file.padEnd(9)} ${spec.name} (${(ms / 1000).toFixed(1)} s)`);
  if (process.env.VERBOSE && !problems.length) console.log(out.split('\n').filter((l) => l.trim()).map((l) => '       | ' + l).join('\n'));
  if (problems.length) { for (const p of problems) console.log(`       - ${p}`); console.log(out.split('\n').filter((l) => l.trim()).slice(-25).map((l) => '       | ' + l).join('\n')); }
}
stop();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `## Browser tests\n\n${results.length - failed} passed, ${failed} failed\n\n| | Test | Time |\n|---|---|---|\n${results.map((r) => `| ${r.ok ? '✅' : '❌'} | ${r.file}: ${r.name}${r.ok ? '' : `<br>${r.problems.join('<br>')}`} | ${(r.ms / 1000).toFixed(1)} s |`).join('\n')}\n`, { flag: 'a' });
process.exit(failed ? 1 : 0);
