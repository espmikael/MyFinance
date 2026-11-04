import * as L from './logic.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

// ---------------- utilidades ----------------
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => brl.format(Number(v) || 0);
const signed = v => (v < 0 ? '−' + money(-v) : money(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const longDay = iso => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, c => c.toUpperCase());
const num = v => { const n = L.parseAmount(v); return Number.isFinite(n) ? n : 0; };
const pct = v => `${Math.round(v * 100)}%`;
const today = () => L.todayISO();
const fmtIn = v => (v || v === 0) && Number(v) ? Number(v).toFixed(2).replace('.', ',') : '';

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 3400);
}

// ---------------- estado ----------------
const state = {
  user: null,
  settings: L.withDefaults(null),
  draft: null,           // cópia editável dos ajustes
  rules: [], txs: [], incomes: [], accounts: [], contributions: [],
  cycle: null,
  view: 'home',
  filter: 'all',
  q: '',                 // busca em Gastos
  incomeMonth: null,     // 'YYYY-MM' na tela de entradas
  month: null,           // 'YYYY-MM' no bloco do mês do painel
  busy: false,
};
let sb = null;

const card = () => L.primaryCard(state.settings);
const curCycle = () => L.cycleFor(today(), card().closing || 1);
const sources = () => L.sourcesOf(state.settings);
const sourceName = id => (sources().find(s => s.id === id) || { name: id || 'Nubank' }).name;
const sourceColor = id => (sources().find(s => s.id === id) || { color: '#8b8e92' }).color;
const catNames = () => state.settings.categories.map(c => c.name);

// ---------------- início ----------------
boot();

async function boot() {
  if (!window.supabase || SUPABASE_URL.startsWith('COLE_AQUI')) {
    $app.innerHTML = `<div class="center"><div class="login"><span class="brand">MyFinance</span>
      <p>Falta ligar o app ao seu banco. Abra <b>js/config.js</b> e cole a Project URL e a chave anon public do Supabase (veja o LEIAME).</p></div></div>`;
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  const { data } = await sb.auth.getSession();
  if (data.session) await enter(data.session.user);
  else renderLogin();
  sb.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') { state.user = null; renderLogin(); } });
}

async function enter(user) {
  state.user = user;
  $app.innerHTML = `<div class="center"><p class="help">Carregando…</p></div>`;
  try { await loadAll(); }
  catch (e) {
    $app.innerHTML = `<div class="center"><div class="login"><span class="brand">MyFinance</span>
      <p class="err">Não consegui ler o banco: ${esc(e.message || e)}</p>
      <p>Confira se o script <b>supabase/schema.sql</b> foi rodado no projeto.</p>
      <button class="btn" data-act="retry">Tentar de novo</button></div></div>`;
    return;
  }
  state.cycle = curCycle();
  render();
  listenRealtime();
}

// ---------------- dados ----------------
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

async function loadAll() {
  const uid = state.user.id;
  const s = await q(sb.from('settings').select('data').eq('user_id', uid).maybeSingle());
  if (s) state.settings = L.withDefaults(s.data);
  else await q(sb.from('settings').insert({ user_id: uid, data: state.settings }));

  state.rules = await q(sb.from('rules').select('id,keyword,category').order('id'));
  if (!state.rules.length) state.rules = await q(sb.from('rules').insert(L.DEFAULT_RULES).select('id,keyword,category'));

  await Promise.all([loadTxs(), loadSmall()]);
  if (s && (s.data.version || 1) < 2) await migrateV2(s.data);
}

// Uma vez só: troca as categorias antigas pelas rubricas da planilha (regras, compras classificadas e ajustes).
async function migrateV2(raw) {
  for (const r of state.rules) {
    const to = L.migrateCategory(r.category, r.keyword);
    if (to === undefined) continue;
    if (to === null) await sb.from('rules').delete().eq('id', r.id);
    else await sb.from('rules').update({ category: to }).eq('id', r.id);
  }
  const have = new Set(state.rules.map(r => L.normalize(r.keyword)));
  const missing = L.DEFAULT_RULES.filter(r => !have.has(L.normalize(r.keyword)));
  if (missing.length) await sb.from('rules').insert(missing);
  for (const t of state.txs) {
    const to = L.migrateCategory(t.category, t.title);
    if (to !== undefined) await sb.from('transactions').update({ category: to }).eq('id', t.id);
  }
  await saveSettings(L.migrateSettings(raw));
  state.rules = await q(sb.from('rules').select('id,keyword,category').order('id'));
  await loadTxs();
}

async function loadTxs() {
  const all = [];
  for (let from = 0; ; from += 1000) {
    const page = await q(sb.from('transactions').select('id,uid,date,title,amount,category,source,manual,created_at').order('date', { ascending: false }).order('id').range(from, from + 999));
    all.push(...page.map(t => ({ ...t, amount: Number(t.amount) })));
    if (page.length < 1000) break;
  }
  state.txs = all;
}

async function loadSmall() {
  const [inc, acc, con] = await Promise.all([
    q(sb.from('incomes').select('id,date,name,amount,rule_key').order('date')),
    q(sb.from('accounts').select('id,name,kind,balance,goal,note,updated_at').order('id')),
    q(sb.from('contributions').select('id,account_id,date,amount').order('date')),
  ]);
  state.incomes = inc.map(i => ({ ...i, amount: Number(i.amount) }));
  state.accounts = acc.map(a => ({ ...a, balance: Number(a.balance), goal: a.goal == null ? null : Number(a.goal) }));
  state.contributions = con.map(c => ({ ...c, amount: Number(c.amount) }));
}

async function reloadAll() {
  try {
    const s = await q(sb.from('settings').select('data').eq('user_id', state.user.id).maybeSingle());
    if (s) state.settings = L.withDefaults(s.data);
    state.rules = await q(sb.from('rules').select('id,keyword,category').order('id'));
    await Promise.all([loadTxs(), loadSmall()]);
    if (!document.querySelector('.sheet-bg') && !['ajustes', 'entradas'].includes(state.view)) render();
  } catch (e) { /* sem rede: mantém o que está na tela */ }
}

let realtimeTimer = null;
function listenRealtime() {
  if (!sb.channel) return;
  sb.channel('caixa').on('postgres_changes', { event: '*', schema: 'public' }, () => {
    clearTimeout(realtimeTimer);
    realtimeTimer = setTimeout(reloadAll, 700);
  }).subscribe();
}

async function saveSettings(next) {
  const { error } = await sb.from('settings').upsert({ user_id: state.user.id, data: next, updated_at: new Date().toISOString() });
  if (error) { toast('Não salvou: ' + error.message); return false; }
  state.settings = L.withDefaults(next);
  return true;
}

// ---------------- render ----------------
const VIEWS = [['home', 'Início'], ['gastos', 'Gastos'], ['painel', 'Painel'], ['reservas', 'Reservas'], ['ajustes', 'Ajustes']];

function render() {
  if (!state.user) return renderLogin();
  const s = summary(state.cycle);
  const tabView = state.view === 'entradas' ? 'ajustes' : state.view;
  const body = {
    home: () => viewHome(s), gastos: () => viewGastos(s), painel: () => viewPainel(s),
    reservas: viewReservas, ajustes: viewAjustes, entradas: viewEntradas,
  }[state.view]();
  $app.innerHTML = `
    <header class="top"><div class="top-in">
      <span class="brand">MyFinance</span>
      <nav class="topnav" aria-label="Seções">${VIEWS.map(([id, l]) => `<button data-act="view" data-v="${id}" ${tabView === id ? 'aria-current="page"' : ''}>${l}</button>`).join('')}</nav>
      <button class="plus" data-act="lancar" aria-label="Lançar gasto ou entrada">+</button>
      <button class="btn primary" data-act="upload" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Enviando…' : 'Enviar fatura'}</button>
    </div></header>
    <main class="wrap">${body}</main>
    <nav class="tabs" aria-label="Seções">${VIEWS.map(([id, l]) => `<button data-act="view" data-v="${id}" ${tabView === id ? 'aria-current="page"' : ''}>${l}</button>`).join('')}</nav>`;
  wireCharts();
}

function summary(cycle) {
  return L.summarize({ txs: state.txs, rules: state.rules, settings: state.settings, cycle, today: today(), incomes: state.incomes });
}

function cycleRow(s) {
  const c = card(), cur = curCycle(), t = today();
  const due = L.dueDateFor(s.cycle, c);
  return `<div class="cycle">
    <button class="icon-btn" data-act="prev" aria-label="Fatura anterior">‹</button>
    <div class="lbl"><b>${L.invoiceName(s.cycle, c, t)}</b><span>${L.dayMonth(s.cycle.start)}–${L.dayMonth(s.cycle.end)} · vence ${L.ddmm(due)}</span></div>
    <button class="icon-btn" data-act="next" aria-label="Próxima fatura" ${s.cycle.start >= cur.start ? 'disabled' : ''}>›</button>
    <div class="cal" role="img" aria-label="Hoje, ${longDay(t)}"><span>${L.MONTHS_SHORT[+t.slice(5, 7) - 1]}</span><span>${+t.slice(8, 10)}</span></div>
  </div>`;
}

// ----- Início -----
function viewHome(s) {
  if (!state.txs.length) {
    return `${cycleRow(s)}<div class="empty">
      <h2>Envie a primeira fatura</h2>
      <p>No app do Nubank, abra a fatura do cartão e exporte em CSV. Depois toque em <b>Enviar fatura</b> e escolha o arquivo.</p>
      <p>Para ver quanto sobra no mês, preencha suas entradas e gastos fixos em <b>Ajustes</b>.</p>
      <div class="actions"><button class="btn primary" data-act="upload">Enviar fatura</button><button class="btn" data-act="view" data-v="ajustes">Ir para Ajustes</button></div>
    </div>`;
  }
  const hasIncome = s.income > 0;
  const mName = L.MONTHS[+s.month.slice(5, 7) - 1];
  let label, value;
  if (!hasIncome) { label = 'Gasto no ciclo'; value = s.spent; }
  else if (s.isCurrent) { label = `Sobra prevista de ${mName}`; value = s.leftover; }
  else { label = `Sobra de ${mName}`; value = s.result; }
  const spentPct = s.budget > 0 ? Math.min(1, s.spent / s.budget) : 0;

  const facts = [
    ['Gasto no ciclo', money(s.spent)],
    ['Plano (tetos + fixos)', money(s.budget)],
    s.isCurrent ? ['Projeção até fechar', money(s.projected)] : [s.overBudget > 0 ? 'Passou dos tetos' : 'Abaixo dos tetos', money(Math.abs(s.overBudget))],
    ['Entradas − fixos', hasIncome ? money(s.available) : '—'],
  ];

  const rows = s.rows.map(r => {
    const w = Math.min(100, Math.round(r.pct * 100));
    let right;
    const fx = r.linked ? `fixos ${r.unpaidLinked ? `· ${money(r.unpaidLinked)} a pagar` : 'pagos'}` : '';
    if (r.status === 'over' && r.varBudget > 0) right = `<span class="wk over">teto estourado</span>`;
    else if (r.perWeek != null) right = `<span class="wk ${r.status === 'warn' ? 'warn' : ''}">${r.status === 'warn' ? 'acima do ritmo · ' : ''}${money(r.perWeek)} por semana</span>`;
    else if (fx) right = `<span class="tag">${fx}</span>`;
    else if (r.fixed) right = `<span class="tag">fixo</span>`;
    else right = '';
    const onlyFixed = r.varBudget === 0 && r.linked > 0 && r.varSpent <= 0;
    if (onlyFixed) right = `<span class="tag">fixo</span>`;
    const leftTxt = onlyFixed ? (r.unpaidLinked ? `${money(r.unpaidLinked)} a pagar` : 'pago') : signed(r.left);
    return `<li><button class="lrow" data-act="cat-open" data-c="${esc(r.name)}" aria-label="Ver gastos de ${esc(r.name)}"><div class="r1"><span class="name">${esc(r.name)}</span><span class="left ${!onlyFixed && r.left < 0 ? 'over' : ''}">${leftTxt}</span></div>
      <div class="meter" role="img" aria-label="${pct(r.pct)} do teto"><span class="${r.status === 'ok' ? '' : r.status}" style="width:${w}%"></span></div>
      <div class="r2"><span>${money(r.spent)} de ${money(r.budget)}</span>${right}</div></button></li>`;
  }).join('');

  return `${cycleRow(s)}
    ${uploadNudge()}
    ${s.isCurrent ? todayCard(s) : ''}
    <section class="hero">
      <div class="k">${label}</div>
      <div class="big ${hasIncome && value < 0 ? 'neg' : ''}">${signed(value)}</div>
      <div class="ruler" aria-hidden="true">
        <div class="bar"><div class="fill ${s.spent > s.budget ? 'over' : ''}" style="width:${Math.round(spentPct * 100)}%"></div></div>
        ${s.isCurrent ? `<div class="today" style="left:${(s.elapsed * 100).toFixed(1)}%"></div>` : ''}
        <div class="ticks"><span>${L.dayMonth(s.cycle.start)}</span>${s.isCurrent ? '<span>hoje</span>' : ''}<span>${L.dayMonth(s.cycle.end)}</span></div>
      </div>
      <div class="facts">${facts.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
    </section>
    ${s.toClassify.length ? `<div class="notice"><span>${s.toClassify.length === 1 ? '1 compra sem categoria' : `${s.toClassify.length} compras sem categoria`}</span><button class="btn primary small" data-act="classify">Classificar</button></div>` : ''}
    ${!hasIncome ? `<div class="notice"><span>Informe suas entradas para ver a sobra do mês.</span><button class="btn small" data-act="inc-edit">Entradas</button></div>` : ''}
    <h2 class="h2">Quanto resta <span class="h2-sub">toque para ver os gastos</span></h2>
    <ul class="ledger two">${rows}</ul>`;
}

function todayCard(s) {
  const end = L.dayMonth(s.cycle.end);
  if (s.perDay > 0) return `<section class="today-card">
      <div><span class="k">Hoje dá para gastar</span><b>${money(s.perDay)}</b></div>
      <small>${money(s.perDay * 7)} por semana · ${s.daysLeft} ${s.daysLeft === 1 ? 'dia' : 'dias'} até ${end}<br>conta só o que resta nos tetos, sem os fixos</small>
    </section>`;
  return `<section class="today-card over">
      <div><span class="k">Hoje dá para gastar</span><b>R$ 0</b></div>
      <small>Os tetos variáveis acabaram. Até ${end}, só o essencial.</small>
    </section>`;
}

// lembrete do envio semanal: última compra vinda de fatura
function uploadNudge() {
  const imported = state.txs.filter(t => !t.manual);
  if (!imported.length) return '';
  const last = imported.reduce((m, t) => { const d = (t.created_at || t.date).slice(0, 10); return d > m ? d : m; }, '');
  const days = L.daysBetween(last, today());
  if (days < 7) return '';
  return `<div class="notice"><span>Última fatura enviada há ${days} dias. Exporte o CSV do Nubank e atualize.</span><button class="btn primary small" data-act="upload">Enviar</button></div>`;
}

// ----- Gastos -----
function gastosList(s) {
  const known = new Set(catNames().concat([L.IGNORE]));
  const f = state.filter, qq = L.normalize(state.q);
  const list = s.txs.filter(t => f === 'all' ? true : f === 'unc' ? !known.has(t.cat) : f.startsWith('src:') ? (t.source || 'nubank') === f.slice(4) : f.startsWith('cat:') ? t.cat === f.slice(4) : true)
    .filter(t => !qq || L.normalize(`${t.title} ${L.prettyTitle(t.title)} ${t.cat} ${t.amount.toFixed(2).replace('.', ',')}`).includes(qq))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  if (!list.length) return `<p class="help" style="margin-top:20px">${qq ? 'Nada encontrado.' : 'Nada aqui neste ciclo.'}</p>`;
  const dayTotal = {};
  for (const t of list) if (t.cat !== L.IGNORE) dayTotal[t.date] = (dayTotal[t.date] || 0) + t.amount;
  let html = '', lastDay = null;
  for (const t of list) {
    if (t.date !== lastDay) { html += `<div class="day"><span>${longDay(t.date)}</span><span>${money(dayTotal[t.date] || 0)}</span></div>`; lastDay = t.date; }
    const isUnc = !known.has(t.cat);
    const sub = isUnc ? 'Sem categoria · toque para classificar' : `${t.cat === L.IGNORE ? 'Ignorado' : esc(t.cat)} · ${esc(sourceName(t.source))}${t.isFixed ? ` · fixo de ${L.MONTHS[+t.date.slice(5, 7) - 1]}` : t.manual ? ' · à mão' : ''}`;
    html += `<button class="tx ${t.cat === L.IGNORE ? 'ign' : ''}" data-act="tx" data-id="${t.id}">
      <span class="t"><span>${esc(L.prettyTitle(t.title))}</span><span class="c ${isUnc ? 'unc' : ''}">${sub}</span></span>
      <span class="v ${t.amount < 0 ? 'pos' : ''}">${signed(t.amount)}</span></button>`;
  }
  const sum = list.filter(t => t.cat !== L.IGNORE).reduce((a, t) => a + t.amount, 0);
  html += `<div class="total-line"><span>${list.length} ${list.length === 1 ? 'lançamento' : 'lançamentos'}</span><span>${signed(sum)}</span></div>`;
  return html;
}

function viewGastos(s) {
  const known = new Set(catNames().concat([L.IGNORE]));
  const unc = s.txs.filter(t => !known.has(t.cat));
  const srcIds = [...new Set(s.txs.map(t => t.source || 'nubank'))];
  const catsHere = catNames().filter(c => s.txs.some(t => t.cat === c));
  const f = state.filter;
  const chip = (id, label, extra = '') => `<button class="chip ${extra}" data-act="filter" data-f="${esc(id)}" aria-pressed="${f === id}">${label}</button>`;
  return `<h1 class="page-title">Gastos do ciclo</h1>
    <div class="k" style="margin-top:4px">${s.txs.length} ${s.txs.length === 1 ? 'lançamento' : 'lançamentos'} · ${money(s.txs.filter(t => t.cat !== L.IGNORE).reduce((a, t) => a + t.amount, 0))}</div>
    ${cycleRow(s)}
    <div class="search"><input class="input" id="gq" type="search" placeholder="Buscar loja, rubrica ou valor" value="${esc(state.q)}" aria-label="Buscar gastos"></div>
    <div class="chips" role="toolbar" aria-label="Filtrar">
      ${chip('all', 'Todos', 'all')}
      ${unc.length ? chip('unc', `Sem categoria · ${unc.length}`, 'flag') : ''}
      ${srcIds.map(id => chip('src:' + id, `<span class="dot" style="background:${sourceColor(id)}"></span>${esc(sourceName(id))}`)).join('')}
      ${catsHere.map(c => chip('cat:' + c, esc(c))).join('')}
    </div>
    <div id="txlist">${gastosList(s)}</div>`;
}

// ----- Painel -----
function niceMax(v) {
  if (v <= 0) return 100;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 4, 5, 10].map(m => m * p).find(m => m >= v);
}
const short = v => v >= 1000 ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `R$ ${Math.round(v)}`;

