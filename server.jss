// Chalane ke liye: node server.js  (Node 18+, npm install ki zaroorat nahi)
const http = require('http'), dns = require('dns').promises, crypto = require('crypto');
const { Readable } = require('stream');
const PORT = process.env.PORT || 3000;
const UA = 'Mozilla/5.0 (compatible; LinkPlayer/1.0)';
const store = new Map(); // id -> { src, ref, allowDl }

const isPrivate = ip => /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd|fe80)/i.test(ip);

async function checkUrl(link) {
  let u;
  try { u = new URL(link); } catch { throw new Error('Sahi link daalein'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Sirf http/https link chalega');
  const ips = await dns.lookup(u.hostname, { all: true });
  if (ips.some(i => isPrivate(i.address))) throw new Error('Yeh address allowed nahi hai');
  return u;
}

// Page ke standard video tags (og:video, <video>, <source>) se source nikalta hai.
// Site-specific logic yahin jodna ho toh is function mein jodein.
async function resolve(link) {
  const u = await checkUrl(link);
  if (!/(^|\.)diskwala\./i.test(u.hostname)) throw new Error('Sirf Diskwala link daalein');
  const r = await fetch(u, { headers: { 'user-agent': UA }, redirect: 'follow' });
  const html = await r.text();
  const pick = re => (html.match(re) || [])[1];
  let src = pick(/<meta[^>]+property=["']og:video(?::url|:secure_url)?["'][^>]+content=["']([^"']+)/i)
    || pick(/<video[^>]+src=["']([^"']+)/i)
    || pick(/<source[^>]+src=["']([^"']+)/i)
    || pick(/["'](https?:[^"'\s\\]+\.(?:mp4|webm)[^"'\s\\]*)["']/i);
  if (!src) throw new Error('Is page par video source nahi mila');
  src = new URL(src.replace(/&amp;/g, '&').replace(/\\\//g, '/'), r.url).href;
  if (/\.m3u8/i.test(src)) throw new Error('HLS (m3u8) videos abhi supported nahi hain');
  await checkUrl(src);
  const id = crypto.randomUUID();
  store.set(id, { src, ref: u.origin + '/', allowDl: !/nodownload/i.test(html) }); // uploader ka nodownload flag maana jaata hai
  if (store.size > 500) store.delete(store.keys().next().value);
  return { id, title: (pick(/<title>([^<]*)/i) || 'Video').trim(), allowDl: store.get(id).allowDl };
}

async function stream(req, res, id, dl) {
  const it = store.get(id);
  if (!it) { res.writeHead(404); return res.end('Link expire ho gaya, dobara daalein'); }
  if (dl && !it.allowDl) { res.writeHead(403); return res.end('Is video ka download allowed nahi hai'); }
  const h = { 'user-agent': UA, referer: it.ref };
  if (req.headers.range) h.range = req.headers.range;
  const up = await fetch(it.src, { headers: h });
  const out = { 'content-type': up.headers.get('content-type') || 'video/mp4', 'accept-ranges': 'bytes' };
  for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) out[k] = up.headers.get(k);
  if (dl) out['content-disposition'] = 'attachment; filename="video.mp4"';
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  req.on('close', () => up.body.cancel().catch(() => {}));
  Readable.fromWeb(up.body).pipe(res);
}

const HTML = `<!doctype html><html lang="hi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Link se video chalao</title>
<style>
:root{--bg:#f5f6fa;--card:#fff;--fg:#151826;--mut:#626a80;--ac:#4338ca;--line:#d9dce8}
@media(prefers-color-scheme:dark){:root{--bg:#0d1020;--card:#161a2e;--fg:#eceffa;--mut:#8f97b3;--ac:#7c83ff;--line:#2a3050}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px 16px}
main{max-width:560px;margin:0 auto}
h1{font-size:1.75rem;line-height:1.15;margin:12px 0 6px;letter-spacing:-.02em}
p{color:var(--mut);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
input{width:100%;padding:14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font-size:16px}
input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid var(--ac);outline-offset:2px}
button,a.btn{display:block;width:100%;margin-top:10px;padding:14px;border:0;border-radius:8px;background:var(--ac);color:#fff;font:600 16px system-ui,sans-serif;text-align:center;text-decoration:none;cursor:pointer}
a.btn{background:transparent;color:var(--ac);border:2px solid var(--ac)}
video{width:100%;margin-top:16px;border-radius:8px;background:#000}
h3{font-size:1rem;margin:12px 0 0}
#msg{margin-top:10px;color:var(--mut)}
</style></head><body><main>
<h1>Diskwala link daalo, video yahin chalegi</h1>
<p>Link paste karein. Video play hogi aur download ka option aayega.</p>
<div class="card">
<input id="u" placeholder="Diskwala link yahan paste karein" inputmode="url" autocomplete="off">
<button id="go">Video chalao</button>
<div id="msg" role="status"></div>
<div id="out" hidden>
<video id="v" controls playsinline></video>
<h3 id="t"></h3>
<a id="dl" class="btn" hidden>Download karein</a>
</div></div></main>
<script>
var $=function(i){return document.getElementById(i)};
$('go').onclick=async function(){
  var m=$('msg'),o=$('out');m.textContent='Video dhoondh raha hoon...';o.hidden=true;
  try{
    var r=await fetch('/api/resolve?url='+encodeURIComponent($('u').value.trim()));
    var d=await r.json();if(d.error)throw new Error(d.error);
    $('v').src='/api/stream?id='+d.id;$('t').textContent=d.title;
    var a=$('dl');a.hidden=!d.allowDl;a.href='/api/stream?id='+d.id+'&dl=1';
    o.hidden=false;m.textContent=d.allowDl?'':'Is video ka download uploader ne band rakha hai.';
  }catch(e){m.textContent=e.message}
};
</script></body></html>`;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(HTML); }
    if (u.pathname === '/api/resolve') {
      const d = await resolve(u.searchParams.get('url') || '');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(d));
    }
    if (u.pathname === '/api/stream') return await stream(req, res, u.searchParams.get('id'), u.searchParams.get('dl') === '1');
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => console.log('Chal raha hai: http://localhost:' + PORT));

