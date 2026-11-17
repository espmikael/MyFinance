import * as L from './logic.js?v=20261117n';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=20261117n';

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

// ---------------- utilidades ----------------
const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = v => (state.priv ? 'R$ •••' : brl.format(Number(v) || 0));
const signed = v => (state.priv ? 'R$ •••' : v < 0 ? '−' + money(-v) : money(v));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const longDay = iso => new Date(iso + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, c => c.toUpperCase());
const num = v => { const n = L.parseAmount(v); return Number.isFinite(n) ? n : 0; };
const pct = v => `${Math.round(v * 100)}%`;
const today = () => L.todayISO();
const safeColor = c => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? c : '#5D6470');
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
  contasMonth: null,     // 'YYYY-MM' na tela Contas
  contasKind: 'exact',   // aba da tela Contas
  homeTab: 'a',          // Contas do mês no Início: a pagar / pagas
  pc: { amt: 50, cat: null }, // posso comprar?
  priv: (() => { try { return localStorage.getItem('mf-priv') === '1'; } catch (e) { return false; } })(),
  busy: false,
  lastBatch: null,       // último envio de fatura, para desfazer
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
      <p>Não consegui carregar o app. Recarregue a página.</p></div></div>`;
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
  // link do e-mail de recuperação: o Supabase devolve type=recovery (ou um erro, se o link venceu)
  const urlInfo = new URLSearchParams((location.hash || '').replace(/^#/, '') + '&' + location.search.replace(/^\?/, ''));
  const isRecovery = urlInfo.get('type') === 'recovery';
  const linkError = urlInfo.get('error_description');
  const { data } = await sb.auth.getSession();
  if (linkError) { history.replaceState(null, '', location.pathname); renderLogin(linkError.includes('expired') ? 'O link venceu ou já foi usado. Peça um novo em "Esqueci a senha".' : linkError); }
  else if (isRecovery && data.session) renderNewPassword();
  else if (data.session) await enter(data.session.user);
  else renderLogin();
  sb.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') { state.user = null; renderLogin(); }
    if (event === 'PASSWORD_RECOVERY') renderNewPassword();
  });
}

async function enter(user) {
  state.user = user;
  $app.innerHTML = `<div class="center"><p class="help">Carregando…</p></div>`;
  try { await loadAll(); }
  catch (e) {
    $app.innerHTML = `<div class="center"><div class="login"><span class="brand">MyFinance</span>
      <p class="err">Não consegui ler o banco: ${esc(e.message || e)}</p>
      <button class="btn" data-act="retry">Tentar de novo</button></div></div>`;
    return;
  }
  state.cycle = curCycle();
  try { history.replaceState({ v: state.view, f: state.filter }, '', location.pathname); } catch (e) {}
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

// ---------------- navegação (voltar do navegador, do iPhone e do app) ----------------
let navDepth = 0;
const sheets = [];   // janelas abertas (a de cima é a última)
function go(v, { filter = 'all', cycle = null } = {}) {
  v = ALIAS[v] || v;
  if (['ajustes', 'entradas'].includes(v) && !['ajustes', 'entradas'].includes(state.view)) startDraft();
  if (!['ajustes', 'entradas'].includes(v)) state.draft = null;
  if (cycle) state.cycle = cycle;
  state.view = v; state.filter = filter; state.q = '';
  navDepth++;
  try { history.pushState({ v, f: filter }, ''); } catch (e) {}
  render(); window.scrollTo(0, 0);
}
function goBack() {
  if (sheets.length) return sheets[sheets.length - 1]();
  if (navDepth > 0) history.back(); else go('home');
}
window.addEventListener('popstate', e => {
  if (!state.user) return;
  if (sheets.length) {            // voltar com uma janela aberta: fecha a janela e fica na tela
    sheets[sheets.length - 1]();
    try { history.pushState({ v: state.view, f: state.filter }, ''); } catch (err) {}
    return;
  }
  navDepth = Math.max(0, navDepth - 1);
  const st = e.state || { v: 'home', f: 'all' };
  if (['ajustes', 'entradas'].includes(st.v) && !['ajustes', 'entradas'].includes(state.view)) startDraft();
  if (!['ajustes', 'entradas'].includes(st.v)) state.draft = null;
  state.view = ALIAS[st.v] || st.v || 'home'; state.filter = st.f || 'all'; state.q = '';
  render(); window.scrollTo(0, 0);
});

// ---------------- render ----------------
const ICON = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  doc: '<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h7M9 17h5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  safe: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M3 11h18M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M17.9 17.9A10.4 10.4 0 0 1 12 20C5 20 1 12 1 12a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9.6 9.6 0 0 1 12 4c7 0 11 8 11 8a18.6 18.6 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M1 1l22 22"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  warn: '<path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  undo: '<path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/>',
  nfc: '<path d="M8.5 7.5a6 6 0 0 1 0 9M12 5a9.5 9.5 0 0 1 0 14M5 10a2.5 2.5 0 0 1 0 4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  bars: '<path d="M5 19V9M12 19V5M19 19v-7"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
};
const icon = (name, size = 18, sw = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const VIEWS = [['home', 'Início', 'home'], ['gastos', 'Gastos', 'list'], ['mes', 'Mês', 'cal'], ['analise', 'Análise', 'chart'], ['reservas', 'Reservas', 'safe']];
// nomes antigos das telas continuam funcionando
const ALIAS = { contas: 'mes', painel: 'analise' };

function render() {
  if (!state.user) return renderLogin();
  const s = summary(state.view === 'home' ? curCycle() : state.cycle);
  const body = {
    home: () => viewHome(s), gastos: () => viewGastos(s), analise: () => viewAnalise(s), mes: viewMes,
    reservas: viewReservas, ajustes: viewAjustes, entradas: viewEntradas,
  }[state.view]();
  const cur = state.view === 'entradas' ? 'mes' : state.view;
  const nav = ([id, l, ic]) => `<button class="navlink" data-act="view" data-v="${id}" ${cur === id ? 'aria-current="page"' : ''}>${icon(ic)}${l}</button>`;
  const unc = id => id === 'gastos' && s.toClassify && s.toClassify.length && state.view !== 'gastos' ? `<span class="badge" aria-label="${s.toClassify.length} sem rubrica">${s.toClassify.length}</span>` : '';
  const tab = ([id, l, ic]) => `<button data-act="view" data-v="${id}" ${cur === id ? 'aria-current="page"' : ''}><span class="tabic">${icon(ic, 22)}${unc(id)}</span>${l}</button>`;
  $app.innerHTML = `<div class="shell">
    <aside class="side" aria-label="Menu">
      <span class="brand"><span class="logo">${icon('bars', 18, 2.2)}</span>MyFinance</span>
      <nav aria-label="Principal">${VIEWS.map(nav).join('')}</nav>
      <div class="grow"></div>
      ${nav(['ajustes', 'Ajustes', 'gear'])}
      <div class="sync"><i></i>Sincronizado</div>
    </aside>
    <main class="main"><div class="wrap">${body}</div></main>
    <nav class="tabs" aria-label="Principal">
      ${tab(VIEWS[0])}${tab(VIEWS[1])}
      <button class="plus" data-act="lancar" aria-label="Lançar gasto ou entrada">${icon('plus', 22, 2.4)}</button>
      ${tab(VIEWS[2])}${tab(VIEWS[3])}
    </nav>
  </div>`;
  wireCharts();
}

// média por rubrica dos últimos ciclos fechados (guardada até mudar gastos, regras ou ajustes)
let avgMemo = { k: null, v: null };
function averages() {
  const k = [state.txs, state.rules, state.settings, state.incomes, today()];
  if (avgMemo.k && avgMemo.k.every((x, i) => x === k[i])) return avgMemo.v;
  const v = L.averageByCategory({ txs: state.txs, rules: state.rules, settings: state.settings, incomes: state.incomes, today: today() });
  avgMemo = { k, v };
  return v;
}
function summary(cycle) {
  const a = averages();
  return L.summarize({ txs: state.txs, rules: state.rules, settings: state.settings, cycle, today: today(), incomes: state.incomes, avg: a.cycles.length ? a.avg : null });
}

// botões do topo de cada tela
function headActions({ upload = true } = {}) {
  return `<div class="head-actions">
    <button class="icon-btn ${state.priv ? 'on' : ''}" data-act="priv" aria-pressed="${state.priv}" aria-label="${state.priv ? 'Mostrar valores' : 'Ocultar valores'}" title="${state.priv ? 'Mostrar valores' : 'Ocultar valores'}">${icon(state.priv ? 'eyeOff' : 'eye', 19)}</button>
    ${upload ? `<button class="btn only-desk-inline" data-act="upload" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Enviando…' : 'Enviar fatura'}</button>
    <button class="icon-btn only-mob" data-act="upload" aria-label="Enviar fatura">${icon('up')}</button>` : ''}
    <button class="btn primary only-desk-inline" data-act="lancar">${icon('plus', 16, 2.4)}Lançar</button>
    <button class="icon-btn only-mob" data-act="menu" aria-label="Mais opções">${icon('more', 20)}</button>
  </div>`;
}
const pageHead = (title, sub, actions = headActions(), cls = '') => `<header class="pagehead ${cls}"><div class="t">${state.view !== 'home' ? `<button class="backbtn" data-act="back" aria-label="Voltar">‹ Voltar</button>` : ''}<h1 class="page-title">${title}</h1>${sub ? `<span class="sub">${sub}</span>` : ''}</div>${actions}</header>`;

function cycleRow(s) {
  const c = card(), cur = curCycle(), t = today();
  const due = L.dueDateFor(s.cycle, c);
  return `<div class="cycle">
    <button class="icon-btn sm" data-act="prev" aria-label="Fatura anterior">‹</button>
    <div class="lbl"><b>${L.invoiceName(s.cycle, c, t)}</b><span>${L.dayMonth(s.cycle.start)}–${L.dayMonth(s.cycle.end)} · vence ${L.ddmm(due)}</span></div>
    <button class="icon-btn sm" data-act="next" aria-label="Próxima fatura" ${s.cycle.start >= cur.start ? 'disabled' : ''}>›</button>
  </div>`;
}

const segs = (n, filled, cls = 'on', style = '') => Array.from({ length: n }, (_, i) => `<i class="${i < filled ? cls : ''}" ${i < filled && style ? `style="${style}"` : ''}></i>`).join('');
const mName = ym => L.MONTHS[+ym.slice(5, 7) - 1];

// ----- Início -----
const localDay = iso => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// até quando o cartão está conferido: o dia do último envio de fatura
function lastUploadDay() {
  let m = '';
  for (const t of state.txs) if (!t.manual && t.created_at) { const d = localDay(t.created_at); if (d > m) m = d; }
  return m || null;
}
function viewHome(s) {
  const t = today();
  const sub = `${L.weekdayShort(t).replace(/^./, c => c.toUpperCase())}, ${L.dayMonth(t)} · ${L.invoiceName(s.cycle, card(), t).toLowerCase()}`;
  if (!state.txs.length) {
    return `${pageHead('Início', sub)}<div class="card empty">
      <h2>Envie a primeira fatura</h2>
      <p>No app do banco, exporte a fatura do cartão em CSV ou Excel. Depois toque em <b>Enviar fatura</b> e escolha o arquivo.</p>
      <p>Para ver quanto sobra no mês, informe suas entradas e cadastre suas contas.</p>
      <div class="actions"><button class="btn primary" data-act="upload">Enviar fatura</button><button class="btn" data-act="view" data-v="mes">Entradas e contas</button></div>
    </div>`;
  }
  const prevOver = weekReview(s);
  return `${pageHead('Início', sub)}
    ${lastBatchNotice()}
    ${uploadNudge()}
    ${s.toClassify.length ? `<button class="slim" data-act="classify"><span class="dot" style="background:var(--warn-fill)"></span>${s.toClassify.length === 1 ? '1 compra sem rubrica' : `${s.toClassify.length} compras sem rubrica`}<span class="go">classificar ›</span></button>` : ''}
    ${(() => { const c = state.settings.cards.find(c => !c.primary && !c.closing && state.txs.some(t => (t.source || 'nubank') === c.id)); return c ? `<div class="notice"><span>Informe o dia em que a fatura do ${esc(c.name)} fecha. Sem ele, as compras do ${esc(c.name)} entram pela data da compra e podem cair no mês errado.</span><button class="btn small" data-act="view" data-v="ajustes">Ajustes</button></div>` : ''; })()}
    ${s.income <= 0 ? `<div class="notice info"><span>Informe suas entradas para o app calcular o limite do mês.</span><button class="btn small" data-act="view" data-v="mes">Entradas</button></div>` : ''}
    ${invoiceStrip()}
    ${state.homeCard && state.homeCard !== 'all' && state.settings.cards.some(c => c.id === state.homeCard) ? cardFocus(s, state.homeCard) : `
    ${homeNumbers(s)}
    ${prevOver}
    <div class="cols">
      <div class="col-main">${agendaCard(s)}</div>
      <div class="col-side">${flagsCard(s)}</div>
    </div>`}`;
}

// Faixa das faturas: o total de cada cartão e quando fecha. Também é o filtro do Início.
const closeTxt = n => n <= 0 ? 'fecha hoje' : n === 1 ? 'fecha amanhã' : `fecha em ${n} dias`;
function invoiceStrip() {
  const invs = L.cardInvoices(state.settings, state.txs, state.rules, today());
  const cur = state.homeCard && invs.some(i => i.card.id === state.homeCard) ? state.homeCard : 'all';
  const total = invs.reduce((a, i) => a + i.total, 0);
  const soon = invs.filter(i => i.configured).sort((a, b) => a.daysToClose - b.daysToClose)[0];
  const one = i => `<button class="invtab" data-act="home-card" data-v="${esc(i.card.id)}" aria-pressed="${cur === i.card.id}" style="--cc:${safeColor(i.card.color)}">
      <span class="n"><span class="dot" style="background:${safeColor(i.card.color)}"></span>${esc(i.card.name)}</span>
      <b>${money(i.total)}</b>
      <small class="${i.configured && i.daysToClose <= 3 ? 'w' : ''}">${!i.configured ? 'sem fechamento' : i.daysToClose <= 2 ? closeTxt(i.daysToClose - 1) : `fecha ${L.ddmm(L.addDays(i.cycle.end, 1))}`}</small>
    </button>`;
  return `<nav class="invstrip" aria-label="Faturas abertas">
    <button class="invtab" data-act="home-card" data-v="all" aria-pressed="${cur === 'all'}">
      <span class="n">Todas</span><b>${money(total)}</b><small>${invs.length} faturas abertas</small>
    </button>
    ${invs.map(one).join('')}
  </nav>`;
}

// Um cartão em foco: a fatura aberta dele, a semana nele, onde foi o dinheiro e as últimas compras
function cardFocus(s, id) {
  const i = L.cardInvoices(state.settings, state.txs, state.rules, today()).find(x => x.card.id === id);
  const c = i.card, color = safeColor(c.color);
  const txs = state.txs.filter(t => (t.source || 'nubank') === id && t.date >= i.cycle.start && t.date <= i.cycle.end)
    .map(t => ({ ...t, cat: L.categoryOf(t, state.rules) })).filter(t => t.cat !== L.IGNORE);
  const w = s.week;
  const wk = w ? txs.filter(t => t.date >= w.start && t.date <= w.end).reduce((a, t) => a + t.amount, 0) : 0;
  const parc = txs.filter(t => /parcela\s*\d+\s*\/\s*\d+/i.test(t.title)).reduce((a, t) => a + t.amount, 0);
  const byCat = {};
  for (const t of txs) byCat[t.cat] = (byCat[t.cat] || 0) + t.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const maxC = Math.max(1, ...cats.map(x => x[1]));
  const last = [...txs].sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount).slice(0, 6);
  const status = !i.configured ? 'Informe o fechamento e o vencimento em Ajustes' : `${closeTxt(i.daysToClose - 1)} (${L.weekdayShort(L.addDays(i.cycle.end, 1))} ${L.ddmm(L.addDays(i.cycle.end, 1))}) · vence ${L.weekdayShort(i.due)} ${L.ddmm(i.due)}`;
  return `<section class="card focus" aria-labelledby="cf-h">
      <div class="focus-top">
        <span class="cface mini" style="background:${color}" aria-hidden="true"><span class="b">${esc(c.name)}</span><span class="chipc"></span></span>
        <div><span id="cf-h" class="k">Fatura aberta do ${esc(c.name)}</span><span class="big md">${money(i.total)}</span><span class="small muted">${status}</span></div>
      </div>
      <div class="segbar mid" aria-hidden="true" style="margin-top:14px">${segs(i.len, i.elapsed, 'on', `background:${color}`)}</div>
      <div class="small muted" style="margin-top:6px">dia ${i.elapsed} de ${i.len} · ${L.dayMonth(i.cycle.start)} a ${L.dayMonth(i.cycle.end)}</div>
      <div class="splitlim three">
        <div><small>Nesta semana</small><b>${money(wk)}</b></div>
        <div><small>Parcelas nesta fatura</small><b>${money(parc)}</b></div>
        <div><small>${i.prev.unpaid && i.prev.total > 0 ? `Fatura anterior · vence ${L.ddmm(i.prev.due)}` : 'Fatura anterior'}</small><b>${i.prev.total > 0 ? money(i.prev.total) : '—'}</b></div>
      </div>
    </section>
    <div class="cols">
      <div class="col-main">
        <section class="card" aria-labelledby="cl-h">
          <div class="card-head"><h2 id="cl-h">Últimas compras no ${esc(c.name)}</h2><button class="btn small ghost" data-act="card-open" data-id="${esc(id)}">ver todas ›</button></div>
          ${last.length ? last.map(t => `<button class="lrow" data-act="tx" data-id="${t.id}"><span class="m"><b>${esc(L.prettyTitle(t.title))}</b><small>${L.weekdayShort(t.date)} ${L.ddmm(t.date)} · ${esc(t.cat || 'sem rubrica')}</small></span><span class="r"><b>${money(t.amount)}</b></span></button>`).join('') : '<p class="help">Nenhuma compra nesta fatura ainda.</p>'}
        </section>
      </div>
      <div class="col-side">
        <section class="card" aria-labelledby="cc-h">
          <div class="card-head"><h2 id="cc-h">Onde foi nesta fatura</h2></div>
          ${cats.length ? cats.map(([n, v]) => `<div class="hbar"><div class="lab"><span>${esc(n)}</span><b>${money(v)}</b></div><div class="trk"><div class="val" style="width:${(v / maxC * 100).toFixed(1)}%;background:${color}"></div></div></div>`).join('') : '<p class="help">Nada ainda.</p>'}
        </section>
      </div>
    </div>`;
}

// Fechamento da semana passada: aparece quando a fatura dela já foi enviada, até você dispensar
function weekReview(s) {
  const w = s.week;
  if (!w || w.limit == null) return '';
  let prev = s.weeks[s.weeks.indexOf(w) - 1], ps = s;
  if (!prev) { ps = summary(L.shiftCycle(s.cycle.start, -1, card().closing || 1)); prev = ps.weeks[ps.weeks.length - 1]; }
  if (!prev || prev.limit == null) return '';
  let gone = false; try { gone = localStorage.getItem('mf-wk-' + prev.start) === '1'; } catch (e) {}
  const up = lastUploadDay();
  if (gone || !up || up < prev.end) return '';
  const diff = prev.spent - prev.limit;
  const inWeek = ps.txs.filter(t => t.day >= prev.start && t.day <= prev.end && !t.isFixed && !t.commit && t.cat !== L.IGNORE && t.amount > 0);
  const top = [...inWeek].sort((a, b) => b.amount - a.amount).slice(0, 3);
  const byCat = {};
  for (const t of inWeek) byCat[t.cat] = (byCat[t.cat] || 0) + t.amount;
  const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  return `<section class="card review" aria-labelledby="wr-h">
    <div class="card-head"><h2 id="wr-h">Fechamento da semana ${L.ddmm(prev.start)}–${L.ddmm(prev.end)}</h2><button class="icon-btn sm" data-act="week-dismiss" data-w="${prev.start}" aria-label="Dispensar fechamento">${icon('x', 16)}</button></div>
    <div class="rv-top"><span><small>Gastou</small><b>${money(prev.spent)}</b></span><span><small>Liberado</small><b>${money(prev.limit)}</b></span><span><small>${diff > 0 ? 'Passou' : 'Sobrou'}</small><b class="${diff > 0 ? 'neg' : 'pos'}">${money(Math.abs(diff))}</b></span></div>
    <p class="small" style="margin:10px 0 6px;color:var(--text-2)">${diff > 0 ? `Os ${money(diff)} a mais saíram das semanas que faltam.` : diff < -0.5 ? `Os ${money(-diff)} que sobraram foram para as semanas que faltam.` : 'Fechou exatamente no liberado.'} ${w.containment ? `Modo contenção: esta semana libera <b>${money(w.limit)}</b>, só para o essencial.` : `Esta semana libera <b>${money(w.limit)}</b>.`}${topCat ? ` Onde mais foi: <b>${esc(topCat[0])}</b> (${money(topCat[1])}).` : ''}</p>
    ${top.length ? `<div class="rv-list">${top.map(t => `<div><span>${esc(L.prettyTitle(t.title))}<small>${L.weekdayShort(t.date)} ${L.ddmm(t.date)} · ${esc(t.cat)}</small></span><b>${money(t.amount)}</b></div>`).join('')}</div>` : ''}
  </section>`;
}

function weekHero(s) {
  const w = s.week;
  if (!w || w.limit == null) {
    return `<div class="kcard hero zero"><span class="kl">Pode gastar nesta semana</span><span class="kv">—</span>
      <span class="ks">Informe suas entradas ou defina um limite em Ajustes para o app liberar um valor por semana.</span></div>`;
  }
  const over = w.left < 0;
  const up = lastUploadDay();
  // uma pergunta só: quanto ainda posso gastar nesta semana
  const cz = w.containment ? s.containment : null;
  const pct = w.limit > 0 ? Math.min(100, Math.round(w.spent / w.limit * 100)) : 100;
  const range = `${L.weekdayShort(w.start)} ${L.ddmm(w.start)} a ${L.weekdayShort(w.end)} ${L.ddmm(w.end)}`;
  return `<div class="kcard hero week ${over ? 'zero' : cz ? 'contain' : ''}">
      <span class="r1"><span class="kl">Pode gastar nesta semana</span><span class="kl" style="opacity:.9">${range}</span></span>
      <span class="kv">${money(Math.max(0, w.left))}</span>
      <div class="wprog" aria-hidden="true"><i style="width:${pct}%"></i></div>
      <span class="ks">gastou ${money(w.spent)} de ${money(w.limit)}${over ? ` · <b>passou ${money(-w.left)}</b>, que sai da próxima semana` : !over && w.daysLeft > 1 ? ` · ${money(w.perDay)} por dia até ${L.weekdayShort(w.end) === 'dom' ? 'domingo' : L.ddmm(w.end)}` : ''}</span>
      ${cz ? `<span class="ctag">Modo contenção: o limite do mês acabou (passou ${money(s.freeSpent - s.freeBudget)}). A meta da semana cobre só ${esc(cz.cats.join(' e ') || 'o essencial')}.</span>` : ''}
      <div class="wfoot">
        <span><span>Faturas enviadas até</span><b>${up ? `${L.weekdayShort(up)} ${L.ddmm(up)}` : '—'}</b></span>
      </div>
    </div>`;
}

function homeNumbers(s) {
  const inc = s.incomeItems;
  const sobra = s.isPast ? s.result : s.balance;
  const next = inc.find(i => !i.received);
  const k = (label, value, bar, foot, cls = '', act = '') => `<${act ? 'button' : 'div'} class="kcard" ${act}><span class="kl">${label}</span><span class="kv ${cls}">${value}</span>${bar}<span class="ks">${foot}</span></${act ? 'button' : 'div'}>`;
  const sCls = s.income > 0 ? (sobra < 0 ? 'neg' : 'pos') : '';
  const invs = L.cardInvoices(state.settings, state.txs, state.rules, today());
  const dues = [];
  for (const i of invs) {
    if (i.prev.unpaid && i.prev.total > 0) dues.push({ name: i.card.name, total: i.prev.total, due: i.prev.due, closed: true });
    if (i.total > 0) dues.push({ name: i.card.name, total: i.total, due: i.due, closed: false });
  }
  dues.sort((a, b) => a.due.localeCompare(b.due));
  const nd = dues[0];
  const cards = [
    k('Saldo previsto do mês', s.income > 0 ? (sobra >= 0 && !state.priv ? '+' : '') + signed(sobra) : '—', '', 'se não gastar mais nada ›', sCls, 'data-act="view" data-v="mes" aria-label="Ver o mês"'),
    k('Próxima entrada', next ? money(next.amount) : '—', '', next ? `${esc(next.name.toLowerCase())} · ${L.weekdayShort(next.date)} ${L.ddmm(next.date)}` : 'todas recebidas', next ? 'pos' : ''),
    k('Próxima fatura', nd ? money(nd.total) : '—', '', nd ? `${esc(nd.name)} · vence ${L.weekdayShort(nd.due)} ${L.ddmm(nd.due)}${nd.closed ? '' : ' (aberta)'}` : 'nenhuma a pagar'),
  ].join('');
  return `<div class="only-desk"><section class="kgrid" aria-label="Resumo">${weekHero(s)}${cards}</section></div>
    <div class="only-mob" style="display:flex;flex-direction:column;gap:14px">${weekHero(s)}<section class="mini3" aria-label="Resumo do mês">${cards}</section></div>`;
}

// Posso comprar? — contra a semana e o mês
function possoCard(s) {
  const w = s.week;
  if (!s.isCurrent || !(s.varBudget > 0) || !w) return '';
  const amt = Number(state.pc.amt) || 0;
  const wl = Math.max(0, w.left), ml = s.varLeft;
  const nxt = s.weeks[s.weeks.indexOf(w) + 1];
  const restDays = L.daysBetween(w.end, s.cycle.end);
  let v;
  if (!amt) v = { cls: 'ok', ic: icon('check', 18, 2.6), t: `Cabem ${money(wl)} nesta semana`, x: `E ${money(ml)} até o fim do ciclo (${L.dayMonth(s.cycle.end)}). Escolha um valor para testar.` };
  else if (amt <= wl) v = { cls: 'ok', ic: icon('check', 18, 2.6), t: 'Cabe na semana', x: `Sobram ${money(wl - amt)} até ${L.weekdayShort(w.end) === 'dom' ? 'domingo' : L.ddmm(w.end)}${w.daysLeft > 1 ? ` (≈ ${money((wl - amt) / w.daysLeft)} por dia)` : ''}.` };
  else if (amt <= ml) {
    const after = nxt && restDays > 0 ? Math.max(0, ml - amt) * nxt.days / restDays : 0;
    v = { cls: 'warn', ic: '!', t: 'Passa da semana, cabe no mês', x: `Passa ${money(amt - wl)} desta semana.${nxt ? ` A próxima (${L.ddmm(nxt.start)}–${L.ddmm(nxt.end)}) libera cerca de ${money(after)} em vez de ${money(nxt.limit)}.` : ''}` };
  } else {
    v = { cls: 'no', ic: '!', t: 'Não cabe no mês', x: `Passa ${money(amt - ml)} do que resta do limite.${s.income > 0 ? ` O saldo previsto de ${mName(s.month)} vai de ${signed(s.balance)} para ${signed(s.balance - amt)}.` : ''}` };
  }
  return `<section class="card" id="pc" aria-labelledby="pc-h">
    <div class="card-head"><h2 id="pc-h">Posso comprar?</h2><span class="sub">conta a semana e o mês</span></div>
    <div class="amt-row">${[20, 50, 100, 250].map(x => `<button class="chip" data-act="pc-amt" data-v="${x}" aria-pressed="${amt === x}">R$ ${x}</button>`).join('')}
      <label class="money"><span>R$</span><input id="pc-in" inputmode="decimal" placeholder="outro" aria-label="Outro valor" value="${[20, 50, 100, 250].includes(amt) || !amt ? '' : fmtIn(amt)}"></label></div>
    <div class="verdict ${v.cls}" aria-live="polite"><span class="ic">${v.ic}</span><div><b>${v.t}</b><span>${v.x}</span></div></div>
  </section>`;
}
function refreshPC() {
  const el = document.getElementById('pc');
  if (el) { el.outerHTML = possoCard(summary(curCycle())); }
}

// Agenda do dinheiro
function agendaCard(s) {
  const st = state.settings;
  const prim = card();
  // fatura do principal pelo que já se sabe (o mesmo critério do saldo previsto), sem projeção pelo ritmo
  const invP = L.cardInvoices(st, state.txs, state.rules, today()).find(i => i.card.id === prim.id);
  const ag = L.moneyAgenda({ settings: st, txs: state.txs, rules: state.rules, incomes: state.incomes, today: today(), primaryProjection: invP ? Math.round((invP.total + (s.commits ? s.commits.pendingTotal : 0)) * 100) / 100 : null });
  const hasBal = ag.start != null;
  const stale = hasBal && ag.balanceDate && L.daysBetween(ag.balanceDate, today()) > 3;
  let alert = '';
  if (hasBal && ag.min && ag.min.balance < 0) {
    const t = ag.tip;
    const canCover = t && t.from && t.fromAmount >= t.need;
    alert = `<div class="alert bad">${icon('warn', 20)}<span><b>Em ${L.ddmm(ag.min.date)} a conta fica ${money(-ag.min.balance)} no negativo.</b> ${canCover
      ? `Separe ${money(t.need)} da ${esc(t.from.toLowerCase())} de ${L.ddmm(t.fromDate)} para não precisar de crédito.`
      : `As entradas até lá não cobrem: faltam ${money(t ? t.need : -ag.min.balance)}. Vai precisar de crédito ou de renegociar antes de ${L.ddmm(ag.min.date)}.`}</span></div>`;
  } else if (hasBal && ag.min) {
    alert = `<div class="alert good">${icon('check', 20, 2.4)}<span><b>A conta não fica negativa nesse período.</b> Ponto mais baixo: ${money(ag.min.balance)} em ${L.ddmm(ag.min.date)}.</span></div>`;
  }
  const lim = L.addDays(today(), 7);
  const shown = state.agendaAll ? ag.events : ag.events.filter(e => e.date <= lim);
  const hiddenN = ag.events.length - shown.length;
  const rows = shown.map(e => `<div class="ev">
      <span class="d"><b>${L.ddmm(e.date)}</b><small>${L.weekdayShort(e.date)}</small></span>
      <span class="p ${e.kind}" aria-hidden="true"></span>
      <span class="t"><b>${esc(e.title)}</b><small class="${e.balance != null && e.balance < 0 && e.kind !== 'info' ? 'neg' : ''}">${e.kind === 'info' ? esc(e.sub) : e.balance != null ? `${esc(e.sub)} · saldo ${signed(e.balance)}` : esc(e.sub)}</small></span>
      <span class="a ${e.amount > 0 ? 'in' : ''}">${e.kind === 'info' ? '' : (e.amount > 0 && !state.priv ? '+' : '') + signed(e.amount)}${e.bill && e.bill.ym <= today().slice(0, 7) ? `<button class="pill" data-act="fix-pay" data-i="${e.bill.index}" data-ym="${e.bill.ym}">Marcar paga</button>` : ''}</span>
    </div>`).join('');
  return `<section class="card" aria-labelledby="ag-h">
    <div class="card-head"><h2 id="ag-h">Agenda do dinheiro</h2><span class="sub">${state.agendaAll ? 'próximas 5 semanas' : 'próximos 7 dias'}</span></div>
    <div class="balbox"><span>Saldo na conta ${hasBal ? `<b>${money(ag.start)}</b>${stale ? ` <span class="muted">· de ${L.ddmm(ag.balanceDate)}</span>` : ''}` : '<b>não informado</b>'}</span><button class="btn small" data-act="balance">${hasBal ? 'Atualizar' : 'Informar saldo'}</button></div>
    ${alert ? `<div style="margin-top:10px">${alert}</div>` : ''}
    ${!hasBal ? '<p class="help">Com o saldo da conta, a agenda mostra quanto sobra depois de cada entrada e saída e avisa antes de ficar no negativo.</p>' : ''}
    <div class="agenda" style="margin-top:6px">${rows || `<p class="help">Nada previsto nos próximos 7 dias.</p>`}</div>
    ${hiddenN > 0 || state.agendaAll ? `<button class="row add" data-act="agenda-all">${state.agendaAll ? 'Mostrar só os próximos 7 dias' : `Ver as próximas 5 semanas (+${hiddenN})`}</button>` : ''}
  </section>`;
}

// Meus cartões
function cardsCard() {
  const st = state.settings;
  const invs = L.cardInvoices(st, state.txs, state.rules, today());
  const hidden = new Set(st.hiddenCards || []);
  const shown = invs.filter(i => !hidden.has(i.card.id)), off = invs.filter(i => hidden.has(i.card.id));
  const total = shown.reduce((a, i) => a + i.total, 0);
  const one = i => {
    const c = i.card, color = safeColor(c.color);
    const status = !i.configured ? ['Sem datas', 'n'] : i.daysToClose <= 7 ? [`Fecha em ${i.daysToClose} ${i.daysToClose === 1 ? 'dia' : 'dias'}`, 'w'] : ['Aberta', ''];
    return `<div class="cc">
      <button class="cface" data-act="card-open" data-id="${esc(c.id)}" aria-label="Ver gastos do ${esc(c.name)}" style="background:${color};border:0;padding:0;text-align:left">
        <span class="b">${esc(c.name)}</span><span class="tier">${c.primary ? 'PRINCIPAL' : 'CRÉDITO'}</span>
        <span class="chipc" aria-hidden="true"></span><span class="nfc">${icon('nfc', 20)}</span>
        ${c.last4 ? `<span class="num4">•••• ${esc(String(c.last4).slice(-4))}</span>` : ''}<span class="kind">crédito</span>
      </button>
      <div class="cinfo"><span class="v"><small>${L.invoiceName(i.cycle, i.configured ? c : card(), today())}</small><b>${money(i.total)}</b></span>
        <span class="r"><span class="status ${status[1]}">${status[0]}</span><button class="icon-btn sm" data-act="card-hide" data-id="${esc(c.id)}" aria-label="Ocultar ${esc(c.name)}" title="Ocultar este cartão">${icon('eyeOff', 15)}</button></span></div>
      <div class="segbar mid" aria-hidden="true">${segs(i.len, i.elapsed, 'on', `background:${color}`)}</div>
      <span class="small muted">${i.configured ? `fecha ${L.ddmm(L.addDays(i.cycle.end, 1))} · vence ${L.ddmm(i.due)} · dia ${i.elapsed} de ${i.len}` : 'Informe o fechamento e o vencimento em Ajustes'}</span>
    </div>`;
  };
  return `<section class="card" aria-labelledby="mc-h">
    <div class="card-head"><h2 id="mc-h">Meus cartões</h2><span class="sub">aberto <b style="color:var(--text)">${money(total)}</b></span></div>
    ${shown.length ? `<div class="ccards">${shown.map(one).join('')}</div>` : '<p class="help">Todos os cartões estão ocultos.</p>'}
    ${off.length ? `<div class="hidden-cards" style="margin-top:12px">${off.map(i => `<button class="chip dashed" data-act="card-show" data-id="${esc(i.card.id)}"><span class="dot" style="background:${safeColor(i.card.color)}"></span>${esc(i.card.name)} oculto · mostrar</button>`).join('')}</div>` : ''}
  </section>`;
}

// Rubricas fora do padrão (Início): só o que pede atenção; o resto fica na Análise
function flagsCard(s) {
  const vr = s.rows.filter(r => !r.fixed && (r.varSpent > 0 || r.varBudget > 0));
  const att = vr.filter(r => r.status !== 'ok').sort((a, b) => b.varSpent - a.varSpent);
  const hasAvg = s.rows.some(r => r.avg > 0);
  const N = 30;
  const items = att.map(r => {
    const over = r.status === 'over', above = r.status === 'above';
    const tag = over ? 'teto estourado' : above ? `+${Math.round(r.vsAvg * 100)}% da média` : 'acima do ritmo';
    const txt = over ? `${money(r.varSpent)} de ${money(r.varBudget)}. Os ${money(-r.left)} a mais saem da sobra do mês.`
      : above ? `${money(r.freeSpent)} até agora, sem parcelas e assinaturas. Neste ponto do ciclo você costuma estar em ${money(r.expected)}.`
      : `${money(r.varSpent)} de ${money(r.varBudget)} com ${pct(s.elapsed)} do ciclo.`;
    const base = r.varBudget > 0 ? r.varBudget : r.avg;
    return `<button class="attc ${over ? 'o' : 'w'}" data-act="cat-open" data-c="${esc(r.name)}">
      <span class="h"><b>${esc(r.name)}</b><span class="tag">${tag}</span></span>
      <span class="segbar thin" aria-hidden="true">${segs(N, Math.min(N, Math.round((over ? r.varSpent : r.freeSpent) / Math.max(1, base) * N)), over ? 'of' : 'wf')}</span>
      <p>${txt}</p></button>`;
  }).join('');
  return `<section class="card" aria-labelledby="rb-h">
    <div class="card-head"><h2 id="rb-h">Fora do seu padrão</h2><button class="btn small ghost" data-act="view" data-v="analise">todas ›</button></div>
    ${att.length ? `<div class="att">${items}</div>` : `<p class="help">${hasAvg ? 'Todas as rubricas estão dentro do seu padrão neste ciclo.' : 'Depois de um ciclo fechado com compras, as rubricas que fugirem da sua média aparecem aqui.'}</p>`}
  </section>`;
}

// envios de fatura: compras importadas juntas (mesmo cartão, mesmo minuto)
function batches() {
  const map = new Map();
  for (const t of state.txs) {
    if (t.manual || !t.created_at) continue;
    const key = (t.source || 'nubank') + '|' + t.created_at.slice(0, 16);
    let b = map.get(key);
    if (!b) { b = { key, source: t.source || 'nubank', at: t.created_at, ids: [], total: 0, lo: t.date, hi: t.date }; map.set(key, b); }
    b.ids.push(t.id); b.total += Number(t.amount) || 0;
    if (t.date < b.lo) b.lo = t.date; if (t.date > b.hi) b.hi = t.date;
  }
  return [...map.values()].sort((a, b) => b.at.localeCompare(a.at));
}
const atLabel = iso => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} às ${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`; };