function lineChart(s, W, H, mobile) {
  const pts = s.cumulative.filter(p => !p.future);
  const n = s.cumulative.length;
  const last = pts.length ? pts[pts.length - 1].value : 0;
  const max = niceMax(Math.max(last, s.varBudget) * 1.06);
  const X = i => (n > 1 ? (i / (n - 1)) * W : 0);
  const Y = v => H - (Math.max(0, v) / max) * H;
  const poly = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join(' ');
  const by = Y(s.varBudget);
  const fs = mobile ? 11 : 12;
  const vb = mobile ? `-2 -${fs + 6} ${W + 4} ${H + fs * 2 + 16}` : `-62 -16 ${W + 70} ${H + 46}`;
  const ylabels = mobile
    ? [max, max / 2].map(v => `<text class="axis" x="0" y="${Y(v) - 4}">${short(v)}</text>`).join('')
    : [0, max / 2, max].map(v => `<text class="axis" x="-10" y="${Y(v) + 4}" text-anchor="end">${short(v)}</text>`).join('');
  const grid = [0, max / 4, max / 2, (3 * max) / 4, max].map(v => `<line class="grid" x1="0" x2="${W}" y1="${Y(v)}" y2="${Y(v)}"></line>`).join('');
  const oi = s.overDay ? s.cumulative.indexOf(s.overDay) : -1;
  const over = oi >= 0 ? `<circle class="pt" cx="${X(oi)}" cy="${Y(s.overDay.value)}" r="5"></circle>
    <text class="note" x="${X(oi) + 8}" y="${Y(s.overDay.value) + 18}" font-size="${fs}">passou dos tetos em ${L.ddmm(s.overDay.date)}</text>` : '';
  const li = pts.length - 1;
  const end = li >= 0 ? `<circle class="pt" cx="${X(li)}" cy="${Y(last)}" r="5"></circle>
    <text class="note" x="${X(li) - 8}" y="${Y(last) - 10}" text-anchor="end" font-size="${fs}">${money(last)}</text>` : '';
  const mid = Math.floor((n - 1) / 2);
  const data = esc(JSON.stringify({ W, H, n, max, vals: pts.map(p => p.value), dates: pts.map(p => p.date) }));
  return `<svg viewBox="${vb}" data-chart="${data}" role="img" aria-label="Gasto acumulado no ciclo: ${money(last)}${s.overDay ? `, passou da soma dos tetos em ${L.ddmm(s.overDay.date)}` : ''}">
    ${grid}${ylabels}
    ${s.varBudget > 0 ? `<line class="ref" x1="0" x2="${W}" y1="${by}" y2="${by}"></line>` : ''}
    <polyline class="ln" points="${poly}"></polyline>
    ${over}${end}
    <line class="cross" x1="0" x2="0" y1="0" y2="${H}" style="display:none"></line>
    <text class="axis" x="0" y="${H + fs + 8}" font-size="${fs}">${L.dayMonth(s.cycle.start)}</text>
    <text class="axis" x="${X(mid)}" y="${H + fs + 8}" text-anchor="middle" font-size="${fs}">${L.dayMonth(s.cumulative[mid].date)}</text>
    <text class="axis" x="${W}" y="${H + fs + 8}" text-anchor="end" font-size="${fs}">${L.dayMonth(s.cycle.end)}</text>
  </svg>`;
}

