const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const PIN = process.env.ADMIN_PIN;
const TOKEN = process.env.KINDLE_TOKEN;
const WEATHER_KEY = process.env.WEATHER_KEY;
if (!PIN || !TOKEN) { console.error('Imposta ADMIN_PIN e KINDLE_TOKEN'); process.exit(1); }
const BASE = '/k/' + TOKEN;
const LAT = (process.env.LAT || '41.1171').trim();
const LON = (process.env.LON || '16.8719').trim();
process.env.TZ = process.env.TZ || 'Europe/Rome';

const app = express();
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));
let col;

// ---------- utilità ----------
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const p2 = n => (n < 10 ? '0' : '') + n;
const iso = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const fromIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const dayLabel = d => d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

// ---------- meteo (WeatherAPI, cache 30 min) ----------
let wCache = { t: 0, data: null };
async function weather() {
  if (wCache.data && Date.now() - wCache.t < 30 * 60 * 1000) return wCache.data;
  try {
    if (!WEATHER_KEY) return null;
    const u = `https://api.weatherapi.com/v1/forecast.json?key=${WEATHER_KEY}&q=${LAT},${LON}&days=3&lang=it`;
    const res = await fetch(u);
    const data = await res.json();
    if (data.error) console.error("ERRORE WEATHERAPI:", data.error.message);
    wCache = { t: Date.now(), data };
  } catch (e) { console.error("ERRORE FETCH METEO:", e.message); }
  return wCache.data;
}

function weatherHtml(w) {
  if (!w || w.error || !w.forecast) return '<div class="box">Meteo non disponibile</div>';
  const d = w.forecast.forecastday, names = ['Oggi', 'Domani', 'Dopodomani'];
  let cols = '';
  for (let i = 0; i < 3; i++) {
    if (!d[i]) continue;
    // Disposizione orizzontale compatta per salvare spazio in altezza
    cols += `<td style="width:33.3%; text-align:center; padding:10px 4px; border-right:${i<2?'2px solid #000':'none'}">
      <div style="font-size:22px; font-weight:bold; margin-bottom:6px;">${names[i]}</div>
      <div style="font-size:20px; text-transform:capitalize; margin-bottom:6px; height:50px; overflow:hidden;">${d[i].day.condition.text}</div>
      <div style="font-size:24px; font-weight:bold;">${Math.round(d[i].day.mintemp_c)}&deg; / ${Math.round(d[i].day.maxtemp_c)}&deg;</div>
    </td>`;
  }
  return `<div class="box">
    <div class="now">${Math.round(w.current.temp_c)}&deg; &ndash; ${w.current.condition.text}</div>
    <table style="width:100%; border-top:2px solid #000; margin-top:12px; border-collapse:collapse;">
      <tr>${cols}</tr>
    </table>
  </div>`;
}

// ---------- layout e HTML ----------
const evHtml = e => `<li class="ev-row"><div class="time">${e.time ? esc(e.time) : 'Tutto il g.'}</div><div class="ev-title">${esc(e.title)}</div></li>`;
const eventsOn = (a, b) => col.find({ date: { $gte: a, $lte: b } }).sort({ date: 1, time: 1 }).toArray();

const CSS = `
* { box-sizing: border-box; }
/* body: blocco totale dello scroll sulla dashboard */
body { margin: 0; background: #fff; color: #000; font-family: "Georgia", serif; overflow: hidden; }
a { color: #000; text-decoration: none; }

/* Navbar Superiore */
.nav { border-bottom: 4px solid #000; padding: 12px 16px; overflow: hidden; margin-bottom: 20px; }
.nav-btn { display: block; float: left; width: 22%; border: 3px solid #000; text-align: center; font-size: 22px; font-weight: bold; padding: 10px 0; background: #fff; color: #000; text-transform: uppercase; border-radius: 8px; }
.nav-btn.r { float: right; }
.nav-title { display: block; float: left; width: 56%; text-align: center; font-size: 38px; font-style: italic; font-weight: bold; line-height: 52px; }

.content { padding: 0 16px; }

/* Orologio e Data */
.clock { font-size: 160px; font-weight: bold; text-align: center; line-height: 1; margin: 10px 0 5px; letter-spacing: -4px; }
.date { font-size: 34px; text-align: center; text-transform: capitalize; margin-bottom: 25px; font-style: italic; }

/* Box Meteo */
.box { border: 4px solid #000; border-radius: 12px; padding: 16px; margin-bottom: 25px; }
.now { font-size: 42px; font-weight: bold; text-align: center; }

/* Eventi - L'altezza massima previene lo sbordamento dallo schermo */
.ev-box { max-height: 380px; overflow: hidden; }
h2 { font-size: 32px; margin: 0 0 16px; border-bottom: 3px solid #000; padding-bottom: 6px; text-transform: uppercase; letter-spacing: 2px; }
ul { padding: 0; margin: 0; list-style: none; }

/* Riga evento super definita */
.ev-row { overflow: hidden; margin-bottom: 14px; font-size: 28px; line-height: 1.2; }
.time { float: left; width: 120px; font-weight: bold; border-right: 3px solid #000; padding-right: 12px; margin-right: 12px; text-align: right; }
.ev-title { overflow: hidden; } /* Riempie automaticamente lo spazio restante senza rompere il layout */
`;

const page = (top, body, js = '') => `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Villa Gadaleta</title><style>${CSS}</style></head>
<body style="padding-top:${top}px">${body}<script>${js}</script></body></html>`;
const topOf = req => parseInt(req.query.top, 10) || 0;

