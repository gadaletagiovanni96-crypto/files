const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const PIN = process.env.ADMIN_PIN;                     // password pagina smartphone
const TOKEN = process.env.KINDLE_TOKEN;                // parte segreta dell'indirizzo del Kindle
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

// ---------- meteo (cache 30 min, lato server) ----------
const WMO = c => c === 0 ? 'Sereno' : c <= 2 ? 'Poco nuvoloso' : c === 3 ? 'Coperto' : c <= 48 ? 'Nebbia'
  : c <= 57 ? 'Pioviggine' : c <= 67 ? 'Pioggia' : c <= 77 ? 'Neve' : c <= 82 ? 'Rovesci' : c <= 86 ? 'Neve' : 'Temporale';
let wCache = { t: 0, data: null };

async function weather() {
  if (wCache.data && Date.now() - wCache.t < 30 * 60 * 1000) return wCache.data;
  try {
    const u = `https://api.weatherapi.com/v1/forecast.json?key=${process.env.WEATHER_KEY}&q=${LAT},${LON}&days=3&lang=it`;
    const res = await fetch(u);
    const data = await res.json();
    
    if (data.error) console.error("ERRORE WEATHERAPI:", data.error.message);
    
    wCache = { t: Date.now(), data };
  } catch (e) { 
    console.error("ERRORE FETCH METEO:", e.message); 
  }
  return wCache.data;
}

function weatherHtml(w) {
  if (!w || w.error || !w.forecast) return '<div class="box">Meteo non disponibile</div>';
  
  const d = w.forecast.forecastday;
  const names = ['Oggi', 'Domani', 'Dopodomani'];
  let rows = '';
  
  for (let i = 0; i < 3; i++) {
    if (!d[i]) continue;
    rows += `<tr><td>${names[i]}</td><td>${d[i].day.condition.text}</td>` +
      `<td>${Math.round(d[i].day.mintemp_c)}° / ${Math.round(d[i].day.maxtemp_c)}°</td>` +
      `<td>${d[i].day.daily_chance_of_rain}% pioggia</td></tr>`;
  }
  
  return `<div class="box"><div class="now">${Math.round(w.current.temp_c)}° ${w.current.condition.text}</div>` +
    `<table>${rows}</table></div>`;
}
function weatherHtml(w) {
  if (!w || w.error || !w.daily || !w.current) return '<div class="box">Meteo non disponibile</div>';
  const d = w.daily, names = ['Oggi', 'Domani', 'Dopodomani'];
  let rows = '';
  for (let i = 0; i < 3; i++) {
    rows += `<tr><td>${names[i]}</td><td>${WMO(d.weather_code[i])}</td>` +
      `<td>${Math.round(d.temperature_2m_min[i])}° / ${Math.round(d.temperature_2m_max[i])}°</td>` +
      `<td>${d.precipitation_probability_max[i]}% pioggia</td></tr>`;
  }
  return `<div class="box"><div class="now">${Math.round(w.current.temperature_2m)}° ${WMO(w.current.weather_code)}</div>` +
    `<table>${rows}</table></div>`;
}

// ---------- dati ----------
const evHtml = e => `<li><b>${e.time ? esc(e.time) : 'Tutto il giorno'}</b> &ndash; ${esc(e.title)}</li>`;
const eventsOn = (a, b) => col.find({ date: { $gte: a, $lte: b } }).sort({ date: 1, time: 1 }).toArray();

// ---------- layout (solo bianco/nero, niente flex, niente ES6 lato Kindle) ----------
const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#000;font-family:Georgia,serif;padding:0 16px 20px}
.clock{font-size:130px;font-weight:bold;text-align:center;line-height:1.1}
.date{font-size:34px;text-align:center;margin-bottom:14px;text-transform:capitalize}
.box{border:3px solid #000;padding:10px;margin:10px 0}
.now{font-size:38px;font-weight:bold;margin-bottom:6px}
table{width:100%;font-size:24px;border-collapse:collapse}td{padding:4px 6px;border-top:1px solid #000}
h2{font-size:32px;margin:14px 0 4px;border-bottom:3px solid #000}
ul{font-size:28px;padding-left:22px;margin:6px 0}li{margin:6px 0}
.btn{display:block;width:100%;border:3px solid #000;padding:18px;margin:10px 0;font-size:34px;font-weight:bold;
  text-align:center;color:#000;text-decoration:none;background:#fff}
.half{display:block;width:48%;float:left;margin-right:4%}.half.l{margin-right:0}
.cl{clear:both}`;
const page = (top, body, js = '') => `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Casa</title><style>${CSS}</style></head>
<body style="padding-top:${top}px">${body}<script>${js}</script></body></html>`;
const topOf = req => parseInt(req.query.top, 10) || 70; // spazio per la barra del browser Kindle (?top=100 per cambiarlo)

// ---------- schermate Kindle ----------
async function dynamic() {
  const today = iso(new Date());
  const [w, ev] = [await weather(), await eventsOn(today, today)];
  return weatherHtml(w) + '<h2>Oggi</h2>' +
    (ev.length ? '<ul>' + ev.map(evHtml).join('') + '</ul>' : '<ul><li>Nessun impegno</li></ul>');
}

const CLOCK_JS = `
var G=['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'];
var M=['gennaio','febbraio','marzo','aprile','maggio','giugno','luglio','agosto','settembre','ottobre','novembre','dicembre'];
function p(n){return n<10?'0'+n:''+n}
var last='';
function tick(){var d=new Date();var t=p(d.getHours())+':'+p(d.getMinutes());
 if(t!==last){last=t;document.getElementById('clock').innerHTML=t;
 document.getElementById('date').innerHTML=G[d.getDay()]+' '+d.getDate()+' '+M[d.getMonth()];}}
tick();setInterval(tick,5000);
function refresh(){var x=new XMLHttpRequest();
 x.onreadystatechange=function(){if(x.readyState==4&&x.status==200){document.getElementById('dyn').innerHTML=x.responseText;}};
 x.open('GET','${BASE}/partial?'+(new Date().getTime()));x.send();}
setInterval(refresh,600000);`;

app.get(BASE + '/', async (req, res) => {
  const t = topOf(req);
  res.send(page(t, `<div class="clock" id="clock">--:--</div><div class="date" id="date"></div>
<div id="dyn">${await dynamic()}</div>
<a class="btn half" href="${BASE}/agenda?top=${t}">AGENDA</a><a class="btn half l" href="${BASE}/?top=${t}">AGGIORNA</a><div class="cl"></div>`, CLOCK_JS));
});
app.get(BASE + '/partial', async (req, res) => res.send(await dynamic()));

app.get(BASE + '/agenda', async (req, res) => {
  const t = topOf(req), start = new Date();
  const ev = await eventsOn(iso(start), iso(addDays(start, 6)));
  let html = '<h2 style="margin-top:0">Prossimi 7 giorni</h2>';
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i), list = ev.filter(e => e.date === iso(d));
    html += `<h2 style="font-size:26px;text-transform:capitalize">${dayLabel(d)}</h2>` +
      (list.length ? '<ul>' + list.map(evHtml).join('') + '</ul>' : '<ul><li>&ndash;</li></ul>');
  }
  res.send(page(t, html + `<a class="btn" href="${BASE}/?top=${t}">&laquo; HOME</a>`));
});

// ---------- pagina smartphone (con PIN) ----------
const fails = {};
function auth(req, res, next) {
  const f = fails[req.ip] || { n: 0, t: 0 };
  if (f.n >= 5 && Date.now() - f.t < 15 * 60 * 1000) return res.sendStatus(429); // blocco 15 min dopo 5 errori
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