function lastBatchNotice() {
  if (!state.lastBatch) return '';
  const b = batches().find(x => x.key === state.lastBatch);
  if (!b) return '';
  return `<div class="notice info"><span>Fatura do ${esc(sourceName(b.source))} enviada: ${b.ids.length} ${b.ids.length === 1 ? 'compra nova' : 'compras novas'}. Mandou o arquivo errado?</span>
    <span style="display:flex;gap:8px"><button class="btn small" data-act="batch-undo" data-k="${esc(b.key)}">${icon('undo', 15)}Desfazer envio</button><button class="btn small ghost" data-act="batch-dismiss">Ok</button></span></div>`;
}

function undoBatchSheet(key) {
  const b = batches().find(x => x.key === key);
  if (!b) return toast('Esse envio não existe mais.');
  const html = `<h2>Desfazer envio</h2>
    <div class="meta">Fatura do ${esc(sourceName(b.source))} enviada em ${atLabel(b.at)}</div>
    <div class="sumbox"><div><span>Compras que saem do app</span><b>${b.ids.length}</b></div><div><span>Total</span><b>${money(b.total)}</b></div><div><span>Período</span><span>${L.ddmm(b.lo)} a ${L.ddmm(b.hi)}</span></div></div>
    <p class="help">Só as compras deste envio são apagadas. As regras que você criou continuam. Depois dá para enviar o arquivo certo normalmente.</p>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn danger grow" data-go>Apagar as ${b.ids.length} compras deste envio</button><button class="btn ghost" data-close>Cancelar</button></div>`;
  openSheet(html, (sh, close) => {
    sh.$('[data-go]').addEventListener('click', async () => {
      const btn = sh.$('[data-go]'); btn.disabled = true; btn.textContent = 'Apagando…';
      for (let i = 0; i < b.ids.length; i += 200) {
        const { error } = await sb.from('transactions').delete().in('id', b.ids.slice(i, i + 200)).eq('manual', false);
        if (error) { sh.$('[data-err]').textContent = 'Não apagou: ' + error.message; btn.disabled = false; return; }
      }
      if (state.lastBatch === key) state.lastBatch = null;
      await loadTxs(); close(); render(); toast(`Envio desfeito: ${b.ids.length} compras removidas.`);
    });
  });
}