// ciclo cuja fatura vence no mês ym (fatura de novembro = ciclo 3/10–2/11)
function cycleForMonth(ym) {
  const closing = card().closing || 1;
  let c = L.cycleFor(`${ym}-15`, closing);
  for (let i = 0; i < 4 && L.monthOfCycle(c) !== ym; i++)
    c = L.shiftCycle(c.start, L.monthOfCycle(c) > ym ? -1 : 1, closing);
  return c;
}
const monthName = ym => L.MONTHS[+ym.slice(5, 7) - 1].replace(/^./, ch => ch.toUpperCase()) + (ym.slice(0, 4) === today().slice(0, 4) ? '' : ` de ${ym.slice(0, 4)}`);

function defaultMonth() {
  const closing = card().closing || 1;
  const prev = L.shiftCycle(curCycle().start, -1, closing);
  return today() <= L.dueDateFor(prev, card()) ? L.monthOfCycle(prev) : L.monthOfCycle(curCycle());
}

function monthBlock() {
  const ym = state.month || defaultMonth();
  const m = summary(cycleForMonth(ym));
  const c = card();
  const due = L.dueDateFor(m.cycle, c);
  const open = m.isCurrent;
  const canPay = ym <= today().slice(0, 7);
  const inc = m.incomeItems.map(i => `<div class="mrow">
      <span class="mn"><span>${esc(i.name)}</span><small>${L.ddmm(i.date)} · ${i.extra ? 'avulsa' : i.received ? 'recebida' : 'prevista'}</small></span>
      <span class="mv"><b class="${i.received ? '' : 'muted'}">${money(i.amount)}</b>
      ${i.received ? `<span class="pill ok">recebida ✓</span>` : `<button class="pill" data-act="income-confirm" data-key="${esc(i.key)}" data-ym="${i.target}">confirmar</button>`}</span></div>`).join('');
  const fix = m.fixedItems.map(f => `<div class="mrow">
      <span class="mn"><span>${esc(f.name)}</span><small>${esc(f.category || 'sem rubrica')}</small></span>
      <span class="mv"><b class="${f.paid ? '' : 'muted'}">${money(f.paid ? f.paidAmount : f.value)}</b>
      ${f.paid ? `<button class="pill ok" data-act="fix-unpay" data-id="${f.tx.id}" aria-label="${esc(f.name)} pago. Tocar para ver">pago ✓</button>`
        : canPay ? `<button class="pill" data-act="fix-pay" data-i="${f.index}" data-ym="${ym}">marcar pago</button>` : `<span class="pill ghost">a pagar</span>`}</span></div>`).join('');
  const sobra = open ? m.leftover : m.result;
  const cardOut = open ? m.varProjected : m.varSpent;
  return `<section class="card full month">
    <div class="mhead">
      <button class="icon-btn sm" data-act="month" data-d="-1" aria-label="Mês anterior">‹</button>
      <div><b>${monthName(ym)}</b><small>${esc(L.invoiceName(m.cycle, c, today()))} (${L.dayMonth(m.cycle.start)}–${L.dayMonth(m.cycle.end)}) · vence ${L.ddmm(due)}</small></div>
      <button class="icon-btn sm" data-act="month" data-d="1" aria-label="Próximo mês">›</button>
    </div>
    <div class="msum">
      <span class="k">${open ? 'Sobra prevista' : 'Sobra do mês'}</span>
      <b class="${m.income > 0 && sobra < 0 ? 'neg' : ''}">${m.income > 0 ? signed(sobra) : '—'}</b>
      <div class="mform">
        <span><small>Entradas</small>${money(m.income)}</span>
        <span><small>− Fixos</small>${money(m.fixedCost)}</span>
        <span><small>− Cartão${open ? ' (proj.)' : ''}</small>${money(cardOut)}</span>
      </div>
    </div>
    <div class="mgrid">
      <div class="mcol">
        <div class="mtitle"><span>Entradas</span><b>${money(m.income)}</b></div>
        ${inc || '<p class="help">Nenhuma entrada.</p>'}
        <div class="mact"><button class="btn small soft" data-act="inc-add" data-ym="${ym}">+ Recebimento</button><button class="btn small ghost" data-act="inc-edit" data-ym="${ym}">Editar valores</button></div>
      </div>
      <div class="mcol">
        <div class="mtitle"><span>Fixos</span><b>${money(m.fixedCost)}</b></div>
        ${fix || '<p class="help">Nenhum fixo. Aluguel, mestrado, plano do celular…</p>'}
        <div class="mact"><button class="btn small ghost" data-act="fix-edit">Editar fixos</button></div>
      </div>
    </div>
  </section>`;
}

function viewPainel(s) {
  const prev = summary(L.shiftCycle(s.cycle.start, -1, card().closing || 1));
  const prevTotal = prev.varSpent;
  const diff = prevTotal > 0 ? (s.varSpent - prevTotal) / prevTotal : null;
  const kpis = [
    ['Gasto no ciclo', money(s.varSpent), 'sem os fixos'],
    [s.overBudget > 0 ? 'Acima dos tetos' : 'Abaixo dos tetos', money(Math.abs(s.overBudget)), '', s.overBudget > 0 ? 'neg' : ''],
    s.isCurrent ? ['Projeção até fechar', money(s.varProjected), `hoje cabe ${money(s.perDay || 0)} por dia`] : ['Média por dia', money(s.varSpent / s.totalDays), `${s.totalDays} dias de ciclo`],
    ['Ciclo anterior', prevTotal > 0 ? money(prevTotal) : '—', diff != null && s.varSpent > 0 ? `este ciclo: ${diff >= 0 ? '+' : '−'}${pct(Math.abs(diff))}` : prevTotal > 0 ? 'fatura passada' : 'sem dados'],
  ];

  const maxBar = Math.max(1, ...s.rows.map(r => Math.max(r.spent, r.budget))) * 1.05;
  const bars = s.rows.filter(r => r.spent > 0 || r.budget > 0).sort((a, b) => b.spent - a.spent).map(r => `
    <div class="hbar" title="${esc(r.name)}: ${money(r.spent)} de ${money(r.budget)}">
      <div class="lab"><span>${esc(r.name)}</span><span><b>${money(r.spent)}</b> <span class="muted">de ${money(r.budget)}</span></span></div>
      <div class="trk"><div class="val" style="width:${(r.spent / maxBar * 100).toFixed(1)}%"></div>${r.budget > 0 ? `<div class="tick" style="left:${(r.budget / maxBar * 100).toFixed(1)}%"></div>` : ''}</div>
    </div>`).join('');

  const totalSrc = Object.values(s.bySource).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const allSrc = sources().filter(x => x.card || s.bySource[x.id]);
  const stack = allSrc.filter(x => (s.bySource[x.id] || 0) > 0).map(x => `<div style="width:${(s.bySource[x.id] / totalSrc * 100).toFixed(1)}%;background:${x.color}"></div>`).join('');
  const srcRows = allSrc.map(x => {
    const v = s.bySource[x.id];
    return `<div class="list-row ${v ? '' : 'muted'}"><span style="display:flex;align-items:center;gap:10px"><span class="dot" style="background:${x.color}"></span>${esc(x.name)}</span><span>${v ? `<b>${money(v)}</b>` : (x.card ? 'sem fatura' : 'nada lançado')}</span></div>`;
  }).join('');
  const top = s.topMerchants.map(m => `<div class="list-row"><span>${esc(m.label)}</span><b>${money(m.total)}</b></div>`).join('');

  return `<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap">
      <h1 class="page-title">Painel</h1></div>
    <div class="dash" style="margin-top:12px">${monthBlock()}</div>
    <h2 class="h2" style="margin-top:26px">Ciclo do cartão</h2>
    ${cycleRow(s)}
    <div class="kpis">${kpis.map(([k, v, sm, cls]) => `<div><span class="kl">${k}</span><b class="${cls || ''}">${v}</b>${sm ? `<small>${sm}</small>` : ''}</div>`).join('')}</div>
    ${!s.txs.length ? `<p class="help" style="margin-top:20px">Ainda não há gastos neste ciclo.</p>` : `
    <div class="dash" style="margin-top:16px">
      <section class="card">
        <h2 class="h2" style="margin-top:0">Ritmo do ciclo</h2>
        <div class="legend"><span><span class="sw-line"></span>Gasto acumulado (sem fixos)</span>${s.varBudget > 0 ? `<span><span class="sw-dash"></span>Soma dos tetos · ${money(s.varBudget)}</span>` : ''}</div>
        <div class="chart only-mob">${lineChart(s, 340, 150, true)}<div class="tip"></div></div>
        <div class="chart only-desk">${lineChart(s, 720, 220, false)}<div class="tip"></div></div>
      </section>
      <section class="card">
        <h2 class="h2" style="margin-top:0">Por origem</h2>
        <div class="stack" role="img" aria-label="Divisão do gasto por origem">${stack}</div>
        <div style="margin-top:8px">${srcRows}</div>
        <h2 class="h2">Onde mais gastou</h2>
        ${top || '<p class="help">Nada ainda.</p>'}
      </section>
      <section class="card full">
        <h2 class="h2" style="margin-top:0">Por rubrica</h2>
        <div class="legend"><span><span class="sw-bar"></span>Gasto</span><span><span class="sw-tick"></span>Teto + fixos</span></div>
        <div class="bars">${bars}</div>
      </section>
    </div>`}`;
}

