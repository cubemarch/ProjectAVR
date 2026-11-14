import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_STYLE, STYLES } from './panels.js';
import { touchBusy } from './make.js';

/**
 * The comic generator as a service on the GPU box, the way the GIF generator
 * is: a web page on port 8011, behind a firewall rule that admits only
 * David's addresses.
 *
 *   COMIC_ON_BOX=1 node comic/service.js     (systemd runs it; see deploy.sh)
 *
 * Type an idea, get a script from the local writer, edit any of it, draw it.
 * Each step is `new.js` run as a child process, so a job that takes three
 * minutes never stalls the page, and jobs run one at a time because there is
 * one GPU. The idle reaper is kept off while a job runs, and left to power the
 * box down when none is.
 *
 * Everything lives in `drafts/new/`: `<name>.json` is the script, `<name>.png`
 * the lettered page.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'drafts', 'new');
const PORT = Number(process.env.COMIC_PORT ?? 8011);
const NAME = /^[\w-]+$/;

fs.mkdirSync(DIR, { recursive: true });

/* --------------------------------------------------------------- jobs -- */

const jobs = new Map();
let queue = Promise.resolve();
let running = 0;

setInterval(() => {
    if (running) touchBusy();
}, 20_000);

function startJob(kind, name, args) {
    const job = { id: randomUUID().slice(0, 8), kind, name, status: 'queued', log: '' };
    jobs.set(job.id, job);

    queue = queue.then(
        () =>
            new Promise((resolve) => {
                job.status = 'running';
                running++;
                touchBusy();
                const child = spawn(process.execPath, [path.join(HERE, 'new.js'), ...args], { env: process.env });
                const append = (d) => {
                    job.log = (job.log + d).slice(-20_000);
                };
                child.stdout.on('data', append);
                child.stderr.on('data', append);
                child.on('close', (code) => {
                    running--;
                    job.status = code === 0 ? 'done' : 'failed';
                    resolve();
                });
            })
    );
    return job;
}

/* --------------------------------------------------------------- http -- */

function send(res, status, body, type = 'application/json; charset=utf-8') {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    // A file read from disk goes out as it is; only response objects are serialised.
    res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 1 << 20) reject(new Error('request too large'));
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch {
                reject(new Error('body is not JSON'));
            }
        });
    });
}

function drafts() {
    return fs
        .readdirSync(DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
            const name = f.slice(0, -5);
            let title = name;
            try {
                title = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')).strip?.title ?? name;
            } catch {}
            return { name, title, page: fs.existsSync(path.join(DIR, `${name}.png`)), mtime: fs.statSync(path.join(DIR, f)).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
}

const stampName = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');

async function handle(req, res) {
    const url = new URL(req.url, 'http://box');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, PAGE, 'text/html; charset=utf-8');

    if (req.method === 'GET' && url.pathname === '/api/drafts') return send(res, 200, drafts());

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'job' && jobs.has(parts[2])) return send(res, 200, jobs.get(parts[2]));

    // HEAD too: the page asks whether a script has a drawn page yet.
    if ((req.method === 'GET' || req.method === 'HEAD') && parts[0] === 'files' && parts.length === 2) {
        const m = /^([\w-]+)\.(png|json)$/.exec(parts[1]);
        const file = m && path.join(DIR, parts[1]);
        if (!file || !fs.existsSync(file)) return send(res, 404, { error: 'no such file' });
        return send(res, 200, fs.readFileSync(file), m[2] === 'png' ? 'image/png' : 'application/json; charset=utf-8');
    }

    if (req.method === 'POST' && url.pathname === '/api/write') {
        const { idea, style = DEFAULT_STYLE } = await readBody(req);
        if (typeof idea !== 'string' || !idea.trim()) return send(res, 400, { error: 'Write an idea first.' });
        if (!Object.hasOwn(STYLES, style)) return send(res, 400, { error: `Unknown style ${style}.` });
        const name = stampName();
        return send(res, 202, startJob('write', name, [idea.trim(), '--script-only', '--style', style, '--out', path.join(DIR, name)]));
    }

    if (req.method === 'POST' && url.pathname === '/api/draw') {
        const { name, strip, panels, style = DEFAULT_STYLE, seed } = await readBody(req);
        if (!NAME.test(name ?? '') || !fs.existsSync(path.join(DIR, `${name}.json`))) return send(res, 400, { error: 'Unknown script.' });
        if (!Object.hasOwn(STYLES, style)) return send(res, 400, { error: `Unknown style ${style}.` });
        if (!strip || !Array.isArray(panels) || panels.length !== 4) return send(res, 400, { error: 'A script needs four panels.' });

        const file = path.join(DIR, `${name}.json`);
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, JSON.stringify({ ...saved, strip, panels }, null, 2));

        const args = ['--from', file, '--style', style];
        if (Number.isFinite(Number(seed)) && seed !== '' && seed !== null) args.push('--seed', String(Number(seed)));
        return send(res, 202, startJob('draw', name, args));
    }

    return send(res, 404, { error: 'not found' });
}