// ---------- schermate Kindle ----------
async function dynamic() {
  const today = iso(new Date());
  const [w, ev] = [await weather(), await eventsOn(today, today)];
  
  const evList = ev.length 
    ? '<ul>' + ev.map(evHtml).join('') + '</ul>' 
    : '<ul><li class="ev-row"><div class="time">--:--</div><div class="ev-title">Nessun impegno in programma per oggi.</div></li></ul>';
    
  return weatherHtml(w) + `<div class="ev-box"><h2>Agenda di Oggi</h2>${evList}</div>`;
}

const getClockJs = (h, m, s, day, date, month) => `
var G=['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'];
var M=['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
function p(n){return n<10?'0'+n:''+n}
var h=${h}, m=${m}, s=${s}, day=${day}, date=${date}, month=${month};
var last='';
function tick(){
  s+=5; if(s>=60){s=0;m++;} if(m>=60){m=0;h++;}
  if(h>=24){location.reload();}
  var t=p(h)+':'+p(m);
  if(t!==last){
    last=t; document.getElementById('clock').innerHTML=t;
    document.getElementById('date').innerHTML=G[day]+' '+date+' '+M[month];
  }
}
tick();setInterval(tick,5000);
function refresh(){var x=new XMLHttpRequest();
  x.onreadystatechange=function(){if(x.readyState==4&&x.status==200){document.getElementById('dyn').innerHTML=x.responseText;}};
  x.open('GET','${BASE}/partial?'+(new Date().getTime()));x.send();}
setInterval(refresh,600000);`;

// HOMEPAGE: Dashboard Fissa
app.get(BASE + '/', async (req, res) => {
  const t = topOf(req);
  const d = new Date();
  const js = getClockJs(d.getHours(), d.getMinutes(), d.getSeconds(), d.getDay(), d.getDate(), d.getMonth());
  
  const nav = `
  <div class="nav">
    <a class="nav-btn" href="${BASE}/agenda?top=${t}">Agenda</a>
    <div class="nav-title">Villa Gadaleta</div>
    <a class="nav-btn r" href="${BASE}/?top=${t}">Aggiorna</a>
  </div>`;
  
  res.send(page(t, `
  ${nav}
  <div class="content">
    <div class="clock" id="clock">--:--</div>
    <div class="date" id="date"></div>
    <div id="dyn">${await dynamic()}</div>
  </div>`, js));
});

app.get(BASE + '/partial', async (req, res) => res.send(await dynamic()));

// AGENDA: Unica pagina dove lo scroll è concesso (sovrascrive overflow: hidden del body)
app.get(BASE + '/agenda', async (req, res) => {
  const t = topOf(req), start = new Date();
  const ev = await eventsOn(iso(start), iso(addDays(start, 6)));
  
  const nav = `
  <div class="nav">
    <a class="nav-btn" href="${BASE}/?top=${t}">&laquo; Home</a>
    <div class="nav-title">Agenda 7 Giorni</div>
    <div class="nav-btn r" style="border:none;background:transparent;color:transparent;">-</div>
  </div>`;

  let html = '<div class="content" style="padding-bottom:100px;">';
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i), list = ev.filter(e => e.date === iso(d));
    html += `<h2 style="font-size:28px; margin-top:20px;">${dayLabel(d)}</h2>` +
      (list.length ? '<ul>' + list.map(evHtml).join('') + '</ul>' : '<ul><li class="ev-row"><div class="time">&ndash;</div><div class="ev-title">Nessun impegno</div></li></ul>');
  }
  html += '</div>';
  
  res.send(page(t, nav + html).replace('overflow: hidden;', 'overflow: auto;'));
});

// ---------- pagina smartphone (admin) ----------
const fails = {};
function auth(req, res, next) {
  const f = fails[req.ip] || { n: 0, t: 0 };
  if (f.n >= 5 && Date.now() - f.t < 15 * 60 * 1000) return res.sendStatus(429);
  const pw = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':')[1];
  if (pw === PIN) { delete fails[req.ip]; return next(); }
  if (pw) fails[req.ip] = { n: f.n + 1, t: Date.now() };
  res.set('WWW-Authenticate', 'Basic realm="Casa"').sendStatus(401);
}
app.get('/admin', auth, async (req, res) => {
  const list = await eventsOn(iso(new Date()), '9999-12-31');
  res.send(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Aggiungi</title><style>body{font-family:sans-serif;max-width:480px;margin:auto;padding:16px}
input,button{width:100%;font-size:18px;padding:12px;margin:6px 0;box-sizing:border-box}
.r{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #ccc;padding:6px 0}
.r button{width:auto;padding:6px 12px}</style></head><body><h2>Nuovo impegno</h2>
<form method="post" action="/admin/add"><input name="title" placeholder="Cosa?" required>
<input type="date" name="date" value="${iso(new Date())}" required><input type="time" name="time">
<button>Aggiungi</button></form><h3>In programma</h3>` +
    list.map(e => `<form class="r" method="post" action="/admin/del"><span>${esc(e.date)} ${esc(e.time || '')} ${esc(e.title)}</span>
<input type="hidden" name="id" value="${e._id}"><button>✕</button></form>`).join('') + '</body></html>');
});
app.post('/admin/add', auth, async (req, res) => {
  const { title, date, time } = req.body;
  if (title && /^\d{4}-\d{2}-\d{2}$/.test(date)) await col.insertOne({ title: title.slice(0, 120), date, time: time || '' });
  res.redirect('/admin');
});
app.post('/admin/del', auth, async (req, res) => {
  await col.deleteOne({ _id: new ObjectId(req.body.id) });
  res.redirect('/admin');
});

MongoClient.connect(MONGO_URL).then(c => {
  col = c.db('kindle_calendar').collection('events');
  app.listen(PORT, '0.0.0.0', () => console.log('Avviato su porta ' + PORT));
}).catch(e => { console.error('MongoDB non raggiungibile:', e.message); process.exit(1); });