// lembrete do envio semanal: última compra vinda de fatura
// domingo é o dia de enviar: avisa se o último envio é anterior ao domingo mais recente
function uploadNudge() {
  const last = lastUploadDay();
  if (!last) return '';
  const t = today();
  const sunday = L.addDays(t, -new Date(t + 'T12:00:00').getDay());
  if (last >= sunday) return '';
  const isSun = t === sunday;
  return `<div class="notice"><span>${isSun ? 'Domingo: envie as faturas do Nubank e do Inter para fechar a semana.' : `As faturas não foram enviadas no domingo (${L.ddmm(sunday)}). Até enviar, a semana só conta o que você lançou à mão.`}</span><button class="btn small" data-act="upload">Enviar agora</button></div>`;
}

// ----- Mês: entradas, contas e a sobra, num lugar só -----
function viewMes() {
  const ym = state.month || defaultMonth();
  const m = summary(cycleForMonth(ym));
  const plan = L.monthPlan({ settings: state.settings, txs: state.txs, rules: state.rules, incomes: state.incomes, ym });
  const c = card();
  const future = !m.isCurrent && !m.isPast;
  const canPay = ym <= today().slice(0, 7);
  const pend = m.isPast ? 0 : m.commits.pendingTotal;
  const cardOut = m.varSpent + pend;                       // cartões: o que já gastou + parcelas/assinaturas que ainda vêm
  const sobra = m.isPast ? m.result : m.balance;
  const sobraLbl = m.isPast ? 'Resultado do mês' : 'Saldo previsto do mês';
  const aporte = Number(state.settings.aporteGoal) || 0;

  const base = Math.max(1, m.income, m.fixedCost + cardOut);
  const W = v => `${Math.max(0, Math.min(100, v / base * 100)).toFixed(1)}%`;
  const flow = [
    ['Entradas', 0, m.income, 'var(--ok-fill)', money(m.income), 'pos'],
    ['− Contas', m.income - m.fixedCost, m.fixedCost, 'var(--fixed-fill)', '−' + money(m.fixedCost), ''],
    [`− Cartões${pend > 0 ? ' (+ a vir)' : ''}`, m.income - m.fixedCost - cardOut, cardOut, 'var(--over-fill)', '−' + money(cardOut), ''],
    ['= Saldo', 0, Math.max(0, sobra), sobra < 0 ? 'var(--over-fill)' : 'var(--ok-fill)', signed(sobra), sobra < 0 ? 'neg' : 'pos'],
  ].map(([l, x, w, col, v, cls]) => `<div class="flow"><span>${l}</span><span class="fb" aria-hidden="true"><i style="left:${W(Math.max(0, x))};width:${W(w)};background:${col}"></i></span><b class="${cls}">${v}</b></div>`).join('');

  const limSub = m.limitMode === 'manual' ? 'definido por você' : 'entradas − contas − aporte';
  const bad = plan.income > 0 && plan.forVar < 0 ? `<div class="alert bad" style="margin-top:12px">${icon('warn', 20)}<span><b>As contas${plan.aporte > 0 ? ' e o aporte' : ''} já passam das entradas.</b> Faltam ${money(-plan.forVar)} antes de qualquer gasto variável.</span></div>`
    : plan.manual != null && plan.slack < 0 ? `<div class="alert bad" style="margin-top:12px">${icon('warn', 20)}<span><b>Seu limite de ${money(plan.manual)} não cabe.</b> Ficam livres ${money(plan.forVar)}${plan.aporte > 0 ? ' depois do aporte' : ''}.</span></div>` : '';

  // entradas
  const inc = m.incomeItems;
  const rec = inc.filter(i => i.received).length;
  const incRows = inc.map(it => `<div class="lrow">
      <span class="ic ${it.received ? 'ok' : ''}" style="flex-direction:column;gap:0;line-height:1.05"><b style="font-size:13px">${L.ddmm(it.date).slice(0, 2)}</b><small style="font-size:10px;font-weight:600">${L.MONTHS_SHORT[+it.date.slice(5, 7) - 1]}</small></span>
      <span class="m"><b>${esc(it.name)}</b><small class="${it.received ? 'g' : ''}">${esc(incomeRef(it, ym))} · ${it.received ? 'recebida' : it.extra ? 'avulsa' : 'prevista'}</small></span>
      <span class="r"><b>${money(it.amount)}</b>${it.received
        ? `<button class="pill ok" data-act="income-undo" data-id="${it.id}" aria-label="${esc(it.name)} recebida. Tocar para ${it.extra ? 'apagar' : 'desfazer'}">${it.extra ? 'apagar' : 'recebida ✓'}</button>`
        : `<button class="pill" data-act="income-confirm" data-key="${esc(it.key)}" data-ym="${it.target}">Confirmar</button>`}</span>
    </div>`).join('');

  // contas fora do cartão (com pago / a pagar) e as que já vão na fatura
  const bills = L.billsFor(state.settings, ym, state.txs, state.rules);
  const fx = m.fixedItems;
  const paidN = fx.filter(f => f.paid).length;
  const payName = p => ({ pix: 'Pix', boleto: 'Boleto', debito: 'Débito', dinheiro: 'Dinheiro' }[p] || 'Pix');
  const fxRows = fx.map(f => {
    const b = bills.find(x => x.index === f.index) || {};
    const extra = b.parcel ? `parcela ${b.parcel.n} de ${b.parcel.total}` : b.kind === 'estimate' ? ((b.history || []).length > 1 ? `${b.basis === 'max' ? 'maior' : 'média'} de ${b.history.length} meses` : 'valor informado') : '';
    const sub = [f.category || 'sem rubrica', payName(b.pay), b.day ? `dia ${b.day}` : '', extra].filter(Boolean).map(esc).join(' · ');
    return `<div class="lrow">
      <button class="m linkish" data-act="bill-edit" data-i="${f.index}" aria-label="Ver ${esc(f.name)}"><b>${esc(f.name)} <span class="ktag ${b.kind === 'estimate' ? '' : 'ex'}">${b.kind === 'estimate' ? 'ESTIMADA' : 'EXATA'}</span></b><small>${sub}</small>
        ${b.parcel ? `<span class="pmini"><span class="thinbar" aria-hidden="true"><i style="width:${Math.round((b.parcel.n - 1) / b.parcel.total * 100)}%"></i></span><small>faltam ${b.parcel.total - b.parcel.n + 1} · ${money(f.value * (b.parcel.total - b.parcel.n + 1))}</small></span>` : ''}</button>
      <span class="r"><b class="${f.paid ? '' : 'muted'}">${money(f.paid ? f.paidAmount : f.value)}</b>
      ${f.paid ? `<button class="pill ok" data-act="fix-unpay" data-id="${f.tx.id}" aria-label="${esc(f.name)} paga. Tocar para ver">paga ✓</button>`
        : canPay ? `<button class="pill" data-act="fix-pay" data-i="${f.index}" data-ym="${ym}">Marcar paga</button>` : `<span class="pill ghost">a pagar</span>`}</span>
    </div>`;
  }).join('');
  const onCard = plan.all.filter(b => b.onCard && !b.auto);   // as parcelas detectadas ficam em Compromissos do cartão

  return `${pageHead('Mês', '', headActions())}
    <div class="cycle">
      <button class="icon-btn sm" data-act="month" data-d="-1" aria-label="Mês anterior">‹</button>
      <div class="lbl"><b>${monthName(ym)}</b><span>folha de ${mName(ym)} · ${esc(L.invoiceName(m.cycle, c, today()).toLowerCase())} (vence ${L.ddmm(L.dueDateFor(m.cycle, c))})</span></div>
      <button class="icon-btn sm" data-act="month" data-d="1" aria-label="Próximo mês">›</button>
    </div>
    <div class="cols">
      <div class="col-main">
        <section class="card" aria-labelledby="sb-h">
          <span id="sb-h" class="k">${sobraLbl}</span>
          <span class="big ${m.income > 0 ? (sobra < 0 ? 'neg' : 'pos') : ''}" style="display:block;margin:4px 0">${m.income > 0 ? (sobra >= 0 && !state.priv ? '+' : '') + signed(sobra) : '—'}</span>
          <p class="small" style="margin:0 0 12px;color:var(--text-2)">${m.isPast ? 'O que entrou menos o que saiu na competência.' : 'Se você não gastar mais nada neste mês.'}</p>
          <div class="flows">${flow}</div>
          ${m.varBudget > 0 ? `<details class="limbox2">
            <summary>
              <span><small>Limite do dia a dia</small><b>${money(m.freeBudget)}</b></span>
              <span class="u ${m.freeSpent > m.freeBudget ? 'neg' : ''}"><small>usado</small><b>${money(m.freeSpent)}${m.freeBudget > 0 ? ` (${Math.round(m.freeSpent / m.freeBudget * 100)}%)` : ''}</b></span>
            </summary>
            <div class="lb-body">
              <div class="lb-row"><span>Limite do variável <small>(${limSub})</small></span><b>${money(m.varBudget)}</b></div>
              <div class="lb-row"><span>− Parcelas e assinaturas no cartão</span><b>${money(m.committed)}</b></div>
              ${[...m.commits.actual, ...m.commits.pending].map(c => { const pm = String(c.title).match(/parcela\s*(\d+)\s*\/\s*(\d+)/i); const k = pm ? +pm[1] : 0, n = pm ? +pm[2] : 0;
                return `<div class="lrow sub"><span class="m"><b>${esc(L.prettyTitle(c.title))}</b><small>${c.kind}${c.pending ? ' · ainda não veio' : ' · ' + L.ddmm(c.date)}${n ? ` · depois desta, faltam ${n - k} (${money(c.amount * (n - k))})` : ''}</small>${n ? `<span class="thinbar" aria-hidden="true" style="margin-top:6px"><i style="width:${Math.round(k / n * 100)}%"></i></span>` : ''}</span><span class="r"><b class="${c.pending ? 'muted' : ''}">${money(c.amount)}</b></span></div>`; }).join('')}
              <div class="actions"><button class="btn small" data-act="view" data-v="ajustes">Ajustar limite</button></div>
            </div>
          </details>` : ''}
          ${bad}
        </section>
        <section class="card" aria-labelledby="en-h">
          <div class="card-head"><h2 id="en-h">Entradas</h2><span class="sub"><b style="color:var(--text)">${money(m.income)}</b> · ${rec} de ${inc.length} recebidas</span></div>
          ${incRows || '<p class="help">Nenhuma entrada prevista. Configure salário e vintena em Entradas fixas.</p>'}
          <div class="actions"><button class="btn soft small" data-act="inc-add" data-ym="${ym}">+ Recebimento avulso</button><button class="btn small ghost" data-act="inc-rules" data-ym="${ym}">Entradas fixas</button></div>
        </section>
      </div>
      <div class="col-side">
        <section class="card" aria-labelledby="ct-h">
          <div class="card-head"><h2 id="ct-h">Contas</h2><span class="sub"><b style="color:var(--text)">${money(m.fixedCost)}</b> · ${paidN} de ${fx.length} pagas</span></div>
          ${fxRows || `<p class="help">Nenhuma conta fora do cartão em ${mName(ym)}.</p>`}
          ${onCard.length ? `<details class="oncard"><summary><span><b>Cadastradas no cartão</b><small>${onCard.length} ${onCard.length === 1 ? 'conta' : 'contas'} · vêm na fatura, não somam aqui</small></span><b>${money(onCard.reduce((x, b) => x + b.value, 0))}</b></summary>${onCard.map(billRow).join('')}</details>` : ''}
          <div class="actions"><button class="btn primary grow" data-act="bill-new" data-ym="${ym}">${icon('plus', 16, 2.4)}Nova conta</button></div>
        </section>
      </div>
    </div>`;
}