function wireCharts() {
  document.querySelectorAll('.chart svg[data-chart]').forEach(svg => {
    const d = JSON.parse(svg.dataset.chart);
    const tip = svg.parentElement.querySelector('.tip');
    const cross = svg.querySelector('.cross');
    if (!d.vals.length) return;
    const vb = svg.viewBox.baseVal;
    const move = e => {
      const r = svg.getBoundingClientRect();
      const xv = vb.x + ((e.clientX - r.left) / r.width) * vb.width;
      const i = Math.max(0, Math.min(d.vals.length - 1, Math.round((xv / d.W) * (d.n - 1))));
      const x = d.n > 1 ? (i / (d.n - 1)) * d.W : 0;
      const y = d.H - (d.vals[i] / d.max) * d.H;
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.display = '';
      tip.textContent = `${L.dayMonth(d.dates[i])} · ${money(d.vals[i])}`;
      tip.style.left = `${((x - vb.x) / vb.width) * r.width}px`;
      tip.style.top = `${((y - vb.y) / vb.height) * r.height}px`;
      tip.classList.add('on');
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerleave', () => { tip.classList.remove('on'); cross.style.display = 'none'; });
  });
}

// ----- Reservas -----
function monthlyCost() {
  const st = state.settings;
  const fixed = (st.fixed || []).reduce((s, f) => s + (Number(f.value) || 0), 0);
  const budget = st.categories.reduce((s, c) => s + (Number(c.budget) || 0), 0);
  return fixed + budget;
}

function viewReservas() {
  const accs = state.accounts;
  const total = accs.reduce((s, a) => s + a.balance, 0);
  const lastUpd = accs.reduce((m, a) => (a.updated_at > m ? a.updated_at : m), '');
  const reserve = accs.find(a => a.kind === 'reserva');
  const cost = monthlyCost();
  const months = Number(state.settings.reserveMonths) || 6;
  const goal = reserve && reserve.goal ? reserve.goal : cost * months;
  const ym = today().slice(0, 7);
  const aporteMes = state.contributions.filter(c => c.date.slice(0, 7) === ym).reduce((s, c) => s + c.amount, 0);
  const aporteGoal = Number(state.settings.aporteGoal) || 0;
  const lastClosed = summary(L.shiftCycle(curCycle().start, -1, card().closing || 1));
  const negWarn = lastClosed.income > 0 && lastClosed.result < 0;

  const accRow = a => {
    const g = a.goal ? Math.min(1, a.balance / a.goal) : null;
    return `<button class="row" data-act="account" data-id="${a.id}" style="flex-direction:column;align-items:stretch">
      <span style="display:flex;justify-content:space-between;gap:10px"><span>${esc(a.name)}</span><b>${money(a.balance)}</b></span>
      ${g != null ? `<span class="meter"><span class="brand" style="width:${(g * 100).toFixed(1)}%"></span></span><span class="small muted">${pct(g)} de ${money(a.goal)}${a.note ? ' · ' + esc(a.note) : ''}</span>`
        : `<span class="small muted">${a.note ? esc(a.note) : 'sem meta'}</span>`}
    </button>`;
  };

  return `<h1 class="page-title">Reservas</h1>
    <div class="k" style="margin-top:18px">Total guardado</div>
    <div class="big md">${money(total)}</div>
    <div class="small muted">${lastUpd ? `Saldos atualizados em ${L.dayMonth(lastUpd.slice(0, 10))}` : 'Cadastre abaixo onde você guarda dinheiro.'}</div>
    <div class="actions"><button class="btn primary grow" data-act="aporte" ${accs.length ? '' : 'disabled'}>Registrar aporte</button><button class="btn grow" data-act="saldos" ${accs.length ? '' : 'disabled'}>Atualizar saldos</button></div>

    ${reserve ? `<section class="card">
      <div class="r1"><span class="h2" style="margin:0">Reserva de emergência</span><span class="muted small">${goal > 0 ? pct(Math.min(1, reserve.balance / goal)) : ''}</span></div>
      <button class="row" data-act="account" data-id="${reserve.id}" style="border:0;padding:6px 0 0"><span class="big md" style="font-size:36px;margin:0">${money(reserve.balance)}</span><span class="end">editar ›</span></button>
      <div class="meter" style="height:10px"><span class="brand" style="width:${goal > 0 ? Math.min(100, reserve.balance / goal * 100).toFixed(1) : 0}%"></span></div>
      <div class="r1 small muted"><span>Meta: ${reserve.goal ? 'definida por você' : `${months} meses de custo`}</span><span>${money(goal)}</span></div>
      ${cost > 0 ? `<p style="margin:10px 0 0;font-size:14px">Hoje ela cobre <b>${(reserve.balance / cost).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} ${reserve.balance / cost >= 1.95 ? 'meses' : 'mês'}</b> do seu custo de vida.</p>` : ''}
    </section>` : `<section class="card"><div class="h2" style="margin:0">Reserva de emergência</div>
      <p class="help">A meta sugerida é ${months} meses do seu custo${cost > 0 ? `: <b>${money(cost * months)}</b>` : ''}.</p>
      <button class="btn soft" data-act="account-new" data-kind="reserva">Criar reserva de emergência</button></section>`}

    ${aporteGoal > 0 ? `<section class="card soft">
      <div class="r1"><b>Aporte deste mês</b><span class="small" style="color:var(--brand-text)">${money(aporteMes)} de ${money(aporteGoal)}</span></div>
      <div class="meter"><span class="brand" style="width:${Math.min(100, aporteMes / aporteGoal * 100).toFixed(1)}%"></span></div>
      ${negWarn ? `<div class="small muted">A ${L.invoiceName(lastClosed.cycle, card(), today()).toLowerCase()} fechou no negativo. O aporte só cabe se este ciclo ficar dentro dos tetos.</div>` : ''}
    </section>` : ''}

    <h2 class="h2">Caixinhas</h2>
    ${accs.filter(a => a.kind === 'caixinha').map(accRow).join('')}
    <button class="row add" data-act="account-new" data-kind="caixinha">Nova caixinha</button>

    <h2 class="h2">Investimentos</h2>
    ${accs.filter(a => a.kind === 'investimento').map(accRow).join('')}
    <button class="row add" data-act="account-new" data-kind="investimento">Adicionar investimento</button>`;
}

// ----- Ajustes -----
function startDraft() { state.draft = structuredClone(state.settings); }

function fixedRowHTML(f, i, cats, path) {
  const names = cats.map(c => c.name);
  const opts = (names.includes(f.category) ? names : [f.category || '—', ...names]).map(n => `<option ${n === f.category ? 'selected' : ''}>${esc(n)}</option>`).join('');
  return `<div class="edit-row fixed-row">
      <input class="input" data-bind="${path}.${i}.name" value="${esc(f.name)}" aria-label="Nome do gasto fixo" placeholder="ex.: aluguel">
      <input class="input" data-bind="${path}.${i}.value" data-type="money" inputmode="decimal" value="${fmtIn(f.value)}" aria-label="Valor" placeholder="valor">
      <select class="input" data-bind="${path}.${i}.category" aria-label="Rubrica">${opts}</select>
      <button class="icon-btn sm" data-act="del" data-path="${path}" data-i="${i}" aria-label="Remover">×</button></div>`;
}

function viewAjustes() {
  if (!state.draft) startDraft();
  const d = state.draft;
  const income = (state.settings.incomeRules || []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const fixed = (d.fixed || []).map((f, i) => fixedRowHTML(f, i, d.categories, 'fixed')).join('');
  const cards = d.cards.map((c, i) => `<div class="edit-row card">
      <input class="input" data-bind="cards.${i}.name" value="${esc(c.name)}" aria-label="Nome do cartão">
      <input class="input" data-bind="cards.${i}.closing" data-type="int" inputmode="numeric" value="${c.closing ?? ''}" aria-label="Dia do fechamento" placeholder="fecha">
      <input class="input" data-bind="cards.${i}.due" data-type="int" inputmode="numeric" value="${c.due ?? ''}" aria-label="Dia do vencimento" placeholder="vence">
      <button class="icon-btn sm" data-act="del" data-path="cards" data-i="${i}" aria-label="Remover cartão" ${c.primary ? 'disabled' : ''}>×</button></div>`).join('');
  const cats = d.categories.map((c, i) => `<div class="edit-row cat">
      <input class="input" data-bind="categories.${i}.name" value="${esc(c.name)}" aria-label="Categoria">
      <input class="input" data-bind="categories.${i}.budget" data-type="money" inputmode="decimal" value="${fmtIn(c.budget)}" aria-label="Teto">
      <label class="check"><input type="checkbox" data-bind="categories.${i}.fixed" data-type="bool" ${c.fixed ? 'checked' : ''}> fixo</label>
      <button class="icon-btn sm" data-act="del" data-path="categories" data-i="${i}" aria-label="Remover categoria">×</button></div>`).join('');
  const rules = [...state.rules].sort((a, b) => a.category.localeCompare(b.category) || a.keyword.localeCompare(b.keyword))
    .map(r => `<div class="row"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.keyword)}</span><span style="display:flex;align-items:center;gap:10px"><span class="end small">${esc(r.category)}</span><button class="icon-btn sm" data-act="del-rule" data-id="${r.id}" aria-label="Apagar regra">×</button></span></div>`).join('');
  const theme = document.documentElement.dataset.theme || 'auto';

  return `<h1 class="page-title">Ajustes</h1>
    <h2 class="h2">O mês</h2>
    <button class="row" data-act="view" data-v="entradas"><span>Entradas · salário e vintena</span><span class="end"><b style="color:var(--text)">${income ? money(income) : 'informar'}</b> ›</span></button>
    <div class="lbl" style="margin-top:14px">Gastos fixos fora do cartão</div>
    <p class="help small" style="margin-top:2px">Cada fixo entra na rubrica escolhida. Quando você pagar (no Painel, "marcar pago", ou lançando com o mesmo nome), ele não é contado duas vezes.</p>
    ${fixed}
    <button class="row add" data-act="add" data-path="fixed">Adicionar gasto fixo</button>

    <h2 class="h2">Cartões</h2>
    <p class="help">Nome, dia em que a fatura fecha e dia em que vence. O primeiro é o principal: ele define o ciclo do app.</p>
    ${cards}
    <button class="row add" data-act="add" data-path="cards">Adicionar cartão (ex.: Renner)</button>

    <h2 class="h2">Rubricas e tetos</h2>
    <p class="help">O teto é o que você pode gastar variando (cartão, Pix, à mão). Os fixos da rubrica somam por cima. Marque "fixo" na rubrica que não varia no mês: ela fica fora do "por semana".</p>
    <button class="btn soft small" data-act="suggest" style="margin:4px 0 6px">Sugerir tetos pela média dos últimos ciclos</button>
    ${cats}
    <button class="row add" data-act="add" data-path="categories">Adicionar rubrica</button>

    <h2 class="h2">Reservas</h2>
    <div class="grid2">
      <div class="field"><label for="rm">Meses na reserva de emergência</label><input class="input" id="rm" data-bind="reserveMonths" data-type="int" inputmode="numeric" value="${d.reserveMonths ?? 6}"></div>
      <div class="field"><label for="ag">Meta de aporte por mês</label><input class="input" id="ag" data-bind="aporteGoal" data-type="money" inputmode="decimal" value="${fmtIn(d.aporteGoal)}"></div>
    </div>
    <div class="actions"><button class="btn primary" data-act="save-draft">Salvar ajustes</button></div>

    <h2 class="h2">Regras de categoria</h2>
    <p class="help">Se a descrição da compra tem a palavra, ela vai para a categoria. A palavra mais específica vence.</p>
    <div class="edit-row" style="grid-template-columns:1fr 1fr auto">
      <input class="input" id="new-kw" placeholder="ex.: supermercado" aria-label="Palavra">
      <select class="input" id="new-cat" aria-label="Categoria">${[...catNames(), L.IGNORE].map(n => `<option>${esc(n)}</option>`).join('')}</select>
      <button class="btn" data-act="add-rule">Adicionar</button>
    </div>
    ${rules}

    <h2 class="h2">Aparência</h2>
    <div class="seg" role="group" aria-label="Tema" style="display:inline-flex">
      ${[['auto', 'Automático'], ['dark', 'Escuro'], ['light', 'Claro']].map(([v, l]) => `<button data-act="theme" data-t="${v}" aria-pressed="${theme === v}">${l}</button>`).join('')}
    </div>

    <h2 class="h2">Seus dados</h2>
    <p class="help">Baixe tudo (gastos, entradas, reservas, regras e ajustes) num arquivo. Serve de backup.</p>
    <div class="actions" style="margin-top:8px"><button class="btn" data-act="export">Exportar tudo</button><button class="btn danger" data-act="logout">Sair</button></div>
    <p class="help small" style="margin-top:14px">Conectado como ${esc(state.user.email)}.</p>`;
}

// ----- Entradas -----
function viewEntradas() {
  if (!state.draft) startDraft();
  const ym = state.incomeMonth || today().slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const sched = L.incomeSchedule(state.settings.incomeRules, y, m);
  const recvd = state.incomes.filter(i => i.date.slice(0, 7) === ym);
  const received = recvd.reduce((s, i) => s + i.amount, 0);
  const extras = recvd.filter(i => !i.rule_key || !sched.some(s => s.key === i.rule_key));
  const expected = sched.reduce((s, i) => s + i.amount, 0) + extras.reduce((s, i) => s + i.amount, 0);

  const c = card();
  const dueISO = `${ym}-${String(c.due || 10).padStart(2, '0')}`;
  const before = sched.filter(i => i.date <= dueISO).pop();
  const dueCycle = L.cycleFor(L.addDays(dueISO, -((c.due || 10) > (c.closing || 1) ? (c.due - c.closing + 1) : 1)), c.closing || 1);
  const invName = L.invoiceName(dueCycle, c, today()).toLowerCase();

  const calTile = iso => `<div class="cal mute" role="img" aria-label="${longDay(iso)}"><span>${L.MONTHS_SHORT[+iso.slice(5, 7) - 1]}</span><span>${+iso.slice(8, 10)}</span></div>`;
  const rows = sched.map(it => {
    const got = recvd.find(i => i.rule_key === it.key);
    return `<div class="list-row" style="gap:12px">
      ${calTile(got ? got.date : it.date)}
      <div style="flex:1;min-width:0;display:flex;flex-direction:column"><b>${esc(it.name)}</b><span class="small muted">${got ? 'recebida' : esc(it.why)}</span></div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
        <b>${money(got ? got.amount : it.amount)}</b>
        ${got ? `<button class="btn small ghost" data-act="income-undo" data-id="${got.id}">Desfazer</button>` : `<button class="btn small soft" data-act="income-confirm" data-key="${esc(it.key)}" data-ym="${ym}">Confirmar</button>`}
      </div></div>`;
  }).join('') + extras.map(i => `<div class="list-row" style="gap:12px">${calTile(i.date)}
      <div style="flex:1;min-width:0;display:flex;flex-direction:column"><b>${esc(i.name)}</b><span class="small muted">avulsa</span></div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px"><b>${money(i.amount)}</b><button class="btn small ghost" data-act="income-undo" data-id="${i.id}">Apagar</button></div></div>`).join('');

  const d = state.draft;
  const ruleForms = (d.incomeRules || []).map((r, i) => `<div class="card" style="margin-top:10px">
      <div class="edit-row" style="grid-template-columns:1fr 120px 36px;margin-top:0">
        <input class="input" data-bind="incomeRules.${i}.name" value="${esc(r.name)}" aria-label="Nome da entrada">
        <input class="input" data-bind="incomeRules.${i}.amount" data-type="money" inputmode="decimal" value="${fmtIn(r.amount)}" aria-label="Valor esperado" placeholder="valor">
        <button class="icon-btn sm" data-act="del" data-path="incomeRules" data-i="${i}" aria-label="Remover entrada fixa">×</button>
      </div>
      <div class="edit-row" style="grid-template-columns:1fr 80px;">
        <select class="input" data-bind="incomeRules.${i}.type" aria-label="Quando cai">
          <option value="businessDay" ${r.type === 'businessDay' ? 'selected' : ''}>Dia útil do mês (nº)</option>
          <option value="day" ${r.type === 'day' ? 'selected' : ''}>Dia fixo do mês</option>
        </select>
        <input class="input" data-bind="incomeRules.${i}.${r.type === 'businessDay' ? 'n' : 'day'}" data-type="int" inputmode="numeric" value="${r.type === 'businessDay' ? (r.n ?? 5) : (r.day ?? 20)}" aria-label="${r.type === 'businessDay' ? 'Qual dia útil' : 'Dia do mês'}">
      </div>
      ${r.type === 'day' ? `<label class="check" style="margin-top:4px"><input type="checkbox" data-bind="incomeRules.${i}.shift" data-type="shift" ${r.shift !== 'after' ? 'checked' : ''}> Se cair em fim de semana ou feriado, vem antes</label>` : ''}
      <label class="check" style="margin-top:4px;white-space:normal"><input type="checkbox" data-bind="incomeRules.${i}.monthOffset" data-type="offset" ${Number(r.monthOffset) === 1 ? 'checked' : ''}> Cai no mês seguinte ao de referência (ex.: o salário de outubro cai em novembro)</label>
    </div>`).join('');

  return `<div class="cycle" style="margin-top:6px">
      <button class="icon-btn" data-act="view" data-v="ajustes" aria-label="Voltar para Ajustes">‹</button>
      <h1 class="page-title" style="margin:0">Entradas</h1>
    </div>
    <div class="cycle">
      <button class="icon-btn sm" data-act="inc-month" data-d="-1" aria-label="Mês anterior">‹</button>
      <b>${L.MONTHS[m - 1].replace(/^./, ch => ch.toUpperCase())} de ${y}</b>
      <button class="icon-btn sm" data-act="inc-month" data-d="1" aria-label="Próximo mês">›</button>
    </div>
    <div class="k" style="margin-top:16px">Previsto no mês</div>
    <div class="big md">${money(expected)}</div>
    <div class="small muted">Recebido até agora <b style="color:var(--text)">${money(received)}</b></div>
    <h2 class="h2">Este mês</h2>
    ${rows || '<p class="help">Nenhuma entrada fixa configurada. Adicione abaixo.</p>'}
    <button class="row add" data-act="lancar" data-mode="entrada">Registrar outra entrada</button>
    ${before ? `<div class="card soft" style="font-size:14px">${esc(before.name)} de <b>${L.ddmm(before.date)}</b> paga a ${esc(invName)}, que vence em <b>${L.ddmm(dueISO)}</b>${L.daysBetween(before.date, dueISO) <= 1 ? '. Folga de um dia só: se a entrada atrasar, a fatura atrasa junto.' : '.'}</div>`
      : sched.length ? `<div class="card soft" style="font-size:14px">Nenhuma entrada cai antes do vencimento da fatura (${L.ddmm(dueISO)}).</div>` : ''}

    <h2 class="h2">Entradas fixas</h2>
    <p class="help">O valor é o esperado; ao confirmar, você ajusta o que caiu de fato.</p>
    ${ruleForms}
    <button class="row add" data-act="add" data-path="incomeRules">Adicionar entrada fixa</button>
    <div class="actions"><button class="btn primary" data-act="save-draft">Salvar entradas fixas</button></div>`;
}

// ---------------- eventos ----------------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('.sheet-bg')) return;
  const act = el.dataset.act;
  const closing = card().closing || 1;
  switch (act) {
    case 'retry': return enter(state.user);
    case 'view':
      if (['ajustes', 'entradas'].includes(el.dataset.v) && !['ajustes', 'entradas'].includes(state.view)) startDraft();
      if (!['ajustes', 'entradas'].includes(el.dataset.v)) state.draft = null;
      state.view = el.dataset.v; state.filter = 'all'; state.q = ''; render(); window.scrollTo(0, 0); return;
    case 'upload': return pickFile();
    case 'lancar': return lancarSheet(el.dataset.mode || 'gasto');
    case 'prev': state.cycle = L.shiftCycle(state.cycle.start, -1, closing); return render();
    case 'next': if (state.cycle.start < curCycle().start) { state.cycle = L.shiftCycle(state.cycle.start, 1, closing); render(); } return;
    case 'classify': state.view = 'gastos'; state.filter = 'unc'; render(); window.scrollTo(0, 0); return;
    case 'filter': state.filter = el.dataset.f; { const y = window.scrollY; render(); window.scrollTo(0, y); } return;
    case 'tx': return txSheet(Number(el.dataset.id));
    case 'add': return addDraftRow(el.dataset.path);
    case 'del': state.draft[el.dataset.path].splice(Number(el.dataset.i), 1); return render();
    case 'save-draft': return saveDraft();
    case 'add-rule': return addRule();
    case 'del-rule': return delRule(Number(el.dataset.id));
    case 'theme': return setTheme(el.dataset.t);
    case 'export': return exportAll();
    case 'logout': return sb.auth.signOut();
    case 'inc-month': {
      const base = (state.incomeMonth || today().slice(0, 7)) + '-01';
      state.incomeMonth = L.addMonths(base, Number(el.dataset.d)).slice(0, 7); return render();
    }
    case 'income-confirm': return confirmIncomeSheet(el.dataset.key, el.dataset.ym);
    case 'income-undo': return undoIncome(Number(el.dataset.id));
    case 'account': return accountSheet(state.accounts.find(a => a.id === Number(el.dataset.id)));
    case 'account-new': return accountSheet(null, el.dataset.kind);
    case 'aporte': return aporteSheet();
    case 'saldos': return saldosSheet();
    case 'month': {
      const base = (state.month || today().slice(0, 7)) + '-01';
      state.month = L.addMonths(base, Number(el.dataset.d)).slice(0, 7); return render();
    }
    case 'inc-add': return lancarSheet('entrada', dateInMonth(el.dataset.ym));
    case 'inc-edit': return incomeEditSheet(el.dataset.ym || L.monthOfCycle(state.cycle));
    case 'fix-edit': return fixedSheet();
    case 'cat-open': state.view = 'gastos'; state.filter = 'cat:' + el.dataset.c; state.q = ''; render(); window.scrollTo(0, 0); return;
    case 'suggest': return suggestSheet();
    case 'fix-pay': return payFixed(Number(el.dataset.i), el.dataset.ym);
    case 'fix-unpay': return txSheet(Number(el.dataset.id));
  }
});