http
    .createServer((req, res) => {
        handle(req, res).catch((err) => send(res, 400, { error: err.message }));
    })
    .listen(PORT, '0.0.0.0', () => console.log(`comic service on :${PORT}, drafts in ${DIR}`));

/* --------------------------------------------------------------- page -- */

const STYLE_OPTIONS = Object.keys(STYLES)
    .map((s) => `<option value="${s}"${s === DEFAULT_STYLE ? ' selected' : ''}>${s}</option>`)
    .join('');

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lusty X Generator</title>
<style>
  :root { --bg:#14130f; --sheet:#1d1b16; --ink:#efe8da; --dim:#a9a090; --rule:#38342b; --copper:#e08a52; --bad:#e06a5a; color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 Georgia, 'P052', serif; padding: 24px 16px 64px; }
  .wrap { max-width: 1280px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px; }
  h1 { grid-column: 1 / -1; margin: 0; font: italic 900 44px/1 'Bodoni 72', 'C059', Georgia, serif; }
  h2 { margin: 0 0 8px; font-size: 16px; letter-spacing: .08em; text-transform: uppercase; color: var(--copper); }
  section { display: grid; gap: 14px; align-content: start; min-width: 0; }
  label { display: grid; gap: 4px; color: var(--dim); font-size: 13px; }
  textarea, input, select { width: 100%; background: var(--sheet); color: var(--ink); border: 1px solid var(--rule); border-radius: 6px; padding: 8px 10px; font: 14px/1.4 ui-monospace, 'DejaVu Sans Mono', monospace; }
  textarea { resize: vertical; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: end; }
  .row > label { flex: 1 1 140px; }
  button { background: var(--copper); color: #1a120b; border: 0; border-radius: 999px; padding: 10px 18px; font: 700 14px/1 Georgia, serif; cursor: pointer; }
  button:disabled { opacity: .45; cursor: default; }
  button:focus-visible, textarea:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--copper); outline-offset: 2px; }
  .panel { border: 1px solid var(--rule); border-radius: 8px; padding: 12px; display: grid; gap: 8px; background: var(--sheet); }
  .panel b { color: var(--copper); font-size: 13px; letter-spacing: .06em; }
  #status { color: var(--dim); white-space: pre-wrap; font: 12px/1.4 ui-monospace, monospace; max-height: 160px; overflow: auto; }
  #status.failed { color: var(--bad); }
  #page img { width: 100%; height: auto; border: 1px solid var(--rule); border-radius: 6px; }
  #drafts { display: grid; gap: 6px; padding: 0; margin: 0; list-style: none; }
  #drafts button { background: none; color: var(--ink); padding: 6px 0; text-align: left; border-radius: 0; font: 14px Georgia, serif; }
  #drafts span { color: var(--dim); font-size: 12px; margin-left: 8px; }
  @media (max-width: 860px) { .wrap { grid-template-columns: 1fr; } }
</style></head>
<body><div class="wrap">
  <h1>Lusty X</h1>
  <section>
    <h2>1 · Idea</h2>
    <label for="idea">One line of story
      <textarea id="idea" rows="3" placeholder="Lusty and Mira test the VR camera on a rooftop at night; the wind keeps knocking the tripod over"></textarea></label>
    <div class="row">
      <label for="style">Style<select id="style">${STYLE_OPTIONS}</select></label>
      <label for="seed">Seed (blank for random)<input id="seed" inputmode="numeric" /></label>
    </div>
    <div class="row"><button id="write">Write script</button></div>
    <h2>2 · Script</h2>
    <div id="script"><p style="color:var(--dim);margin:0">The script appears here to edit before drawing. Lines are <code>Speaker: text</code>, one per line; use Caption or Screen as the speaker for boxes and screens. Inserts are <code>type: text</code> with type chyron, doc, label, note or badge.</p></div>
    <div class="row"><button id="draw" disabled>Draw page</button></div>
    <div id="status" role="status"></div>
  </section>
  <section>
    <h2>3 · Page</h2>
    <div id="page"><p style="color:var(--dim);margin:0">Drawing takes a minute or two: the panels render on the A100, then the page is lettered.</p></div>
    <h2>Earlier pages</h2>
    <ul id="drafts"></ul>
  </section>