function billRow(b) {
  const payName = b.onCard ? sourceName(b.pay) : ({ pix: 'Pix', boleto: 'Boleto', debito: 'Débito', dinheiro: 'Dinheiro' }[b.pay] || 'Pix');
  const sub = [catNames().includes(b.category) ? b.category : 'sem rubrica', payName, b.day ? `dia ${b.day}` : ''].filter(Boolean).map(esc).join(' · ');
  let viz = '', vizLabel = '', right = '';
  if (b.parcel) {
    const n = Math.min(b.parcel.total, 36);
    viz = Array.from({ length: n }, (_, i) => `<i class="${i < b.parcel.n - 1 ? 'on' : i === b.parcel.n - 1 ? 'cur' : ''}"></i>`).join('');
    vizLabel = `até ${L.MONTHS_SHORT[+b.parcel.endYM.slice(5, 7) - 1]}/${b.parcel.endYM.slice(0, 4)} · faltam ${b.parcel.total - b.parcel.n + 1}`;
    right = `${b.parcel.n} de ${b.parcel.total}`;
  } else if (b.kind === 'estimate') {
    const h = b.history || [];
    const max = Math.max(1, ...h.map(x => x.value));
    viz = h.map((x, i) => `<i class="${i === h.length - 1 ? 'on' : 'h'}" style="height:${Math.round(8 + (x.value / max) * 18)}px"></i>`).join('') || '<i></i>';
    vizLabel = h.length ? h.map(x => money(x.value).replace('R$ ', '').replace(/,\d\d$/, '')).join(' · ') : 'sem histórico: usa o valor informado';
    right = h.length > 1 ? `${b.basis === 'max' ? 'maior' : 'média'} de ${h.length} meses` : 'valor informado';
  } else {
    viz = Array.from({ length: 12 }, () => '<i class="h"></i>').join('');
    vizLabel = 'todo mês, sem fim';
    right = 'todo mês';
  }
  const tag = b.auto ? 'span' : 'button';
  return `<${tag} class="bill" ${b.auto ? '' : `data-act="bill-edit" data-i="${b.index}"`}>
    <span class="top lrow" style="border:0;padding:0"><span class="ic" style="${b.onCard ? `background:${safeColor(sourceColor(b.pay))}22;color:${safeColor(sourceColor(b.pay))}` : ''}">${esc(b.name.slice(0, 2))}</span>
      <span class="m"><b>${esc(b.name)}</b><small>${sub}${b.auto ? ' · detectada na fatura' : ''}</small></span>
      <span class="r"><b>${money(b.value)}</b><small>${esc(right)}</small></span></span>
    <span class="viz"><span class="bars" aria-hidden="true">${viz}</span><small>${esc(vizLabel)}</small></span>
  </${tag}>`;
}