// data padrão para um lançamento do mês ym: hoje, se for o mês atual; senão o 1º (ou o último, se já passou)
function dateInMonth(ym) {
  const t = today();
  if (!ym || t.slice(0, 7) === ym) return t;
  if (ym > t.slice(0, 7)) return `${ym}-01`;
  return L.addDays(L.addMonths(`${ym}-01`, 1), -1);
}

async function payFixed(i, ym) {
  const f = (state.settings.fixed || [])[i];
  if (!f) return;
  const row = { user_id: state.user.id, uid: `fixed|${i}|${ym}|${Date.now().toString(36)}`, date: dateInMonth(ym), title: f.name,
    amount: Number(f.value) || 0, source: 'pix', category: f.category || null, manual: true };
  const { error } = await sb.from('transactions').insert(row);
  if (error) return toast('Não salvou: ' + error.message);
  await loadTxs(); render(); toast(`${f.name} marcado como pago (Pix, ${money(row.amount)}). Toque nele para mudar.`);
}

// edição dos ajustes: cada campo escreve direto no rascunho
document.addEventListener('input', e => {
  if (e.target.id === 'gq') { state.q = e.target.value; const box = document.getElementById('txlist'); if (box) box.innerHTML = gastosList(summary(state.cycle)); return; }
  bindInput(e.target);
});
document.addEventListener('change', e => {
  bindInput(e.target);
  if (e.target.dataset.bind && /\.type$/.test(e.target.dataset.bind)) render();
});
function bindInput(el) {
  const path = el.dataset && el.dataset.bind;
  if (!path || !state.draft || el.closest('.sheet-bg')) return;
  const t = el.dataset.type;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (t === 'money') v = num(v);
  else if (t === 'int') v = v === '' ? null : parseInt(v, 10) || null;
  else if (t === 'shift') v = el.checked ? 'before' : 'after';
  else if (t === 'offset') v = el.checked ? 1 : 0;
  const keys = path.split('.');
  let o = state.draft;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = v;
}