</div>
<script>
const $ = (id) => document.getElementById(id);
let current = null;

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]); }

function showScript(name, saved) {
  current = { name, saved };
  const { strip, panels } = saved;
  $('script').innerHTML =
    '<div class="row"><label for="t">Title<input id="t" value="' + esc(strip.title) + '"></label>' +
    '<label for="a">Arc (footer)<input id="a" value="' + esc(strip.arc) + '"></label></div>' +
    strip.panels.map((p, i) =>
      '<div class="panel"><b>PANEL ' + (i + 1) + '</b>' +
      '<label for="l' + i + '">Lines<textarea id="l' + i + '" rows="3">' + esc(p.lines.map(([w, t]) => w + ': ' + t).join('\\n')) + '</textarea></label>' +
      '<label for="i' + i + '">Inserts<textarea id="i' + i + '" rows="1">' + esc((panels[i].inserts || []).map((x) => x.type + ': ' + x.text).join('\\n')) + '</textarea></label>' +
      '<label for="p' + i + '">Drawing tags<textarea id="p' + i + '" rows="3">' + esc(panels[i].prompt) + '</textarea></label>' +
      '<label for="r' + i + '">Art direction (for you)<textarea id="r' + i + '" rows="2">' + esc(p.art || '') + '</textarea></label></div>'
    ).join('');
  if (saved.style) $('style').value = saved.style;
  $('draw').disabled = false;
}

function collect() {
  const split = (line) => { const k = line.indexOf(':'); return k < 0 ? null : [line.slice(0, k).trim(), line.slice(k + 1).trim()]; };
  const strip = { ...current.saved.strip, title: $('t').value, arc: $('a').value };
  strip.panels = strip.panels.map((p, i) => ({ ...p, art: $('r' + i).value,
    lines: $('l' + i).value.split('\\n').map(split).filter((x) => x && x[0] && x[1]) }));
  const panels = current.saved.panels.map((p, i) => ({ prompt: $('p' + i).value,
    inserts: $('i' + i).value.split('\\n').map(split).filter((x) => x && x[1]).map(([type, text]) => ({ type, text })) }));
  return { strip, panels };
}

async function api(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function follow(job, done) {
  $('write').disabled = $('draw').disabled = true;
  $('status').className = '';
  for (;;) {
    const j = await api('/api/job/' + job.id);
    $('status').textContent = j.status + (j.status === 'queued' ? ' (another job is ahead of this one)' : '') + '\\n' + j.log.split('\\n').slice(-8).join('\\n');
    if (j.status === 'done' || j.status === 'failed') {
      $('write').disabled = false; $('draw').disabled = !current;
      if (j.status === 'failed') { $('status').className = 'failed'; return; }
      await done(j); loadDrafts(); return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function openDraft(name) {
  const saved = await api('/files/' + name + '.json');
  showScript(name, saved);
  $('page').innerHTML = (await fetch('/files/' + name + '.png', { method: 'HEAD' })).ok
    ? '<img alt="' + esc(saved.strip.title) + '" src="/files/' + name + '.png?' + Date.now() + '">' : '';
}

async function loadDrafts() {
  const list = await api('/api/drafts');
  $('drafts').innerHTML = list.map((d) => '<li><button data-name="' + esc(d.name) + '">' + esc(d.title) + '<span>' + (d.page ? 'page drawn' : 'script only') + '</span></button></li>').join('');
}

$('drafts').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) openDraft(b.dataset.name); });

$('write').addEventListener('click', async () => {
  try {
    const job = await api('/api/write', { idea: $('idea').value, style: $('style').value });
    await follow(job, () => openDraft(job.name));
  } catch (err) { $('status').className = 'failed'; $('status').textContent = err.message; }
});

$('draw').addEventListener('click', async () => {
  try {
    const job = await api('/api/draw', { name: current.name, ...collect(), style: $('style').value, seed: $('seed').value });
    await follow(job, () => openDraft(job.name));
  } catch (err) { $('status').className = 'failed'; $('status').textContent = err.message; }
});

loadDrafts();
</script></body></html>`;