// ----- Gastos -----
function gastosList(s) {
  const known = new Set(catNames().concat([L.IGNORE]));
  const f = state.filter, qq = L.normalize(state.q);
  const isCard = t => state.settings.cards.some(c => c.id === (t.source || 'nubank'));
  const list = s.txs.filter(t => f === 'all' ? true : f === 'unc' ? !known.has(t.cat) : f === 'cards' ? isCard(t) : f === 'out' ? !isCard(t) : f.startsWith('src:') ? (t.source || 'nubank') === f.slice(4) : f.startsWith('cat:') ? t.cat === f.slice(4) : true)
    .filter(t => !qq || L.normalize(`${t.title} ${L.prettyTitle(t.title)} ${t.cat} ${t.amount.toFixed(2).replace('.', ',')}`).includes(qq))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  if (!list.length) return `<p class="help" style="margin-top:20px">${qq ? 'Nada encontrado.' : 'Nada aqui neste ciclo.'}</p>`;
  const days = [];
  for (const t of list) { let d = days[days.length - 1]; if (!d || d.date !== t.date) { d = { date: t.date, items: [], sum: 0 }; days.push(d); } d.items.push(t); if (t.cat !== L.IGNORE) d.sum += t.amount; }
  const ini = name => { const w = L.prettyTitle(name).replace(/^iFood · /, 'iF ').split(/\s+/).filter(Boolean); return esc(((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase()); };
  const html = days.map(d => `<div class="day"><span>${longDay(d.date)}</span><span>${money(d.sum)}</span></div><div class="daybox">${d.items.map(t => {
    const isUnc = !known.has(t.cat);
    const sub = isUnc ? 'Sem rubrica · toque para classificar' : `${t.cat === L.IGNORE ? 'Ignorado' : esc(t.cat)} · ${esc(sourceName(t.source))}${t.isFixed ? ` · conta de ${L.MONTHS[+t.date.slice(5, 7) - 1]}` : t.commit ? ` · ${t.commit}` : ''}${t.oneOff ? ' · pontual' : ''}${t.manual ? ' · à mão' : ''}`;
    return `<button class="tx ${t.cat === L.IGNORE ? 'ign' : ''}" data-act="tx" data-id="${t.id}">
      <span class="av ${isUnc ? 'unc' : ''}">${ini(t.title)}</span>
      <span class="t"><span>${esc(L.prettyTitle(t.title))}</span><span class="c ${isUnc ? 'unc' : ''}">${sub}</span></span>
      <span class="v ${t.amount < 0 ? 'pos' : ''}">${signed(t.amount)}</span></button>`;
  }).join('')}</div>`).join('');
  const sum = list.filter(t => t.cat !== L.IGNORE).reduce((a, t) => a + t.amount, 0);
  return html + `<div class="total-line"><span>${list.length} ${list.length === 1 ? 'lançamento' : 'lançamentos'}</span><span>${signed(sum)}</span></div>`;
}

function viewGastos(s) {
  const known = new Set(catNames().concat([L.IGNORE]));
  const unc = s.txs.filter(t => !known.has(t.cat));
  const present = new Set(s.txs.map(t => t.source || 'nubank'));
  const cardIds = state.settings.cards.map(c => c.id);
  const srcIds = [...cardIds, ...L.METHODS.map(m => m.id)].filter(id => present.has(id) || cardIds.includes(id));
  const hasOut = s.txs.some(t => !cardIds.includes(t.source || 'nubank'));
  const catsHere = catNames().filter(c => s.txs.some(t => t.cat === c));
  const f = state.filter;
  const chip = (id, label, extra = '') => `<button class="chip ${extra}" data-act="filter" data-f="${esc(id)}" aria-pressed="${f === id}">${label}</button>`;
  const total = s.txs.filter(t => t.cat !== L.IGNORE).reduce((a, t) => a + t.amount, 0);
  return `${pageHead('Gastos', `${s.txs.length} ${s.txs.length === 1 ? 'lançamento' : 'lançamentos'} · ${money(total)}`)}
    ${cycleRow(s)}
    <label class="search">${icon('search')}<input id="gq" type="search" placeholder="Buscar loja, rubrica ou valor" value="${esc(state.q)}" aria-label="Buscar gastos"></label>
    <div class="chips" role="toolbar" aria-label="Filtrar">
      ${chip('all', 'Todos')}
      ${unc.length ? chip('unc', `Sem rubrica · ${unc.length}`, 'flag') : ''}
      ${chip('cards', 'Cartões')}${hasOut ? chip('out', 'Fora do cartão') : ''}
      ${srcIds.map(id => chip('src:' + id, `<span class="dot" style="background:${safeColor(sourceColor(id))}"></span>${esc(sourceName(id))}`)).join('')}
      ${catsHere.map(c => chip('cat:' + c, esc(c))).join('')}
    </div>
    ${catAvail(s)}
    <div id="txlist">${gastosList(s)}</div>`;
}

// Disponível por rubrica: teto (se tiver) ou a sua média. Toque filtra a lista.
function catAvail(s) {
  const rows = s.rows.filter(r => !r.fixed && (r.freeSpent > 0 || r.varBudget > 0 || r.avg > 0));
  if (!rows.length) return '';
  const item = r => {
    const ref = r.varBudget > 0 ? r.varBudget : r.avg;
    const spent = r.varBudget > 0 ? r.varSpent : r.freeSpent;
    const left = ref - spent;
    const over = ref > 0 && left < 0;
    const lbl = r.varBudget > 0 ? 'do teto' : 'da média';
    return `<button class="avc ${over ? 'over' : ''} ${state.filter === 'cat:' + r.name ? 'on' : ''}" data-act="filter" data-f="cat:${esc(r.name)}">
      <small>${esc(r.name)}</small>
      <b>${ref > 0 ? (over ? '−' + money(-left) : money(left)) : money(spent)}</b>
      <span class="thinbar ${over ? 'over' : ''}" aria-hidden="true"><i style="width:${ref > 0 ? Math.min(100, Math.round(spent / ref * 100)) : 0}%"></i></span>
      <em>${ref > 0 ? `${over ? 'passou' : 'resta'} ${lbl} · ${money(spent)} de ${money(ref)}` : 'sem média ainda'}</em>
    </button>`;
  };
  return `<details class="avail" ${state.availOpen ? 'open' : ''}><summary>Disponível por rubrica <span class="muted">· teto ou sua média por ciclo</span></summary>
    <div class="avgrid">${rows.sort((a, b) => (b.freeSpent || b.varSpent) - (a.freeSpent || a.varSpent)).map(item).join('')}</div></details>`;
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
    <text class="note" x="${X(oi) + 8}" y="${Y(s.overDay.value) + 18}" font-size="${fs}">passou do limite em ${L.ddmm(s.overDay.date)}</text>` : '';
  const li = pts.length - 1;
  const end = li >= 0 ? `<circle class="pt" cx="${X(li)}" cy="${Y(last)}" r="5"></circle>
    <text class="note" x="${X(li) - 8}" y="${Y(last) - 10}" text-anchor="end" font-size="${fs}">${money(last)}</text>` : '';
  const mid = Math.floor((n - 1) / 2);
  const data = esc(JSON.stringify({ W, H, n, max, vals: pts.map(p => p.value), dates: pts.map(p => p.date) }));
  return `<svg viewBox="${vb}" data-chart="${data}" role="img" aria-label="Gasto acumulado no ciclo: ${money(last)}${s.overDay ? `, passou do limite em ${L.ddmm(s.overDay.date)}` : ''}">
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

function weeksCard(s) {
  const ws = s.weeks.filter(w => w.limit != null);
  if (!ws.length) return '';
  const max = Math.max(1, ...ws.map(w => Math.max(w.limit, w.spent))) * 1.05;
  const rows = ws.map(w => {
    const over = w.status !== 'next' && w.spent - w.limit > 0.5;
    const note = (w.status === 'now' ? 'esta semana' : w.status === 'next' ? 'prevista' : w.days < 7 ? `${w.days} dias` : '') + (w.containment ? ' · contenção' : '');
    const val = w.status === 'next' ? `libera ~${money(w.limit)}` : w.status === 'now' ? `${money(w.spent)} de ${money(w.limit)}` : over ? `+${money(w.spent - w.limit)} acima` : `${money(w.limit - w.spent)} abaixo`;
    return `<div class="wkrow ${w.status}">
      <div class="lab"><span><b>${L.ddmm(w.start)}–${L.ddmm(w.end)}</b> <span class="muted">${note}</span></span><span class="${over ? 'neg' : w.status === 'next' ? 'muted' : ''}">${val}</span></div>
      <div class="trk" aria-hidden="true"><i class="${over ? 'over' : ''}" style="width:${(w.spent / max * 100).toFixed(1)}%"></i><span class="tick" style="left:${(w.limit / max * 100).toFixed(1)}%"></span></div>
    </div>`;
  }).join('');
  return `<section class="card full">
    <div class="card-head"><h2>Semana a semana</h2><span class="sub">seg a dom · a cada envio de fatura, a próxima semana é recalculada</span></div>
    <div class="legend"><span><span class="sw-bar"></span>Gasto</span><span><span class="sw-tick"></span>Liberado</span></div>
    <div class="weeks">${rows}</div>
  </section>`;
}

function viewAnalise(s) {
  const prev = summary(L.shiftCycle(s.cycle.start, -1, card().closing || 1));
  const prevTotal = prev.varSpent;
  // no ciclo atual, compara com o anterior no mesmo dia do ciclo (não com o ciclo inteiro)
  const day = s.isCurrent ? L.daysBetween(s.cycle.start, today()) : null;
  const prevSame = day != null ? ((prev.cumulative[Math.min(day, prev.cumulative.length - 1)] || {}).value || 0) : prevTotal;
  const diff = prevSame > 0 ? (s.varSpent - prevSame) / prevSame : null;
  const kpis = [
    ['Gasto no ciclo', money(s.varSpent), 'sem os fixos'],
    s.varBudget > 0 ? [s.overBudget > 0 ? 'Acima do limite' : 'Abaixo do limite', money(Math.abs(s.overBudget)), `limite ${money(s.varBudget)}`, s.overBudget > 0 ? 'neg' : ''] : ['Limite do variável', '—', 'informe as entradas'],
    s.isCurrent ? ['Projeção até fechar', money(s.varProjected), s.week && s.week.limit != null ? `nesta semana ${s.week.left >= 0 ? 'restam' : 'passou'} ${money(Math.abs(s.week.left))}` : 'no ritmo atual'] : ['Média por dia', money(s.varSpent / s.totalDays), `${s.totalDays} dias de ciclo`],
    s.isCurrent ? ['Ciclo anterior até o dia ' + (day + 1), prevSame > 0 ? money(prevSame) : '—', diff != null && s.varSpent > 0 ? `este ciclo: ${diff >= 0 ? '+' : '−'}${pct(Math.abs(diff))} · fechou em ${money(prevTotal)}` : 'sem dados']
      : ['Ciclo anterior', prevTotal > 0 ? money(prevTotal) : '—', diff != null && s.varSpent > 0 ? `este ciclo: ${diff >= 0 ? '+' : '−'}${pct(Math.abs(diff))}` : prevTotal > 0 ? 'fatura passada' : 'sem dados'],
  ];

  // referência de cada rubrica: o teto (se houver) ou a média do ciclo inteiro, mais as contas dela
  // gasto mostrado = dia a dia (sem parcelas e assinaturas) + contas da rubrica, para comparar com a média, que também é do dia a dia
  const shownOf = r => r.varBudget > 0 ? r.spent : Math.round((r.spent - r.varSpent + r.freeSpent) * 100) / 100;
  const refOf = r => r.varBudget > 0 ? r.budget : r.avg > 0 ? Math.round((r.avg + r.linked) * 100) / 100 : r.linked;
  const refLbl = r => r.varBudget > 0 ? `teto ${money(r.budget)}` : r.avg > 0 ? `média ${money(refOf(r))}` : r.linked > 0 ? `contas ${money(r.linked)}` : '';
  const maxBar = Math.max(1, ...s.rows.map(r => Math.max(shownOf(r), refOf(r)))) * 1.05;
  const bars = s.rows.filter(r => shownOf(r) > 0 || refOf(r) > 0).sort((a, b) => shownOf(b) - shownOf(a)).map(r => {
    const ref = refOf(r), sp = shownOf(r), over = r.varBudget > 0 ? r.spent > r.budget : r.status === 'above';
    return `<div class="hbar" title="${esc(r.name)}: ${money(sp)}${refLbl(r) ? ' · ' + refLbl(r) : ''}">
      <div class="lab"><span>${esc(r.name)}</span><span><b>${money(sp)}</b> <span class="muted">${refLbl(r)}</span></span></div>
      <div class="trk"><div class="val ${over ? 'over' : ''}" style="width:${(sp / maxBar * 100).toFixed(1)}%"></div>${ref > 0 ? `<div class="tick" style="left:${(ref / maxBar * 100).toFixed(1)}%"></div>` : ''}</div>
    </div>`;
  }).join('');

  const totalSrc = Object.values(s.bySource).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const allSrc = sources().filter(x => x.card || s.bySource[x.id]);
  const stack = allSrc.filter(x => (s.bySource[x.id] || 0) > 0).map(x => `<div style="width:${(s.bySource[x.id] / totalSrc * 100).toFixed(1)}%;background:${safeColor(x.color)}"></div>`).join('');
  const srcRows = allSrc.map(x => {
    const v = s.bySource[x.id];
    return `<div class="list-row ${v ? '' : 'muted'}"><span style="display:flex;align-items:center;gap:10px"><span class="dot" style="background:${safeColor(x.color)}"></span>${esc(x.name)}</span><span>${v ? `<b>${money(v)}</b>` : (x.card ? 'sem fatura' : 'nada lançado')}</span></div>`;
  }).join('');
  const top = s.topMerchants.map(m => `<div class="list-row"><span>${esc(m.label)}</span><b>${money(m.total)}</b></div>`).join('');

  return `${pageHead('Análise', 'como você está gastando neste ciclo')}
    ${cycleRow(s)}
    <div class="kpis">${kpis.map(([k, v, sm, cls]) => `<div><span class="kl">${k}</span><b class="${cls || ''}">${v}</b>${sm ? `<small>${sm}</small>` : ''}</div>`).join('')}</div>
    ${!s.txs.length ? `<p class="help" style="margin-top:20px">Ainda não há gastos neste ciclo.</p>` : `
    <div class="dash" style="margin-top:16px">
      ${weeksCard(s)}
      <section class="card">
        <div class="card-head"><h2>Ritmo do ciclo</h2></div>
        <div class="legend"><span><span class="sw-line"></span>Gasto acumulado (sem fixos)</span>${s.varBudget > 0 ? `<span><span class="sw-dash"></span>Limite do variável · ${money(s.varBudget)}</span>` : ''}</div>
        <div class="chart only-mob">${lineChart(s, 340, 150, true)}<div class="tip"></div></div>
        <div class="chart only-desk">${lineChart(s, 720, 220, false)}<div class="tip"></div></div>
      </section>
      <section class="card">
        <div class="card-head"><h2>Por origem</h2></div>
        <div class="stack" role="img" aria-label="Divisão do gasto por origem">${stack}</div>
        <div style="margin-top:8px">${srcRows}</div>
        <div class="card-head" style="margin-top:18px"><h2>Onde mais gastou</h2></div>
        ${top || '<p class="help">Nada ainda.</p>'}
      </section>
      <section class="card full">
        <div class="card-head"><h2>Por rubrica</h2></div>
        <div class="legend"><span><span class="sw-bar"></span>Gasto do dia a dia + contas</span><span><span class="sw-tick"></span>Sua média (ou teto) + contas</span></div>
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
  // variável: a soma das médias por rubrica; sem histórico ainda, o limite do mês
  const a = averages();
  const variable = a.cycles.length ? Object.values(a.avg).reduce((s, v) => s + v, 0) : summary(curCycle()).varBudget;
  return fixed + variable;
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
  const curS = summary(curCycle());
  const curOver = curS.freeBudget > 0 && curS.freeSpent > curS.freeBudget;

  const accRow = a => {
    const g = a.goal ? Math.min(1, a.balance / a.goal) : null;
    return `<button class="row" data-act="account" data-id="${a.id}" style="flex-direction:column;align-items:stretch">
      <span style="display:flex;justify-content:space-between;gap:10px"><span>${esc(a.name)}</span><b>${money(a.balance)}</b></span>
      ${g != null ? `<span class="meter"><span class="brand" style="width:${(g * 100).toFixed(1)}%"></span></span><span class="small muted">${pct(g)} de ${money(a.goal)}${a.note ? ' · ' + esc(a.note) : ''}</span>`
        : `<span class="small muted">${a.note ? esc(a.note) : 'sem meta'}</span>`}
    </button>`;
  };

  return `${pageHead('Reservas', 'reserva de emergência, caixinhas e investimentos', headActions({ upload: false }))}
    <section class="card"><div class="k">Total guardado</div>
    <div class="big md">${money(total)}</div>
    <div class="small muted">${lastUpd ? `Saldos atualizados em ${L.dayMonth(lastUpd.slice(0, 10))}` : 'Cadastre abaixo onde você guarda dinheiro.'}</div>
    <div class="actions"><button class="btn primary grow" data-act="aporte" ${accs.length ? '' : 'disabled'}>Registrar aporte</button><button class="btn grow" data-act="saldos" ${accs.length ? '' : 'disabled'}>Atualizar saldos</button></div></section>

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
      ${negWarn || curOver ? `<div class="small muted"><b>Aporte pausado:</b> com fatura acima do limite, pagar o cartão rende mais do que guardar. Volte a aportar quando o mês fechar no positivo.</div>` : ''}
    </section>` : ''}

    <section class="card"><div class="card-head"><h2>Caixinhas</h2></div>
    ${accs.filter(a => a.kind === 'caixinha').map(accRow).join('')}
    <button class="row add" data-act="account-new" data-kind="caixinha">Nova caixinha</button></section>

    <section class="card"><div class="card-head"><h2>Investimentos</h2></div>
    ${accs.filter(a => a.kind === 'investimento').map(accRow).join('')}
    <button class="row add" data-act="account-new" data-kind="investimento">Adicionar investimento</button></section>`;
}

// ----- Ajustes -----
function startDraft() { state.draft = structuredClone(state.settings); }

function viewAjustes() {
  if (!state.draft) startDraft();
  const d = state.draft;
  const income = (state.settings.incomeRules || []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const cards = d.cards.map((c, i) => `<div class="edit-row card" style="grid-template-columns:minmax(0,1fr) 64px 64px 64px 44px 34px">
      <input class="input" data-bind="cards.${i}.name" value="${esc(c.name)}" aria-label="Nome do cartão">
      <input class="input" data-bind="cards.${i}.closing" data-type="int" inputmode="numeric" value="${c.closing ?? ''}" aria-label="Dia do fechamento" placeholder="fecha">
      <input class="input" data-bind="cards.${i}.due" data-type="int" inputmode="numeric" value="${c.due ?? ''}" aria-label="Dia do vencimento" placeholder="vence">
      <input class="input" data-bind="cards.${i}.last4" inputmode="numeric" maxlength="4" value="${esc(c.last4 || '')}" aria-label="Final do cartão (opcional)" placeholder="final">
      <input class="input" type="color" data-bind="cards.${i}.color" value="${safeColor(c.color)}" aria-label="Cor do cartão" style="padding:4px;min-height:46px">
      <button class="icon-btn sm" data-act="del" data-path="cards" data-i="${i}" aria-label="Remover cartão" ${c.primary ? 'disabled' : ''}>×</button></div>`).join('');
  const cats = d.categories.map((c, i) => `<div class="edit-row cat">
      <input class="input" data-bind="categories.${i}.name" value="${esc(c.name)}" aria-label="Rubrica">
      <input class="input" data-bind="categories.${i}.budget" data-type="money" inputmode="decimal" value="${c.budget > 0 ? fmtIn(c.budget) : ''}" placeholder="sem teto" aria-label="Teto (opcional)">
      <label class="check"><input type="checkbox" data-bind="categories.${i}.fixed" data-type="bool" ${c.fixed ? 'checked' : ''}> fixa</label>
      <label class="check" title="Entra no modo contenção"><input type="checkbox" data-bind="categories.${i}.essential" data-type="bool" ${c.essential ? 'checked' : ''}> essencial</label>
      <button class="icon-btn sm" data-act="del" data-path="categories" data-i="${i}" aria-label="Remover rubrica">×</button></div>`).join('');
  const options = sel => [...catNames(), L.IGNORE].map(n => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const rules = [...state.rules].sort((a, b) => a.category.localeCompare(b.category) || a.keyword.localeCompare(b.keyword))
    .map(r => `<div class="edit-row rule">
      <input class="input" data-rule-kw="${r.id}" value="${esc(r.keyword)}" aria-label="Palavra da regra">
      <select class="input" data-rule-cat="${r.id}" aria-label="Rubrica da regra">${options(r.category)}</select>
      <button class="icon-btn sm" data-act="del-rule" data-id="${r.id}" aria-label="Apagar regra">×</button></div>`).join('');
  const theme = document.documentElement.dataset.theme || 'auto';
  return `${pageHead('Ajustes', esc(state.user.email), headActions({ upload: false }))}
    <section class="card">
      <div class="card-head"><h2>O mês</h2></div>
      <button class="row" data-act="view" data-v="entradas"><span>Entradas · salário e vintena</span><span class="end"><b style="color:var(--text)">${income ? money(income) : 'informar'}</b> ›</span></button>
      <button class="row" data-act="view" data-v="contas"><span>Contas · exatas, estimadas e parceladas</span><span class="end">${(state.settings.fixed || []).length} cadastradas ›</span></button>
      <button class="row" data-act="balance"><span>Saldo na conta (agenda do dinheiro)</span><span class="end">${state.settings.balance ? money(state.settings.balance.value) : 'informar'} ›</span></button>
    </section>
    <section class="card">
      <div class="card-head"><h2>Cartões</h2></div>
      <p class="help">Nome, dia em que a fatura fecha, dia em que vence, final (opcional) e cor. O principal define o ciclo do app.</p>
      ${cards}
      <button class="row add" data-act="add" data-path="cards">Adicionar cartão</button>
    </section>
    <section class="card">
      <div class="card-head"><h2>Limite do mês</h2></div>
      <p class="help">Um número só para tudo o que varia (cartão, Pix, à mão). Em branco, o app calcula: entradas − contas − meta de aporte${(() => { const x = summary(curCycle()); return x.limitMode === 'auto' ? `, que neste ciclo dá <b>${money(x.autoLimit)}</b>` : ''; })()}. Preencha só se quiser um limite mais apertado.</p>
      <div class="field"><label for="vl">Limite do variável por mês</label><input class="input" id="vl" data-bind="varLimit" data-type="money" inputmode="decimal" value="${d.varLimit > 0 ? fmtIn(d.varLimit) : ''}" placeholder="automático"></div>
      <div class="card-head" style="margin-top:18px"><h2>Rubricas</h2></div>
      <p class="help">As rubricas servem para ver onde o dinheiro foi. O app compara cada uma com a sua média dos últimos ciclos e avisa quando alguma foge do padrão. Teto é opcional: use só na rubrica que você quer segurar (ex.: delivery). Marque "fixa" na rubrica que não varia no mês e "essencial" no que não dá para cortar: quando o limite do mês acaba, o app entra em modo contenção e libera por semana só a média das essenciais.</p>
      ${cats}
      <button class="row add" data-act="add" data-path="categories">Adicionar rubrica</button>
    </section>
    <section class="card">
      <div class="card-head"><h2>Reservas</h2></div>
      <div class="grid2">
        <div class="field"><label for="rm">Meses na reserva de emergência</label><input class="input" id="rm" data-bind="reserveMonths" data-type="int" inputmode="numeric" value="${d.reserveMonths ?? 6}"></div>
        <div class="field"><label for="ag">Meta de aporte por mês</label><input class="input" id="ag" data-bind="aporteGoal" data-type="money" inputmode="decimal" value="${fmtIn(d.aporteGoal)}"></div>
      </div>
      <div class="actions"><button class="btn primary" data-act="save-draft">Salvar ajustes</button></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Regras: como o app reconhece as compras</h2><span class="sub">${state.rules.length} regras</span></div>
      <p class="help">Se a descrição da compra tem a palavra, ela vai para a rubrica. A palavra mais específica vence. Toda vez que você classifica uma compra com "Lembrar para as próximas", uma regra nova aparece aqui. Edite a palavra ou a rubrica e a mudança vale na hora, inclusive para as compras antigas.</p>
      <div class="edit-row rule">
        <input class="input" id="new-kw" placeholder="nova palavra, ex.: padaria" aria-label="Palavra">
        <select class="input" id="new-cat" aria-label="Rubrica">${options(catNames()[0])}</select>
        <button class="icon-btn sm" data-act="add-rule" aria-label="Adicionar regra" style="background:var(--brand);color:var(--on-brand);border-color:var(--brand)">+</button>
      </div>
      <div style="margin-top:6px">${rules}</div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Envios de fatura</h2><span class="sub">os mais recentes</span></div>
      <p class="help">Mandou um arquivo errado? Desfaça o envio inteiro aqui. Só as compras daquele envio saem.</p>
      ${batches().slice(0, 8).map(b => `<div class="lrow"><span class="ic" style="background:${safeColor(sourceColor(b.source))}22;color:${safeColor(sourceColor(b.source))}">${icon('up', 16)}</span>
        <span class="m"><b>${esc(sourceName(b.source))} · ${b.ids.length} ${b.ids.length === 1 ? 'compra' : 'compras'}</b><small>${atLabel(b.at)} · ${L.ddmm(b.lo)} a ${L.ddmm(b.hi)} · ${money(b.total)}</small></span>
        <span class="r"><button class="btn small danger" data-act="batch-undo" data-k="${esc(b.key)}">Desfazer</button></span></div>`).join('') || '<p class="help">Nenhum envio ainda.</p>'}
    </section>
    <section class="card">
      <div class="card-head"><h2>Aparência</h2></div>
      <div class="seg" role="group" aria-label="Tema" style="max-width:360px">
        ${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([v, l]) => `<button data-act="theme" data-t="${v}" aria-pressed="${theme === v}">${l}</button>`).join('')}
      </div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Seus dados</h2></div>
      <p class="help">Baixe tudo (gastos, entradas, contas, reservas, regras e ajustes) num arquivo. Serve de backup.</p>
      <div class="actions"><button class="btn" data-act="export">Exportar tudo</button><button class="btn danger" data-act="logout">Sair</button></div>
    </section>`;
}

// ----- Entradas -----
// de qual folha é cada entrada fixa (o salário que cai em dezembro é o restante da folha de novembro)
function incomeRef(it, ym) {
  if (!it.key) return 'avulsa';
  const r = (state.settings.incomeRules || []).find(x => x.key === it.key);
  const M = mName(ym);
  if (r && Number(r.monthOffset) === 1) return `restante da folha de ${M}`;
  if (r && /vintena|adiant/i.test(r.name)) return `adiantamento da folha de ${M}`;
  return `referente a ${M}`;
}

function viewEntradas() {
  if (!state.draft) startDraft();
  const ym = state.incomeMonth || L.monthOfCycle(curCycle());
  const inc = L.monthIncomes(state.settings, state.incomes, ym);
  const received = inc.items.filter(i => i.received).reduce((a, i) => a + i.amount, 0);
  const M = mName(ym).replace(/^./, c => c.toUpperCase()) + (ym.slice(0, 4) === today().slice(0, 4) ? '' : ` de ${ym.slice(0, 4)}`);
  const cyc = cycleForMonth(ym);
  const inv = L.invoiceName(cyc, card(), today()).toLowerCase();

  const rows = inc.items.map(it => `<div class="lrow">
      <span class="ic ${it.received ? 'ok' : ''}" style="flex-direction:column;gap:0;line-height:1.05"><b style="font-size:13px">${L.ddmm(it.date).slice(0, 2)}</b><small style="font-size:10px;font-weight:600">${L.MONTHS_SHORT[+it.date.slice(5, 7) - 1]}</small></span>
      <span class="m"><b>${esc(it.name)}</b><small class="${it.received ? 'g' : ''}">${esc(incomeRef(it, ym))} · ${it.received ? 'recebida' : it.extra ? 'avulsa' : esc(it.why || '')}</small></span>
      <span class="r"><b>${money(it.amount)}</b>${it.received
        ? `<button class="pill ghost" data-act="income-undo" data-id="${it.id}">${it.extra ? 'Apagar' : 'Desfazer'}</button>`
        : `<button class="pill" data-act="income-confirm" data-key="${esc(it.key)}" data-ym="${it.target}">Confirmar</button>`}</span>
    </div>`).join('');

  const d = state.draft;
  const ruleForms = (d.incomeRules || []).map((r, i) => `<div class="card" style="background:var(--raise);padding:14px;margin-top:10px">
      <div class="edit-row" style="grid-template-columns:minmax(0,1fr) 120px 34px;margin-top:0">
        <input class="input" data-bind="incomeRules.${i}.name" value="${esc(r.name)}" aria-label="Nome da entrada">
        <input class="input" data-bind="incomeRules.${i}.amount" data-type="money" inputmode="decimal" value="${fmtIn(r.amount)}" aria-label="Valor esperado" placeholder="valor">
        <button class="icon-btn sm" data-act="del" data-path="incomeRules" data-i="${i}" aria-label="Remover entrada fixa">×</button>
      </div>
      <div class="edit-row" style="grid-template-columns:minmax(0,1fr) 80px">
        <select class="input" data-bind="incomeRules.${i}.type" aria-label="Quando cai">
          <option value="businessDay" ${r.type === 'businessDay' ? 'selected' : ''}>Dia útil do mês (nº)</option>
          <option value="day" ${r.type === 'day' ? 'selected' : ''}>Dia fixo do mês</option>
        </select>
        <input class="input" data-bind="incomeRules.${i}.${r.type === 'businessDay' ? 'n' : 'day'}" data-type="int" inputmode="numeric" value="${r.type === 'businessDay' ? (r.n ?? 5) : (r.day ?? 20)}" aria-label="${r.type === 'businessDay' ? 'Qual dia útil' : 'Dia do mês'}">
      </div>
      ${r.type === 'day' ? `<label class="check" style="margin-top:10px"><input type="checkbox" data-bind="incomeRules.${i}.shift" data-type="shift" ${r.shift !== 'after' ? 'checked' : ''}> Se cair em fim de semana ou feriado, vem antes</label>` : ''}
      <label class="check" style="margin-top:10px"><input type="checkbox" data-bind="incomeRules.${i}.monthOffset" data-type="offset" ${Number(r.monthOffset) === 1 ? 'checked' : ''}> Cai no mês seguinte ao da folha (ex.: o salário de novembro cai no 5º dia útil de dezembro)</label>
    </div>`).join('');

  return `${pageHead('Entradas', 'salário, vintena e recebimentos avulsos', headActions({ upload: false }))}
    <div class="cycle">
      <button class="icon-btn sm" data-act="inc-month" data-d="-1" aria-label="Mês anterior">‹</button>
      <div class="lbl"><b>Folha de ${mName(ym)}</b><span>paga o mês de ${mName(ym)} e a ${esc(inv)}</span></div>
      <button class="icon-btn sm" data-act="inc-month" data-d="1" aria-label="Próximo mês">›</button>
    </div>
    <section class="card">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px">
        <div style="display:flex;flex-direction:column;gap:4px"><span class="k">Previsto para ${M}</span><span class="big md">${money(inc.total)}</span></div>
        <span class="small muted">Recebido até agora <b style="color:var(--text)">${money(received)}</b></span>
      </div>
      <div style="margin-top:10px">${rows || '<p class="help">Nenhuma entrada fixa configurada. Adicione abaixo.</p>'}</div>
      <div class="actions"><button class="btn soft small" data-act="inc-add" data-ym="${ym}">+ Recebimento avulso (13º, freela…)</button></div>
    </section>
    <section class="card">
      <div class="card-head"><h2>Entradas fixas</h2></div>
      <p class="help">O valor é o esperado. Ao confirmar, você ajusta o que caiu de fato.</p>
      ${ruleForms}
      <button class="row add" data-act="add" data-path="incomeRules">Adicionar entrada fixa</button>
      <div class="actions"><button class="btn primary" data-act="save-draft">Salvar entradas fixas</button></div>
    </section>`;
}

document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('avail')) state.availOpen = e.target.open; }, true);

// Parcelas em quadradinhos: pagas, a deste mês e as que faltam, com quanto ainda falta pagar
function parcelViz(total, cur, value, endYM) {
  const left = total - cur + 1;                       // inclui a deste mês
  const cells = Array.from({ length: total }, (_, i) => `<i class="${i < cur - 1 ? 'paid' : i === cur - 1 ? 'cur' : ''}"></i>`).join('');
  return `<div class="pviz">
    <div class="pstats">
      <div><small>Parcela</small><b>${cur} de ${total}</b></div>
      <div><small>Faltam</small><b>${left} ${left === 1 ? 'parcela' : 'parcelas'}</b></div>
      <div><small>Ainda a pagar</small><b class="neg">${money(value * left)}</b></div>
      <div><small>Já pago</small><b>${money(value * (cur - 1))}</b></div>
    </div>
    <div class="pgrid ${total > 36 ? 'dense' : ''}" aria-label="${cur - 1} parcelas pagas, ${left} a pagar">${cells}</div>
    <div class="plegend"><span><i class="paid"></i>pagas</span><span><i class="cur"></i>deste mês</span><span><i></i>a pagar</span>${endYM ? `<span class="end">termina em ${L.MONTHS_SHORT[+endYM.slice(5, 7) - 1]}/${endYM.slice(0, 4)}</span>` : ''}</div>
  </div>`;
}

// ---------------- eventos ----------------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('.sheet-bg')) return;
  const act = el.dataset.act;
  const closing = card().closing || 1;
  switch (act) {
    case 'retry': return enter(state.user);
    case 'view': if (el.dataset.v === state.view) { window.scrollTo(0, 0); return; } return go(el.dataset.v);
    case 'back': return goBack();
    case 'batch-undo': return undoBatchSheet(el.dataset.k);
    case 'batch-dismiss': state.lastBatch = null; return render();
    case 'upload': return pickFile();
    case 'lancar': return lancarSheet(el.dataset.mode || 'gasto');
    case 'prev': state.cycle = L.shiftCycle(state.cycle.start, -1, closing); return render();
    case 'next': if (state.cycle.start < curCycle().start) { state.cycle = L.shiftCycle(state.cycle.start, 1, closing); render(); } return;
    case 'classify': return go('gastos', { filter: 'unc', cycle: curCycle() });
    case 'priv':
      state.priv = !state.priv;
      try { localStorage.setItem('mf-priv', state.priv ? '1' : '0'); } catch (e2) {}
      { const y = window.scrollY; render(); window.scrollTo(0, y); } return;
    case 'menu': return menuSheet();
    case 'card-hide': case 'card-show': {
      const next = structuredClone(state.settings);
      const set = new Set(next.hiddenCards || []);
      if (act === 'card-hide') set.add(el.dataset.id); else set.delete(el.dataset.id);
      next.hiddenCards = [...set];
      if (await saveSettings(next)) { const y = window.scrollY; render(); window.scrollTo(0, y); }
      return;
    }
    case 'card-open': return go('gastos', { filter: 'src:' + el.dataset.id, cycle: curCycle() });
    case 'pc-amt': state.pc.amt = Number(el.dataset.v); return refreshPC();
    case 'pc-cat': state.pc.cat = el.dataset.v; return refreshPC();
    case 'home-card': state.homeCard = el.dataset.v; { const y = window.scrollY; render(); window.scrollTo(0, y); } return;
    case 'home-tab': state.homeTab = el.dataset.v; { const y = window.scrollY; render(); window.scrollTo(0, y); } return;
    case 'balance': return balanceSheet();
    case 'agenda-all': state.agendaAll = !state.agendaAll; { const y = window.scrollY; render(); window.scrollTo(0, y); } return;
    case 'week-dismiss': try { localStorage.setItem('mf-wk-' + el.dataset.w, '1'); } catch (e) {} { const y = window.scrollY; render(); window.scrollTo(0, y); } return;
    case 'contas-kind': state.contasKind = el.dataset.v; { const y = window.scrollY; render(); window.scrollTo(0, y); } return;
    case 'contas-month': state.contasMonth = L.ymAdd(state.contasMonth || L.monthOfCycle(curCycle()), Number(el.dataset.d)); return render();
    case 'bill-new': return billSheet(null, el.dataset.ym || state.month || defaultMonth(), el.dataset.kind || 'exact');
    case 'bill-edit': return billSheet(Number(el.dataset.i), state.month || defaultMonth());
    case 'inc-rules': state.incomeMonth = el.dataset.ym; return go('entradas');
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
      state.incomeMonth = L.ymAdd(state.incomeMonth || L.monthOfCycle(curCycle()), Number(el.dataset.d)); return render();
    }
    case 'income-confirm': return confirmIncomeSheet(el.dataset.key, el.dataset.ym);
    case 'income-undo': return undoIncome(Number(el.dataset.id));
    case 'account': return accountSheet(state.accounts.find(a => a.id === Number(el.dataset.id)));
    case 'account-new': return accountSheet(null, el.dataset.kind);
    case 'aporte': return aporteSheet();
    case 'saldos': return saldosSheet();
    case 'month': {
      const base = (state.month || defaultMonth()) + '-01';
      state.month = L.addMonths(base, Number(el.dataset.d)).slice(0, 7); return render();
    }
    case 'inc-add': return lancarSheet('entrada', dateInMonth(el.dataset.ym));
    case 'inc-edit': return incomeEditSheet(el.dataset.ym || L.monthOfCycle(state.cycle));
    case 'fix-edit': return go('mes');
    case 'cat-open': return go('gastos', { filter: 'cat:' + el.dataset.c, cycle: state.view === 'home' ? curCycle() : null });
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
  const f = L.billsFor(state.settings, ym, state.txs, state.rules).find(b => b.index === i);
  if (!f) return;
  const src = ['pix', 'debito', 'dinheiro'].includes(f.pay) ? f.pay : 'pix';
  const row = { user_id: state.user.id, uid: `fixed|${i}|${ym}|${Date.now().toString(36)}`, date: dateInMonth(ym), title: f.name,
    amount: Number(f.value) || 0, source: src, category: f.category || null, manual: true };
  const { error } = await sb.from('transactions').insert(row);
  if (error) return toast('Não salvou: ' + error.message);
  await loadTxs(); render(); toast(`${f.name} marcada como paga (${money(row.amount)}). Toque nela para mudar o valor ou desfazer.`);
}

// edição dos ajustes: cada campo escreve direto no rascunho
document.addEventListener('input', e => {
  if (e.target.id === 'gq') { state.q = e.target.value; const box = document.getElementById('txlist'); if (box) box.innerHTML = gastosList(summary(state.cycle)); return; }
  if (e.target.id === 'pc-in') {
    const v = num(e.target.value);
    if (!(v > 0)) return;
    state.pc.amt = v;
    const pos = e.target.selectionStart;
    refreshPC();
    const inp = document.getElementById('pc-in');
    if (inp) { inp.focus(); try { inp.setSelectionRange(pos, pos); } catch (e2) {} }
    return;
  }
  bindInput(e.target);
});
document.addEventListener('change', e => {
  const kwId = e.target.dataset && (e.target.dataset.ruleKw || e.target.dataset.ruleCat);
  if (kwId) return updateRule(Number(kwId), e.target.dataset.ruleKw ? { keyword: L.normalize(e.target.value) } : { category: e.target.value });
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
  d.categories = d.categories.filter(c => c.name.trim());
  for (const c of d.cards) {
    if (c.closing) c.closing = Math.min(28, Math.max(1, c.closing));
    if (c.due) c.due = Math.min(31, Math.max(1, c.due));
    c.last4 = String(c.last4 || '').replace(/\D/g, '').slice(-4);
    c.color = safeColor(c.color);
    c.name = String(c.name || '').trim().slice(0, 30) || 'Cartão';
  }
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

async function updateRule(id, patch) {
  if (patch.keyword === '') return toast('A palavra não pode ficar vazia.');
  const { error } = await sb.from('rules').update(patch).eq('id', id);
  if (error) return toast('Não salvou: ' + error.message);
  const r = state.rules.find(x => x.id === id);
  if (r) Object.assign(r, patch);
  toast('Regra atualizada.');
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
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div><button type="button" class="sheet-x" data-close aria-label="Fechar">${icon('x', 18, 2.2)}</button>${html}</div>`;
  document.body.appendChild(bg);
  document.body.classList.add('noscroll');
  const prevFocus = document.activeElement;
  const close = () => {
    const i = sheets.indexOf(close); if (i >= 0) sheets.splice(i, 1);
    bg.remove(); document.removeEventListener('keydown', onKey);
    if (!sheets.length) document.body.classList.remove('noscroll');
    prevFocus && prevFocus.focus && prevFocus.focus();
  };
  sheets.push(close);
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
  const sh = bg.querySelector('.sheet');
  sh.$ = sel => sh.querySelector(sel);
  sh.$$ = sel => [...sh.querySelectorAll(sel)];
  onMount && onMount(sh, close);
  (sh.querySelector('[autofocus]') || sh.querySelector('input, select, button:not(.sheet-x)'))?.focus();
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
  input.type = 'file'; input.accept = '.csv,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    if (f.size > 15e6) return toast('Arquivo grande demais para uma fatura.');
    let text;
    try {
      if (/\.xlsx$/i.test(f.name)) { const X = await import('./xlsx.js?v=20261117n'); text = await X.xlsxToCSV(await f.arrayBuffer()); }
      else if (/\.xls$/i.test(f.name)) return toast('Arquivo .xls antigo: abra no Excel e salve como .xlsx ou CSV.');
      else text = await f.text();
    } catch (err) { return toast('Não consegui ler o arquivo: ' + (err.message || err)); }
    const parsed = L.parseInvoiceCSV(text);
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
    <div class="wrapchips">${cards.map(c => `<button class="chip" data-card="${esc(c.id)}" aria-pressed="${c.id === chosen}"><span class="dot" style="background:${safeColor(c.color)}"></span>${esc(c.name)}</button>`).join('')}</div>
    <p class="help small" style="margin:8px 0 0">${parsed.bank ? 'Reconhecido pelo formato do arquivo. Confira antes de adicionar.' : 'Não reconheci o banco pelo formato. Escolha o cartão.'}</p>
    <div class="sumbox" data-sum></div>
    <div class="actions"><button class="btn primary grow" data-go disabled>Escolha o cartão</button><button class="btn ghost" data-close>Cancelar</button></div>`;

  openSheet(html, (sh, close) => {
    let fresh = [], toAdd = [], forceSuspects = false, pairs = [];
    const update = () => {
      if (!chosen) { sh.$('[data-sum]').innerHTML = `<div><span>Compras na fatura</span><b>${parsed.rows.length}</b></div>`; return; }
      const rows = L.fingerprint(parsed.rows, chosen);
      fresh = rows.filter(r => !known.has(r.uid));
      const { suspects, otherSource } = L.findSuspects(rows, fresh, state.txs, chosen);
      toAdd = forceSuspects ? fresh : fresh.filter(r => !suspects.has(r.uid));
      pairs = L.matchManual(toAdd, state.txs, chosen);
      const unc = toAdd.filter(r => !L.matchRule(r.title, state.rules)).length;
      const wrongCard = otherSource && otherSource.count >= Math.max(3, rows.length * 0.5);
      sh.$('[data-sum]').innerHTML = `<div><span>Compras novas</span><b>${toAdd.length}</b></div>
        <div><span>Já estavam no app</span><span>${rows.length - fresh.length}</span></div>
        ${suspects.size ? `<div><span>Parecem repetidas (descrição ou valor mudou)</span><span>${suspects.size}</span></div>` : ''}
        ${pairs.length ? `<div><span>Lançadas à mão que a fatura confirmou (a da fatura substitui a sua)</span><span>${pairs.length}</span></div>` : ''}
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
      const keepCat = new Map(pairs.filter(p => p.manual.category).map(p => [p.row.uid, p.manual.category]));
      for (let i = 0; i < fresh.length; i += 500) {
        const chunk = fresh.slice(i, i + 500).map(r => ({ ...r, user_id: state.user.id, manual: false, ...(keepCat.has(r.uid) && !r.category ? { category: keepCat.get(r.uid) } : {}) }));
        const { error } = await sb.from('transactions').upsert(chunk, { onConflict: 'user_id,uid', ignoreDuplicates: true });
        if (error) { toast('Não enviou: ' + error.message); go.disabled = false; update(); return; }
      }
      // os lançamentos à mão que a fatura confirmou saem (a linha da fatura já entrou no lugar)
      const manualIds = pairs.map(p => p.manual.id).filter(Boolean);
      if (manualIds.length) {
        const { error } = await sb.from('transactions').delete().in('id', manualIds).eq('manual', true);
        if (error) toast('As compras entraram, mas não consegui tirar os lançamentos à mão repetidos: ' + error.message);
      }
      await loadTxs();
      const latest = fresh.reduce((m, r) => (r.date > m ? r.date : m), fresh[0].date);
      state.cycle = L.cycleFor(latest, card().closing || 1);
      const mine = new Set(fresh.map(r => r.uid));
      const b = batches().find(x => x.ids.some(id => mine.has((state.txs.find(t => t.id === id) || {}).uid)));
      state.lastBatch = b ? b.key : null;
      close();
      if (state.view !== 'home') go('home'); else render();
      toast(`${fresh.length} ${fresh.length === 1 ? 'compra adicionada' : 'compras adicionadas'}${manualIds.length ? ` · ${manualIds.length} ${manualIds.length === 1 ? 'lançamento à mão substituído' : 'lançamentos à mão substituídos'}` : ''}.`);
    });
    update();
  });
}