const PALETTE = ['#e66767', '#3987e5', '#c98500', '#d55181', '#199e70'];
function addDraftRow(path) {
  const d = state.draft;
  if (path === 'fixed') d.fixed.push({ name: '', value: 0, category: 'Casa' });
  if (path === 'categories') d.categories.push({ name: 'Nova categoria', budget: 0, fixed: false });
  if (path === 'cards') {
    const name = 'Novo cartão';
    d.cards.push({ id: L.slug(name) + '-' + Date.now().toString(36).slice(-4), name, closing: null, due: null, color: PALETTE[d.cards.length % PALETTE.length], primary: false });
  }
  if (path === 'incomeRules') d.incomeRules.push({ key: 'extra-' + Date.now().toString(36), name: 'Nova entrada', type: 'day', day: 1, shift: 'before', amount: 0, monthOffset: 0 });
  render();
}

async function saveDraft() {
  const d = structuredClone(state.draft);
  d.fixed = d.fixed.filter(f => f.name || f.value);
  d.categories = d.categories.filter(c => c.name.trim());
  for (const c of d.cards) { if (c.closing) c.closing = Math.min(28, Math.max(1, c.closing)); if (c.due) c.due = Math.min(31, Math.max(1, c.due)); }
  if (!d.cards.some(c => c.primary)) d.cards[0].primary = true;
  if (await saveSettings(d)) {
    startDraft();
    state.cycle = L.cycleFor(state.cycle.start, card().closing || 1);
    render(); toast('Ajustes salvos.');
  }
}

async function addRule() {
  const kw = L.normalize(document.getElementById('new-kw').value);
  const cat = document.getElementById('new-cat').value;
  if (!kw) return toast('Escreva uma palavra para a regra.');
  const { data, error } = await sb.from('rules').insert({ keyword: kw, category: cat }).select('id,keyword,category').single();
  if (error) return toast('Não salvou: ' + error.message);
  state.rules.push(data); render(); toast('Regra adicionada.');
}

async function delRule(id) {
  const { error } = await sb.from('rules').delete().eq('id', id);
  if (error) return toast('Não apagou: ' + error.message);
  state.rules = state.rules.filter(r => r.id !== id); render(); toast('Regra apagada.');
}

function setTheme(t) {
  try { if (t === 'auto') localStorage.removeItem('caixa-theme'); else localStorage.setItem('caixa-theme', t); } catch (e) {}
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  render();
}

function exportAll() {
  const data = { exportado_em: new Date().toISOString(), ajustes: state.settings, regras: state.rules, gastos: state.txs, entradas: state.incomes, reservas: state.accounts, aportes: state.contributions };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `myfinance-backup-${today()}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Backup baixado.');
}

async function undoIncome(id) {
  const { error } = await sb.from('incomes').delete().eq('id', id);
  if (error) return toast('Não apagou: ' + error.message);
  state.incomes = state.incomes.filter(i => i.id !== id); render();
}

// ---------------- folhas ----------------
function openSheet(html, onMount) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${html}</div>`;
  document.body.appendChild(bg);
  const prevFocus = document.activeElement;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); prevFocus && prevFocus.focus && prevFocus.focus(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  const sh = bg.querySelector('.sheet');
  sh.$ = sel => sh.querySelector(sel);
  sh.$$ = sel => [...sh.querySelectorAll(sel)];
  onMount && onMount(sh, close);
  (sh.querySelector('[autofocus]') || sh.querySelector('button, input'))?.focus();
  return { sh, close };
}

function pickChips(sh, attr, onPick) {
  sh.$$(`[data-${attr}]`).forEach(b => b.addEventListener('click', () => {
    sh.$$(`[data-${attr}]`).forEach(x => x.setAttribute('aria-pressed', x === b));
    onPick(b.dataset[attr]);
  }));
}

// ----- Enviar fatura -----
function pickFile() {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.csv,text/csv,text/plain';
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    const parsed = L.parseInvoiceCSV(await f.text());
    if (parsed.error) return toast(parsed.error);
    uploadSheet(f.name, parsed);
  });
  input.click();
}