// ----- Lançar gasto ou entrada -----
function lancarSheet(mode, dateDefault) {
  const srcs = [...state.settings.cards.map(c => ({ id: c.id, name: c.name, color: c.color })), ...L.METHODS];
  const rules = state.settings.incomeRules || [];
  // abre com o último jeito de pagar usado e com as 4 rubricas que você mais usa
  let src0 = null; try { src0 = localStorage.getItem('mf-last-src'); } catch (e) {}
  if (!srcs.some(x => x.id === src0)) src0 = card().id;
  const since = L.addDays(today(), -90), freq = {};
  for (const t of state.txs) if (t.date >= since) { const c = L.categoryOf(t, state.rules); freq[c] = (freq[c] || 0) + 1; }
  const ordered = [...catNames()].sort((a, b) => (freq[b] || 0) - (freq[a] || 0));
  const topCats = ordered.slice(0, 4), restCats = ordered.slice(4);
  const html = `<div class="head"><h2>Lançar</h2>
      <div class="seg" role="group" aria-label="Tipo de lançamento"><button data-mode="gasto" aria-pressed="${mode === 'gasto'}">Gasto</button><button data-mode="entrada" aria-pressed="${mode === 'entrada'}">Entrada</button></div></div>
    <div class="field"><label for="lv">Valor</label><div class="money"><span>R$</span><input id="lv" inputmode="decimal" placeholder="0,00" autofocus></div></div>
    <div data-g>
      <div class="lbl" style="margin-top:14px">Rubrica</div>
      <div class="wrapchips">${topCats.map(c => `<button class="chip" data-cat="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join('')}${restCats.length ? `<button class="chip dashed" data-more aria-expanded="false">Outras ›</button>` : ''}
        ${restCats.map(c => `<button class="chip" data-cat="${esc(c)}" aria-pressed="false" data-rest hidden>${esc(c)}</button>`).join('')}</div>
      <div class="lbl" style="margin-top:14px">Como pagou</div>
      <div class="wrapchips">${srcs.map(s => `<button class="chip" data-src="${esc(s.id)}" aria-pressed="${s.id === src0}"><span class="dot" style="background:${safeColor(s.color)}"></span>${esc(s.name)}</button>`).join('')}</div>
    </div>
    <div class="field"><label for="ld">Descrição <span class="muted" data-g style="font-weight:400">(opcional)</span></label><input class="input" id="ld" placeholder="${mode === 'entrada' ? 'ex.: 13º salário, freela, reembolso' : 'ex.: almoço, Renner'}"></div>
    <div data-e hidden>
      <div class="lbl" style="margin-top:14px">É uma entrada fixa?</div>
      <div class="wrapchips"><button class="chip" data-rk="" aria-pressed="true">Avulsa</button>${rules.map(r => `<button class="chip" data-rk="${esc(r.key)}" aria-pressed="false">${esc(r.name)}</button>`).join('')}</div>
    </div>
    <details class="more" ${dateDefault && dateDefault !== today() ? 'open' : ''}><summary>Data e parcelas <span class="muted">· ${dateDefault && dateDefault !== today() ? L.ddmm(dateDefault) : 'hoje'}, à vista</span></summary>
    <div class="grid2">
      <div class="field"><label for="ldt">Data</label><input class="input" id="ldt" type="date" value="${dateDefault || today()}"></div>
      <div class="field" data-g><label for="lp">Parcelas</label><input class="input" id="lp" type="number" min="1" max="24" value="1"></div>
    </div></details>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Lançar gasto</button><button class="btn ghost" data-close>Cancelar</button></div>`;

  openSheet(html, (sh, close) => {
    let src = src0, cat = null, rk = '';
    sh.$('[data-more]')?.addEventListener('click', e => { const b = e.currentTarget; b.hidden = true; sh.$$('[data-rest]').forEach(x => (x.hidden = false)); });
    const setMode = m => {
      mode = m;
      sh.$$('[data-g]').forEach(x => (x.hidden = m !== 'gasto'));
      sh.$('#ld').placeholder = m === 'entrada' ? 'ex.: 13º salário, freela, reembolso' : 'ex.: almoço, Renner';
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
      const title = sh.$('#ld').value.trim() || (mode === 'gasto' ? (cat || 'Gasto') : '');
      const date = sh.$('#ldt').value || today();
      if (!(amount > 0)) { err.textContent = 'Informe um valor maior que zero.'; return; }
      if (mode === 'gasto') {
        if (!cat && !sh.$('#ld').value.trim()) { err.textContent = 'Escolha a rubrica ou escreva uma descrição.'; return; }
        try { localStorage.setItem('mf-last-src', src); } catch (e) {}
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
    ${(() => {
      const a = averages(); const avgC = a.cycles.length ? (a.avg[current] || 0) : 0;
      const isOne = (state.settings.oneOff || []).includes(t.uid);
      const looks = !isOne && t.amount >= 300 && (avgC === 0 || t.amount > avgC * 2);
      return `<div class="oneoff ${isOne ? 'on' : ''}"><span><b>${isOne ? 'Compra pontual' : 'É uma compra pontual?'}</b><small>${isOne ? 'Conta no gasto do mês, mas fica fora do ritmo e da sua média.' : looks ? `Parece fora do normal${avgC ? ` (média de ${esc(current)}: ${money(avgC)} por ciclo)` : ''}. Marcar evita que o app projete ela de novo.` : 'Marque compras que não se repetem (presente, viagem, conserto).'}</small></span><button class="btn small ${isOne ? '' : looks ? 'primary' : ''}" data-oneoff>${isOne ? 'Desmarcar' : 'Marcar pontual'}</button></div>`;
    })()}
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
    sh.$('[data-oneoff]').addEventListener('click', async () => {
      const next = structuredClone(state.settings);
      const set = new Set(next.oneOff || []);
      if (set.has(t.uid)) set.delete(t.uid); else set.add(t.uid);
      next.oneOff = [...set];
      if (await saveSettings(next)) { close(); render(); toast(set.has(t.uid) ? 'Marcada como pontual.' : 'Voltou a contar no ritmo.'); }
    });
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
    sh.$('[data-more]').addEventListener('click', () => { close(); state.incomeMonth = ym; go('entradas'); });
    sh.$$('[data-del]').forEach(b => b.addEventListener('click', async () => { await undoIncome(Number(b.dataset.del)); close(); incomeEditSheet(ym); }));
    sh.$('[data-save]').addEventListener('click', async () => {
      const next = structuredClone(state.settings);
      sh.$$('input[data-i]').forEach(inp => { next.incomeRules[Number(inp.dataset.i)].amount = num(inp.value); });
      if (await saveSettings(next)) { close(); render(); toast('Entradas salvas.'); }
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

// ----- Menu (celular) -----
function menuSheet() {
  const theme = document.documentElement.dataset.theme || 'auto';
  const html = `<h2>Mais</h2>
    <button class="row" data-go="reservas"><span>Reservas</span><span class="end">›</span></button>
    <button class="row" data-go="ajustes"><span>Ajustes e regras</span><span class="end">›</span></button>
    <div class="lbl" style="margin-top:16px">Tema</div>
    <div class="seg" role="group" aria-label="Tema" style="margin-top:8px">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([v, l]) => `<button data-th="${v}" aria-pressed="${theme === v}">${l}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost grow" data-close>Fechar</button></div>`;
  openSheet(html, (sh, close) => {
    sh.$$('[data-go]').forEach(b => b.addEventListener('click', () => {
      close(); go(b.dataset.go);
    }));
    sh.$$('[data-th]').forEach(b => b.addEventListener('click', () => { close(); setTheme(b.dataset.th); }));
  });
}

// ----- Saldo na conta -----
function balanceSheet() {
  const b = state.settings.balance;
  const html = `<h2>Saldo na conta</h2>
    <div class="meta">O saldo de hoje da conta onde caem salário e vintena. A agenda usa esse número como ponto de partida.</div>
    <div class="field"><label for="bv">Saldo agora</label><div class="money"><span>R$</span><input id="bv" inputmode="decimal" value="${b ? fmtIn(b.value) || '0,00' : ''}" placeholder="0,00" autofocus></div></div>
    <p class="help small">Use o valor negativo (com o sinal de menos) se a conta estiver no vermelho.</p>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Salvar</button><button class="btn ghost" data-close>Cancelar</button></div>`;
  openSheet(html, (sh, close) => {
    sh.$('[data-save]').addEventListener('click', async () => {
      const raw = sh.$('#bv').value.trim();
      if (!raw) { sh.$('[data-err]').textContent = 'Informe o saldo.'; return; }
      const v = num(raw.replace(/^[−-]/, '')) * (/^[−-]/.test(raw) ? -1 : 1);
      const next = structuredClone(state.settings);
      next.balance = { value: Math.round(v * 100) / 100, date: today() };
      if (await saveSettings(next)) { close(); render(); toast('Saldo atualizado.'); }
    });
  });
}