function uploadSheet(fileName, parsed) {
  const cards = state.settings.cards;
  let chosen = parsed.bank && cards.some(c => c.id === parsed.bank) ? parsed.bank : null;
  const dates = parsed.rows.map(r => r.date).sort();
  const known = new Set(state.txs.map(t => t.uid));

  const html = `<h2>Enviar fatura</h2>
    <div class="file" style="margin-top:14px">
      <svg width="24" height="30" viewBox="0 0 28 34" aria-hidden="true"><path d="M3 1h15l7 7v23a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.5"></path><path d="M18 1v7h7" fill="none" stroke="currentColor" stroke-width="1.5"></path></svg>
      <div class="t"><span>${esc(fileName)}</span><span class="small muted">${parsed.rows.length} lançamentos · ${L.dayMonth(dates[0])} a ${L.dayMonth(dates[dates.length - 1])}</span></div>
      <button class="btn small ghost" data-swap>Trocar</button>
    </div>
    <div class="lbl" style="margin-top:20px">De qual cartão é?</div>
    <div class="wrapchips">${cards.map(c => `<button class="chip" data-card="${esc(c.id)}" aria-pressed="${c.id === chosen}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</button>`).join('')}</div>
    <p class="help small" style="margin:8px 0 0">${parsed.bank ? 'Reconhecido pelo formato do arquivo. Confira antes de adicionar.' : 'Não reconheci o banco pelo formato. Escolha o cartão.'}</p>
    <div class="sumbox" data-sum></div>
    <div class="actions"><button class="btn primary grow" data-go disabled>Escolha o cartão</button><button class="btn ghost" data-close>Cancelar</button></div>`;

  openSheet(html, (sh, close) => {
    let fresh = [], toAdd = [], forceSuspects = false;
    const update = () => {
      if (!chosen) { sh.$('[data-sum]').innerHTML = `<div><span>Compras na fatura</span><b>${parsed.rows.length}</b></div>`; return; }
      const rows = L.fingerprint(parsed.rows, chosen);
      fresh = rows.filter(r => !known.has(r.uid));
      const { suspects, otherSource } = L.findSuspects(rows, fresh, state.txs, chosen);
      toAdd = forceSuspects ? fresh : fresh.filter(r => !suspects.has(r.uid));
      const unc = toAdd.filter(r => !L.matchRule(r.title, state.rules)).length;
      const wrongCard = otherSource && otherSource.count >= Math.max(3, rows.length * 0.5);
      sh.$('[data-sum]').innerHTML = `<div><span>Compras novas</span><b>${toAdd.length}</b></div>
        <div><span>Já estavam no app</span><span>${rows.length - fresh.length}</span></div>
        ${suspects.size ? `<div><span>Parecem repetidas (descrição ou valor mudou)</span><span>${suspects.size}</span></div>` : ''}
        <div><span>Sem categoria</span><span>${unc}</span></div>
        ${suspects.size ? `<label class="check" style="margin-top:6px"><input type="checkbox" data-force ${forceSuspects ? 'checked' : ''}> Adicionar as que parecem repetidas mesmo assim</label>` : ''}
        ${wrongCard ? `<div style="color:var(--over)">Essas compras já estão no app como ${esc(sourceName(otherSource.id))}. Confira o cartão escolhido.</div>` : ''}`;
      sh.$('[data-force]')?.addEventListener('change', e => { forceSuspects = e.target.checked; update(); });
      const go = sh.$('[data-go]');
      go.disabled = !toAdd.length || wrongCard;
      go.textContent = wrongCard ? 'Cartão errado?' : toAdd.length ? `Adicionar ${toAdd.length} ${toAdd.length === 1 ? 'compra' : 'compras'}` : 'Nada novo nesta fatura';
    };
    pickChips(sh, 'card', id => { chosen = id; forceSuspects = false; update(); });
    sh.$('[data-swap]').addEventListener('click', () => { close(); pickFile(); });
    sh.$('[data-go]').addEventListener('click', async () => {
      const go = sh.$('[data-go]'); go.disabled = true; go.textContent = 'Enviando…';
      fresh = toAdd;
      for (let i = 0; i < fresh.length; i += 500) {
        const chunk = fresh.slice(i, i + 500).map(r => ({ ...r, user_id: state.user.id, manual: false }));
        const { error } = await sb.from('transactions').upsert(chunk, { onConflict: 'user_id,uid', ignoreDuplicates: true });
        if (error) { toast('Não enviou: ' + error.message); go.disabled = false; update(); return; }
      }
      await loadTxs();
      const latest = fresh.reduce((m, r) => (r.date > m ? r.date : m), fresh[0].date);
      state.cycle = L.cycleFor(latest, card().closing || 1);
      state.view = 'home';
      close(); render();
      toast(`${fresh.length} ${fresh.length === 1 ? 'compra adicionada' : 'compras adicionadas'}.`);
    });
    update();
  });
}

// ----- Lançar gasto ou entrada -----
function lancarSheet(mode, dateDefault) {
  const srcs = [...L.METHODS, ...state.settings.cards.map(c => ({ id: c.id, name: c.name, color: c.color }))];
  const rules = state.settings.incomeRules || [];
  const html = `<div class="head"><h2>Lançar</h2>
      <div class="seg" role="group" aria-label="Tipo de lançamento"><button data-mode="gasto" aria-pressed="${mode === 'gasto'}">Gasto</button><button data-mode="entrada" aria-pressed="${mode === 'entrada'}">Entrada</button></div></div>
    <div class="field"><label for="lv">Valor</label><div class="money"><span>R$</span><input id="lv" inputmode="decimal" placeholder="0,00" autofocus></div></div>
    <div class="field"><label for="ld">Descrição</label><input class="input" id="ld" placeholder="${mode === 'entrada' ? 'ex.: 13º salário, freela, reembolso' : 'ex.: almoço, Renner, mestrado'}"></div>
    <div data-g>
      <div class="lbl" style="margin-top:14px">Como pagou</div>
      <div class="wrapchips">${srcs.map((s, i) => `<button class="chip" data-src="${esc(s.id)}" aria-pressed="${i === 0}"><span class="dot" style="background:${s.color}"></span>${esc(s.name)}</button>`).join('')}</div>
      <div class="lbl" style="margin-top:14px">Categoria</div>
      <div class="wrapchips">${catNames().map(c => `<button class="chip" data-cat="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('')}</div>
    </div>
    <div data-e hidden>
      <div class="lbl" style="margin-top:14px">É uma entrada fixa?</div>
      <div class="wrapchips"><button class="chip" data-rk="" aria-pressed="true">Avulsa</button>${rules.map(r => `<button class="chip" data-rk="${esc(r.key)}" aria-pressed="false">${esc(r.name)}</button>`).join('')}</div>
    </div>
    <div class="grid2">
      <div class="field"><label for="ldt">Data</label><input class="input" id="ldt" type="date" value="${dateDefault || today()}"></div>
      <div class="field" data-g><label for="lp">Parcelas</label><input class="input" id="lp" type="number" min="1" max="24" value="1"></div>
    </div>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Lançar gasto</button><button class="btn ghost" data-close>Cancelar</button></div>`;

  openSheet(html, (sh, close) => {
    let src = srcs[0].id, cat = null, rk = '';
    const setMode = m => {
      mode = m;
      sh.$$('[data-g]').forEach(x => (x.hidden = m !== 'gasto'));
      sh.$$('[data-e]').forEach(x => (x.hidden = m !== 'entrada'));
      sh.$('[data-save]').textContent = m === 'gasto' ? 'Lançar gasto' : 'Registrar entrada';
    };
    pickChips(sh, 'mode', setMode);
    pickChips(sh, 'src', v => (src = v));
    pickChips(sh, 'cat', v => (cat = v));
    pickChips(sh, 'rk', v => { rk = v; const r = rules.find(x => x.key === v); if (r && !sh.$('#ld').value) sh.$('#ld').value = r.name; });
    setMode(mode);
    sh.$('[data-save]').addEventListener('click', async () => {
      const err = sh.$('[data-err]');
      const amount = num(sh.$('#lv').value);
      const title = sh.$('#ld').value.trim();
      const date = sh.$('#ldt').value || today();
      if (!(amount > 0)) { err.textContent = 'Informe um valor maior que zero.'; return; }
      if (mode === 'gasto') {
        if (!title) { err.textContent = 'Escreva uma descrição.'; return; }
        const n = Math.min(24, Math.max(1, parseInt(sh.$('#lp').value, 10) || 1));
        const rows = L.installmentRows({ date, title, amount, n, source: src, category: cat }).map(r => ({ ...r, user_id: state.user.id }));
        const { error } = await sb.from('transactions').insert(rows);
        if (error) { err.textContent = 'Não salvou: ' + error.message; return; }
        await loadTxs();
        close(); render();
        toast(n > 1 ? `Gasto lançado em ${n} parcelas.` : 'Gasto lançado.');
      } else {
        const { data, error } = await sb.from('incomes').insert({ date, name: title || 'Entrada', amount, rule_key: rk || null }).select('id,date,name,amount,rule_key').single();
        if (error) { err.textContent = 'Não salvou: ' + error.message; return; }
        state.incomes.push({ ...data, amount: Number(data.amount) });
        close(); render(); toast('Entrada registrada.');
      }
    });
  });
}

// ----- Classificar / editar um gasto -----
function txSheet(id) {
  const t = state.txs.find(x => x.id === id);
  if (!t) return;
  const current = L.categoryOf(t, state.rules);
  const names = [...catNames(), L.IGNORE];
  let chosen = names.includes(current) ? current : null;
  const html = `<h2>${esc(t.title)}</h2>
    <div class="meta">${L.ddmm(t.date)}/${t.date.slice(0, 4)} · ${signed(t.amount)} · ${esc(sourceName(t.source))}${t.manual ? ' · lançado à mão' : ''}</div>
    <div class="lbl">Para onde vai?</div>
    <div class="wrapchips">${names.map(n => `<button class="chip" data-pick="${esc(n)}" aria-pressed="${n === chosen}">${esc(n)}</button>`).join('')}</div>
    <div class="card" style="background:var(--bg)">
      <label class="check" style="white-space:normal;color:var(--text);font-size:15px"><input type="checkbox" data-rule ${t.manual || t.category ? '' : 'checked'}> Lembrar para as próximas</label>
      <div class="field" style="margin-top:10px"><label for="kw">Sempre que a descrição tiver</label><input class="input" id="kw" value="${esc(L.suggestKeyword(t.title))}"></div>
    </div>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Salvar</button><button class="btn ghost" data-close>Cancelar</button></div>
    <div class="actions" style="margin-top:10px">
      ${t.category ? '<button class="btn small ghost" data-reset>Voltar para as regras</button>' : ''}
      ${t.manual ? '<button class="btn small danger" data-delete>Apagar este gasto</button>' : ''}
    </div>`;
  openSheet(html, (sh, close) => {
    pickChips(sh, 'pick', v => (chosen = v));
    const err = sh.$('[data-err]');
    sh.$('[data-reset]')?.addEventListener('click', async () => {
      const { error } = await sb.from('transactions').update({ category: null }).eq('id', t.id);
      if (error) { err.textContent = 'Não salvou: ' + error.message; return; }
      t.category = null; close(); render();
    });
    sh.$('[data-delete]')?.addEventListener('click', async () => {
      const { error } = await sb.from('transactions').delete().eq('id', t.id);
      if (error) { err.textContent = 'Não apagou: ' + error.message; return; }
      state.txs = state.txs.filter(x => x.id !== t.id); close(); render(); toast('Gasto apagado.');
    });
    sh.$('[data-save]').addEventListener('click', async () => {
      if (!chosen) { err.textContent = 'Escolha uma categoria.'; return; }
      const asRule = sh.$('[data-rule]').checked;
      const kw = L.normalize(sh.$('#kw').value);
      if (asRule) {
        if (!kw) { err.textContent = 'Escreva a palavra da regra.'; return; }
        if (!L.normalize(t.title).includes(kw)) { err.textContent = 'A palavra precisa aparecer na descrição da compra.'; return; }
        const { data, error } = await sb.from('rules').insert({ keyword: kw, category: chosen }).select('id,keyword,category').single();
        if (error) { err.textContent = 'Não salvou: ' + error.message; return; }
        state.rules.push(data);
        if (t.category) { await sb.from('transactions').update({ category: null }).eq('id', t.id); t.category = null; }
        toast(`Regra criada: "${kw}" → ${chosen}.`);
      } else {
        const { error } = await sb.from('transactions').update({ category: chosen }).eq('id', t.id);
        if (error) { err.textContent = 'Não salvou: ' + error.message; return; }
        t.category = chosen; toast('Categoria alterada.');
      }
      close(); render();
    });
  });
}

// ----- Sugerir tetos -----
function suggestSheet() {
  const { cycles, avg } = L.averageByCategory({ txs: state.txs, rules: state.rules, settings: state.settings, incomes: state.incomes, today: today() });
  if (!cycles.length) return toast('Ainda não há ciclo fechado com compras para calcular a média.');
  const cats = (state.draft || state.settings).categories;
  let cut = 0;
  const sug = v => Math.max(0, Math.ceil((v * (1 - cut)) / 10) * 10);
  const rows = () => cats.filter(c => !c.fixed).map(c => {
    const a = avg[c.name] || 0, n = sug(a);
    return `<div class="list-row"><span class="mn"><span>${esc(c.name)}</span><small>média ${money(a)} · hoje ${money(c.budget)}</small></span><b>${money(n)}</b></div>`;
  }).join('');
  const html = `<h2>Sugerir tetos</h2>
    <div class="meta">Média do gasto variável (sem fixos) em ${cycles.length} ${cycles.length === 1 ? 'ciclo fechado' : 'ciclos fechados'}: ${cycles.map(c => L.dayMonth(c.start)).reverse().join(', ')}.</div>
    <div class="seg" role="group" aria-label="Quanto cortar" style="display:inline-flex;margin:10px 0 4px">
      ${[[0, 'Média'], [0.1, '−10%'], [0.2, '−20%'], [0.3, '−30%']].map(([v, l]) => `<button data-cut="${v}" aria-pressed="${v === 0}">${l}</button>`).join('')}
    </div>
    <div data-rows>${rows()}</div>
    <p class="help small">Rubricas marcadas como fixas ficam como estão. Nada muda até você tocar em Salvar ajustes.</p>
    <div class="actions"><button class="btn primary grow" data-apply>Usar estes tetos</button><button class="btn ghost" data-close>Cancelar</button></div>`;
  openSheet(html, (sh, close) => {
    pickChips(sh, 'cut', v => { cut = Number(v); sh.$('[data-rows]').innerHTML = rows(); });
    sh.$('[data-apply]').addEventListener('click', () => {
      if (!state.draft) startDraft();
      for (const c of state.draft.categories) if (!c.fixed) c.budget = sug(avg[c.name] || 0);
      close(); render(); toast('Tetos preenchidos. Confira e toque em Salvar ajustes.');
    });
  });
}

// ----- Entradas do mês (editar valores) -----
function incomeEditSheet(ym) {
  const rules = state.settings.incomeRules || [];
  const items = L.monthIncomes(state.settings, state.incomes, ym).items;
  const extras = items.filter(i => i.extra);
  const html = `<h2>Entradas de ${monthName(ym).toLowerCase()}</h2>
    <div class="meta">Valor esperado de cada entrada fixa (fica salvo para os próximos meses). Para registrar o que caiu, use "confirmar" no Painel.</div>
    ${rules.map((r, i) => {
      const it = items.find(x => x.key === r.key);
      return `<div class="field"><label for="ir${i}">${esc(r.name)} <span class="muted small">· ${it ? L.ddmm(it.date) : ''}${it && it.received ? ` · caiu ${money(it.amount)}` : ''}</span>${it && it.received ? ` <button class="btn small ghost" data-del="${it.id}" style="min-height:26px;padding:2px 10px;margin-left:4px">desfazer</button>` : ''}</label>
        <div class="money"><span>R$</span><input id="ir${i}" data-i="${i}" inputmode="decimal" value="${fmtIn(r.amount)}" placeholder="0,00"></div></div>`;
    }).join('') || '<p class="help">Nenhuma entrada fixa ainda.</p>'}
    ${extras.length ? `<div class="lbl" style="margin-top:16px">Avulsas neste mês</div>${extras.map(e => `<div class="list-row"><span>${esc(e.name)} <span class="muted small">${L.ddmm(e.date)}</span></span><span style="display:flex;gap:10px;align-items:center"><b>${money(e.amount)}</b><button class="icon-btn sm" data-del="${e.id}" aria-label="Apagar ${esc(e.name)}">×</button></span></div>`).join('')}` : ''}
    <div class="actions" style="margin-top:12px"><button class="btn small soft" data-add>+ Recebimento avulso (13º, freela…)</button><button class="btn small ghost" data-more>Datas e novas entradas fixas</button></div>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Salvar</button><button class="btn ghost" data-close>Cancelar</button></div>`;
  openSheet(html, (sh, close) => {
    sh.$('[data-add]').addEventListener('click', () => { close(); lancarSheet('entrada', dateInMonth(ym)); });
    sh.$('[data-more]').addEventListener('click', () => { close(); startDraft(); state.view = 'entradas'; state.incomeMonth = ym; render(); window.scrollTo(0, 0); });
    sh.$$('[data-del]').forEach(b => b.addEventListener('click', async () => { await undoIncome(Number(b.dataset.del)); close(); incomeEditSheet(ym); }));
    sh.$('[data-save]').addEventListener('click', async () => {
      const next = structuredClone(state.settings);
      sh.$$('input[data-i]').forEach(inp => { next.incomeRules[Number(inp.dataset.i)].amount = num(inp.value); });
      if (await saveSettings(next)) { close(); render(); toast('Entradas salvas.'); }
    });
  });
}

// ----- Fixos (editar) -----
function fixedSheet() {
  let list = structuredClone(state.settings.fixed || []);
  const cats = state.settings.categories;
  const draw = sh => {
    sh.$('[data-list]').innerHTML = list.map((f, i) => fixedRowHTML(f, i, cats, 'f')).join('') || '<p class="help">Nenhum fixo ainda.</p>';
    sh.$$('[data-list] [data-bind]').forEach(el => el.addEventListener('input', () => {
      const [, i, k] = el.dataset.bind.split('.');
      list[+i][k] = el.dataset.type === 'money' ? num(el.value) : el.value;
    }));
    sh.$$('[data-list] [data-act="del"]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); list.splice(+b.dataset.i, 1); draw(sh); }));
  };
  const html = `<h2>Gastos fixos</h2>
    <div class="meta">O que sai todo mês fora do cartão. Cada um entra na rubrica escolhida.</div>
    <div data-list></div>
    <button class="row add" data-addfix>Adicionar fixo</button>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Salvar</button><button class="btn ghost" data-close>Cancelar</button></div>`;
  openSheet(html, (sh, close) => {
    draw(sh);
    sh.$('[data-addfix]').addEventListener('click', () => { list.push({ name: '', value: 0, category: 'Casa' }); draw(sh); sh.$$('[data-list] input')[list.length * 2 - 2]?.focus(); });
    sh.$('[data-save]').addEventListener('click', async () => {
      const next = structuredClone(state.settings);
      next.fixed = list.filter(f => (f.name || '').trim() || f.value).map(f => ({ ...f, name: f.name.trim() }));
      if (next.fixed.some(f => !f.name)) { sh.$('[data-err]').textContent = 'Dê um nome a cada fixo.'; return; }
      if (await saveSettings(next)) { close(); if (state.draft) startDraft(); render(); toast('Fixos salvos.'); }
    });
  });
}

// ----- Confirmar entrada fixa -----
function confirmIncomeSheet(key, ym) {
  const [y, m] = ym.split('-').map(Number);
  const it = L.incomeSchedule(state.settings.incomeRules, y, m).find(i => i.key === key);
  if (!it) return;
  const html = `<h2>Confirmar ${esc(it.name.toLowerCase())}</h2>
    <div class="meta">Previsto para ${longDay(it.date).toLowerCase()}</div>
    <div class="field"><label for="cv">Valor que caiu</label><div class="money"><span>R$</span><input id="cv" inputmode="decimal" value="${it.amount ? it.amount.toFixed(2).replace('.', ',') : ''}" autofocus></div></div>
    <div class="field"><label for="cd">Data</label><input class="input" id="cd" type="date" value="${it.date}"></div>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Confirmar</button><button class="btn ghost" data-close>Cancelar</button></div>`;
  openSheet(html, (sh, close) => {
    sh.$('[data-save]').addEventListener('click', async () => {
      const amount = num(sh.$('#cv').value);
      if (!(amount > 0)) { sh.$('[data-err]').textContent = 'Informe o valor recebido.'; return; }
      const { data, error } = await sb.from('incomes').insert({ date: sh.$('#cd').value || it.date, name: it.name, amount, rule_key: it.key }).select('id,date,name,amount,rule_key').single();
      if (error) { sh.$('[data-err]').textContent = 'Não salvou: ' + error.message; return; }
      state.incomes.push({ ...data, amount: Number(data.amount) });
      close(); render(); toast(`${it.name} confirmada.`);
    });
  });
}

// ----- Reservas -----
const KIND_LABEL = { reserva: 'Reserva de emergência', caixinha: 'Caixinha', investimento: 'Investimento' };

function accountSheet(acc, kind) {
  kind = acc ? acc.kind : kind;
  const html = `<h2>${acc ? esc(acc.name) : `Nova ${kind === 'investimento' ? 'aplicação' : kind === 'reserva' ? 'reserva' : 'caixinha'}`}</h2>
    <div class="meta">${KIND_LABEL[kind]}</div>
    <div class="field"><label for="an">Nome</label><input class="input" id="an" value="${esc(acc ? acc.name : kind === 'reserva' ? 'Reserva de emergência' : '')}" placeholder="${kind === 'investimento' ? 'ex.: Tesouro Selic' : 'ex.: Viagem'}"></div>
    <div class="grid2">
      <div class="field"><label for="ab">Saldo atual</label><input class="input" id="ab" inputmode="decimal" value="${acc ? acc.balance.toFixed(2).replace('.', ',') : ''}" placeholder="0,00"></div>
      <div class="field"><label for="ag2">Meta ${kind === 'reserva' ? '(vazio = automática)' : '(opcional)'}</label><input class="input" id="ag2" inputmode="decimal" value="${acc && acc.goal ? acc.goal.toFixed(2).replace('.', ',') : ''}" placeholder="—"></div>
    </div>
    <div class="field"><label for="ao">Onde está</label><input class="input" id="ao" value="${esc(acc && acc.note ? acc.note : '')}" placeholder="ex.: Caixinha Nubank, liquidez diária"></div>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Salvar</button><button class="btn ghost" data-close>Cancelar</button></div>
    ${acc ? '<div class="actions" style="margin-top:10px"><button class="btn small danger" data-delete>Apagar</button></div>' : ''}`;
  openSheet(html, (sh, close) => {
    const err = sh.$('[data-err]');
    sh.$('[data-delete]')?.addEventListener('click', async () => {
      const { error } = await sb.from('accounts').delete().eq('id', acc.id);
      if (error) { err.textContent = 'Não apagou: ' + error.message; return; }
      await loadSmall(); close(); render(); toast('Apagado.');
    });
    sh.$('[data-save]').addEventListener('click', async () => {
      const name = sh.$('#an').value.trim();
      if (!name) { err.textContent = 'Dê um nome.'; return; }
      const goalRaw = sh.$('#ag2').value.trim();
      const row = { name, kind, balance: num(sh.$('#ab').value), goal: goalRaw ? num(goalRaw) : null, note: sh.$('#ao').value.trim() || null, updated_at: new Date().toISOString() };
      const { error } = acc ? await sb.from('accounts').update(row).eq('id', acc.id) : await sb.from('accounts').insert(row);
      if (error) { err.textContent = 'Não salvou: ' + error.message; return; }
      await loadSmall(); close(); render(); toast('Salvo.');
    });
  });
}

function aporteSheet() {
  const accs = state.accounts;
  let chosen = accs[0] && accs[0].id;
  const html = `<h2>Registrar aporte</h2>
    <div class="field"><label for="pv">Valor guardado</label><div class="money"><span>R$</span><input id="pv" inputmode="decimal" placeholder="0,00" autofocus></div></div>
    <div class="lbl" style="margin-top:14px">Para onde foi</div>
    <div class="wrapchips">${accs.map((a, i) => `<button class="chip" data-acc="${a.id}" aria-pressed="${i === 0}">${esc(a.name)}</button>`).join('')}</div>
    <div class="field"><label for="pd">Data</label><input class="input" id="pd" type="date" value="${today()}"></div>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Registrar aporte</button><button class="btn ghost" data-close>Cancelar</button></div>`;
  openSheet(html, (sh, close) => {
    pickChips(sh, 'acc', v => (chosen = Number(v)));
    sh.$('[data-save]').addEventListener('click', async () => {
      const amount = num(sh.$('#pv').value);
      if (!(amount > 0)) { sh.$('[data-err]').textContent = 'Informe um valor maior que zero.'; return; }
      const acc = accs.find(a => a.id === chosen);
      const r1 = await sb.from('contributions').insert({ account_id: chosen, date: sh.$('#pd').value || today(), amount });
      if (r1.error) { sh.$('[data-err]').textContent = 'Não salvou: ' + r1.error.message; return; }
      await sb.from('accounts').update({ balance: Math.round((acc.balance + amount) * 100) / 100, updated_at: new Date().toISOString() }).eq('id', chosen);
      await loadSmall(); close(); render(); toast(`Aporte de ${money(amount)} registrado.`);
    });
  });
}

function saldosSheet() {
  const html = `<h2>Atualizar saldos</h2>
    <div class="meta">Copie o saldo de hoje de cada lugar.</div>
    ${state.accounts.map(a => `<div class="field"><label for="s${a.id}">${esc(a.name)}</label><input class="input" id="s${a.id}" data-id="${a.id}" inputmode="decimal" value="${a.balance.toFixed(2).replace('.', ',')}"></div>`).join('')}
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Salvar saldos</button><button class="btn ghost" data-close>Cancelar</button></div>`;
  openSheet(html, (sh, close) => {
    sh.$('[data-save]').addEventListener('click', async () => {
      const now = new Date().toISOString();
      for (const inp of sh.$$('input[data-id]')) {
        const a = state.accounts.find(x => x.id === Number(inp.dataset.id));
        const v = num(inp.value);
        const { error } = await sb.from('accounts').update({ balance: v, updated_at: now }).eq('id', a.id);
        if (error) { sh.$('[data-err]').textContent = 'Não salvou: ' + error.message; return; }
      }
      await loadSmall(); close(); render(); toast('Saldos atualizados.');
    });
  });
}

// ---------------- login ----------------
function renderLogin() {
  $app.innerHTML = `<div class="center"><form class="login" id="login">
    <span class="brand">MyFinance</span>
    <p>Entre para ver suas faturas.</p>
    <div class="field"><label for="email">E-mail</label><input class="input" id="email" type="email" autocomplete="email" required></div>
    <div class="field"><label for="pass">Senha</label><input class="input" id="pass" type="password" autocomplete="current-password" minlength="6" required></div>
    <div class="err" id="lerr"></div>
    <div class="actions"><button class="btn primary" type="submit">Entrar</button><button class="btn ghost" type="button" id="signup">Criar conta</button></div>
  </form></div>`;
  const $err = document.getElementById('lerr');
  const creds = () => ({ email: document.getElementById('email').value.trim(), password: document.getElementById('pass').value });
  document.getElementById('login').onsubmit = async e => {
    e.preventDefault(); $err.textContent = '';
    const { data, error } = await sb.auth.signInWithPassword(creds());
    if (error) { $err.textContent = error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : error.message; return; }
    await enter(data.user);
  };
  document.getElementById('signup').onclick = async () => {
    $err.textContent = '';
    const c = creds();
    if (!c.email || c.password.length < 6) { $err.textContent = 'Preencha o e-mail e uma senha com pelo menos 6 caracteres.'; return; }
    const { data, error } = await sb.auth.signUp(c);
    if (error) { $err.textContent = error.message; return; }
    if (data.session) await enter(data.user);
    else $err.textContent = 'Conta criada. Confirme pelo link no seu e-mail e depois entre aqui.';
  };
}