// ----- Nova conta / editar conta -----
function billSheet(index, ym, kindDefault = 'exact') {
  const st = state.settings;
  const b = index != null ? st.fixed[index] : null;
  let kind = b ? b.kind : kindDefault;
  const par = b && b.parcels ? L.billParcel(b, ym) : null;
  const pays = [['pix', 'Pix'], ['boleto', 'Boleto'], ['debito', 'Débito automático'], ['dinheiro', 'Dinheiro'], ...st.cards.map(c => [c.id, 'Cartão ' + c.name])];
  const cats = st.categories.map(c => c.name);
  const full = b ? L.billsFor(st, ym, state.txs, state.rules).find(x => x.index === index) : null;
  let viz = '';
  if (b && par && par.active) viz = parcelViz(par.total, par.n, Number(full ? full.value : b.value), par.endYM);
  else if (b && b.kind === 'estimate' && full && (full.history || []).length) {
    const h = full.history, mx = Math.max(1, ...h.map(x => x.value));
    viz = `<div class="pviz"><div class="pstats"><div><small>Previsão de ${mName(ym)}</small><b>${money(full.value)}</b></div><div><small>${b.basis === 'max' ? 'Maior' : 'Média'} de</small><b>${h.length} ${h.length === 1 ? 'mês' : 'meses'}</b></div></div>
      <div class="hist">${h.map(x => `<span><i style="height:${Math.round(12 + x.value / mx * 50)}px"></i><small>${money(x.value).replace('R$ ', '').replace(/,\d\d$/, '')}</small></span>`).join('')}</div></div>`;
  } else if (b && !b.parcels) viz = `<div class="pviz"><div class="pstats"><div><small>Todo mês</small><b>${money(b.value)}</b></div><div><small>Em 12 meses</small><b>${money(b.value * 12)}</b></div></div></div>`;
  const html = `<div class="head"><h2>${b ? esc(b.name) : 'Nova conta'}</h2></div>
    ${viz}
    ${b ? '<div class="lbl" style="margin-top:16px">Editar</div>' : ''}
    <div class="seg" role="group" aria-label="Tipo" style="margin-top:12px"><button data-kind="exact" aria-pressed="${kind === 'exact'}">Valor exato</button><button data-kind="estimate" aria-pressed="${kind === 'estimate'}">Valor estimado</button></div>
    <div class="field"><label for="bn">Nome</label><input class="input" id="bn" maxlength="60" value="${esc(b ? b.name : '')}" placeholder="ex.: Mestrado, Aluguel, Luz"></div>
    <div class="grid2">
      <div class="field"><label for="bvl" data-vlabel>${kind === 'exact' ? 'Valor (da parcela)' : 'Valor inicial'}</label><input class="input" id="bvl" inputmode="decimal" value="${b ? fmtIn(b.value) : ''}" placeholder="0,00"></div>
      <div class="field"><label for="bd">Vence no dia</label><input class="input" id="bd" inputmode="numeric" maxlength="2" value="${b && b.day ? b.day : ''}" placeholder="ex.: 20"></div>
      <div class="field"><label for="bc">Rubrica</label><select class="input" id="bc">${cats.map(c => `<option ${(b ? b.category : 'Casa') === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
      <div class="field"><label for="bp">Como paga</label><select class="input" id="bp">${pays.map(([v, l]) => `<option value="${esc(v)}" ${(b ? b.pay : 'pix') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
    </div>
    <p class="help small" data-cardhint hidden>Paga no cartão: ela já vem na fatura. Aqui ela serve para você ver o mês antes de começar e não conta duas vezes.</p>
    <div class="card" style="background:var(--raise);margin-top:14px;padding:14px" data-exact>
      <label class="check"><input type="checkbox" id="bhp" ${b && b.parcels ? 'checked' : ''}> Tem número de parcelas</label>
      <div data-parc ${b && b.parcels ? '' : 'hidden'}>
        <div class="grid2">
          <div class="field"><label for="bt">Total de parcelas</label><input class="input" id="bt" inputmode="numeric" maxlength="3" value="${b && b.parcels ? b.parcels.total : ''}" placeholder="ex.: 24"></div>
          <div class="field"><label for="bk">Parcela de ${mName(ym)}</label><input class="input" id="bk" inputmode="numeric" maxlength="3" value="${par ? par.n : ''}" placeholder="ex.: 6"></div>
        </div>
        <p class="small" data-preview style="margin:10px 0 0;color:var(--text-2)"></p>
      </div>
      <p class="help small" data-noparc ${b && b.parcels ? 'hidden' : ''} style="margin:8px 0 0">Repete todo mês, sem data para acabar (ex.: plano de celular).</p>
    </div>
    <div class="card" style="background:var(--raise);margin-top:14px;padding:14px" data-est hidden>
      <div class="field" style="margin-top:0"><label for="bm">Palavra que aparece no pagamento (opcional)</label><input class="input" id="bm" maxlength="40" value="${esc(b ? b.match || '' : '')}" placeholder="ex.: rge, para achar a luz na fatura"></div>
      <div class="lbl" style="margin-top:12px">Como prever</div>
      <div class="seg" role="group" aria-label="Como prever" style="margin-top:8px"><button data-basis="avg" aria-pressed="${!b || b.basis !== 'max'}">Média de 3 meses</button><button data-basis="max" aria-pressed="${b && b.basis === 'max'}">Maior valor</button></div>
      <p class="help small" style="margin:8px 0 0">O app procura os pagamentos com esse nome nos últimos meses e atualiza a previsão sozinho. Sem histórico, usa o valor inicial.</p>
    </div>
    <div class="err" data-err></div>
    <div class="actions"><button class="btn primary grow" data-save>Salvar conta</button><button class="btn ghost" data-close>Cancelar</button></div>
    ${b ? '<div class="actions" style="margin-top:8px"><button class="btn small danger" data-delete>Apagar conta</button></div>' : ''}`;
  openSheet(html, (sh, close) => {
    let basis = b && b.basis === 'max' ? 'max' : 'avg';
    const sync = () => {
      sh.$('[data-exact]').hidden = kind !== 'exact';
      sh.$('[data-est]').hidden = kind !== 'estimate';
      sh.$('[data-vlabel]').textContent = kind === 'exact' ? 'Valor (da parcela)' : 'Valor inicial';
      sh.$('[data-cardhint]').hidden = !st.cards.some(c => c.id === sh.$('#bp').value);
      const on = sh.$('#bhp').checked;
      sh.$('[data-parc]').hidden = !on; sh.$('[data-noparc]').hidden = on;
      const t = parseInt(sh.$('#bt').value, 10), k = parseInt(sh.$('#bk').value, 10), v = num(sh.$('#bvl').value);
      const pv = sh.$('[data-preview]');
      if (on && t > 0 && k > 0 && k <= t) {
        const end = L.ymAdd(ym, t - k);
        pv.innerHTML = `Termina em <b>${L.MONTHS_SHORT[+end.slice(5, 7) - 1]}/${end.slice(0, 4)}</b> · faltam ${t - k + 1} parcelas (com a de ${mName(ym)})${v > 0 ? ` · <b>${money(v * (t - k + 1))}</b> ainda a pagar` : ''}`;
      } else pv.textContent = on ? 'Informe o total e a parcela deste mês.' : '';
    };
    pickChips(sh, 'kind', v => { kind = v; sync(); });
    pickChips(sh, 'basis', v => (basis = v));
    ['#bhp', '#bt', '#bk', '#bvl', '#bp'].forEach(q => { sh.$(q).addEventListener('input', sync); sh.$(q).addEventListener('change', sync); });
    sync();
    const err = sh.$('[data-err]');
    sh.$('[data-delete]')?.addEventListener('click', async () => {
      const next = structuredClone(st);
      next.fixed.splice(index, 1);
      if (await saveSettings(next)) { close(); render(); toast('Conta apagada.'); }
    });
    sh.$('[data-save]').addEventListener('click', async () => {
      const name = sh.$('#bn').value.trim();
      const value = num(sh.$('#bvl').value);
      const day = parseInt(sh.$('#bd').value, 10);
      if (!name) { err.textContent = 'Dê um nome à conta.'; return; }
      if (!(value > 0)) { err.textContent = kind === 'exact' ? 'Informe o valor.' : 'Informe um valor inicial (o app ajusta pela média depois).'; return; }
      if (sh.$('#bd').value && !(day >= 1 && day <= 31)) { err.textContent = 'O dia precisa ser entre 1 e 31.'; return; }
      let parcels = null;
      if (kind === 'exact' && sh.$('#bhp').checked) {
        const t = parseInt(sh.$('#bt').value, 10), k = parseInt(sh.$('#bk').value, 10);
        if (!(t > 1 && t <= 480 && k >= 1 && k <= t)) { err.textContent = 'Confira o total de parcelas e a parcela deste mês.'; return; }
        parcels = { total: t, current: k, ym };
      }
      const item = {
        id: b ? b.id : 'c' + Date.now().toString(36), name, kind, value, day: day || null,
        category: sh.$('#bc').value, pay: sh.$('#bp').value,
        match: kind === 'estimate' ? L.normalize(sh.$('#bm').value).slice(0, 40) : '', basis, parcels,
      };
      const next = structuredClone(st);
      if (b) next.fixed[index] = item; else next.fixed.push(item);
      if (await saveSettings(next)) { close(); state.contasKind = kind; render(); toast(b ? 'Conta salva.' : 'Conta adicionada.'); }
    });
  });
}

// ---------------- login ----------------
function renderLogin(msg = '') {
  $app.innerHTML = `<div class="center"><form class="login" id="login">
    <span class="brand"><span class="logo">${icon('bars', 18, 2.2)}</span>MyFinance</span>
    <p>Entre para ver suas faturas.</p>
    <div class="field"><label for="email">E-mail</label><input class="input" id="email" type="email" autocomplete="email" required></div>
    <div class="field"><label for="pass">Senha</label><input class="input" id="pass" type="password" autocomplete="current-password" required></div>
    <div class="err" id="lerr" role="alert"></div>
    <p class="help small" id="lok" role="status"></p>
    <div class="actions"><button class="btn primary grow" type="submit">Entrar</button></div>
    <div class="actions" style="margin-top:8px"><button class="btn ghost small" type="button" id="forgot">Esqueci a senha</button></div>
  </form></div>`;
  const $err = document.getElementById('lerr'), $ok = document.getElementById('lok');
  $err.textContent = msg;
  const email = () => document.getElementById('email').value.trim();
  document.getElementById('login').onsubmit = async e => {
    e.preventDefault(); $err.textContent = ''; $ok.textContent = '';
    const { data, error } = await sb.auth.signInWithPassword({ email: email(), password: document.getElementById('pass').value });
    if (error) {
      const m = error.message || '';
      $err.textContent = /invalid login credentials/i.test(m) ? 'E-mail ou senha incorretos. Se não lembrar a senha, use "Esqueci a senha".'
        : /email not confirmed/i.test(m) ? 'Este e-mail ainda não foi confirmado. Procure o link de confirmação na sua caixa de entrada.'
        : /fetch|network/i.test(m) ? 'Sem conexão com o servidor. Confira a internet e tente de novo.' : m;
      return;
    }
    await enter(data.user);
  };
  document.getElementById('forgot').onclick = async () => {
    $err.textContent = ''; $ok.textContent = '';
    if (!email()) { $err.textContent = 'Escreva seu e-mail no campo acima e toque de novo em "Esqueci a senha".'; return; }
    const { error } = await sb.auth.resetPasswordForEmail(email(), { redirectTo: location.origin + location.pathname });
    if (error) { $err.textContent = /rate|seconds/i.test(error.message) ? 'Já enviamos um link há pouco. Espere um minuto e tente de novo.' : error.message; return; }
    $ok.textContent = 'Se o e-mail estiver cadastrado, chega em instantes um link para criar uma senha nova. Abra o link neste mesmo aparelho.';
  };
}

// tela de senha nova, aberta pelo link do e-mail de recuperação
function renderNewPassword() {
  $app.innerHTML = `<div class="center"><form class="login" id="newpass">
    <span class="brand"><span class="logo">${icon('bars', 18, 2.2)}</span>MyFinance</span>
    <p>Crie uma senha nova.</p>
    <div class="field"><label for="np1">Senha nova</label><input class="input" id="np1" type="password" autocomplete="new-password" minlength="8" required></div>
    <div class="field"><label for="np2">Repita a senha</label><input class="input" id="np2" type="password" autocomplete="new-password" minlength="8" required></div>
    <p class="help small">Pelo menos 8 caracteres. Use uma senha que você não usa em nenhum outro lugar.</p>
    <div class="err" id="nperr" role="alert"></div>
    <div class="actions"><button class="btn primary grow" type="submit">Salvar senha e entrar</button></div>
  </form></div>`;
  const $err = document.getElementById('nperr');
  document.getElementById('newpass').onsubmit = async e => {
    e.preventDefault(); $err.textContent = '';
    const a = document.getElementById('np1').value, b = document.getElementById('np2').value;
    if (a.length < 8) { $err.textContent = 'A senha precisa ter pelo menos 8 caracteres.'; return; }
    if (a !== b) { $err.textContent = 'As duas senhas não são iguais.'; return; }
    const { data, error } = await sb.auth.updateUser({ password: a });
    if (error) { $err.textContent = /session/i.test(error.message) ? 'O link venceu. Volte e peça outro em "Esqueci a senha".' : error.message; return; }
    history.replaceState(null, '', location.pathname);
    toast('Senha alterada.');
    await enter(data.user);
  };
}
