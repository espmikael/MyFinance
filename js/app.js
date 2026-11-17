import * as L from './logic.js?v=20261117c';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=20261117c';

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
  nfc: '<path d="M8.5 7.5a6 6 0 0 1 0 9M12 5a9.5 9.5 0 0 1 0 14M5 10a2.5 2.5 0 0 1 0 4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  bars: '<path d="M5 19V9M12 19V5M19 19v-7"/>',
};
const icon = (name, size = 18, sw = 2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const VIEWS = [['home', 'Início', 'home'], ['gastos', 'Gastos', 'list'], ['contas', 'Contas', 'doc'], ['painel', 'Painel', 'chart'], ['reservas', 'Reservas', 'safe']];

function render() {
  if (!state.user) return renderLogin();
  const s = summary(state.view === 'home' ? curCycle() : state.cycle);
  const body = {
    home: () => viewHome(s), gastos: () => viewGastos(s), painel: () => viewPainel(s), contas: viewContas,
    reservas: viewReservas, ajustes: viewAjustes, entradas: viewEntradas,
  }[state.view]();
  const cur = state.view === 'entradas' ? 'ajustes' : state.view;
  const nav = ([id, l, ic]) => `<button class="navlink" data-act="view" data-v="${id}" ${cur === id ? 'aria-current="page"' : ''}>${icon(ic)}${l}</button>`;
  const tab = ([id, l, ic]) => `<button data-act="view" data-v="${id}" ${cur === id ? 'aria-current="page"' : ''}>${icon(ic, 22)}${l}</button>`;
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

function summary(cycle) {
  return L.summarize({ txs: state.txs, rules: state.rules, settings: state.settings, cycle, today: today(), incomes: state.incomes });
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
const pageHead = (title, sub, actions = headActions(), cls = '') => `<header class="pagehead ${cls}"><div class="t"><h1 class="page-title">${title}</h1>${sub ? `<span class="sub">${sub}</span>` : ''}</div>${actions}</header>`;

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
function viewHome(s) {
  const t = today();
  const sub = `${L.weekdayShort(t).replace(/^./, c => c.toUpperCase())}, ${L.dayMonth(t)} · competência de ${mName(s.month)}`;
  if (!state.txs.length) {
    return `${pageHead('Início', sub)}<div class="card empty">
      <h2>Envie a primeira fatura</h2>
      <p>No app do banco, exporte a fatura do cartão em CSV ou Excel. Depois toque em <b>Enviar fatura</b> e escolha o arquivo.</p>
      <p>Para ver quanto sobra no mês, informe suas entradas e cadastre suas contas.</p>
      <div class="actions"><button class="btn primary" data-act="upload">Enviar fatura</button><button class="btn" data-act="view" data-v="contas">Cadastrar contas</button></div>
    </div>`;
  }
  return `${pageHead('Início', sub)}
    ${uploadNudge()}
    ${s.toClassify.length ? `<div class="notice"><span>${s.toClassify.length === 1 ? '1 compra sem rubrica' : `${s.toClassify.length} compras sem rubrica`}. Ao classificar, o app aprende para as próximas.</span><button class="btn small" data-act="classify">Classificar</button></div>` : ''}
    ${s.income <= 0 ? `<div class="notice info"><span>Informe suas entradas para ver a sobra do mês.</span><button class="btn small" data-act="inc-edit">Entradas</button></div>` : ''}
    ${homeNumbers(s)}
    <div class="cols">
      <div class="col-main">${possoCard(s)}${agendaCard(s)}</div>
      <div class="col-side">${cardsCard()}${homeBills(s)}</div>
    </div>
    ${rubricasCard(s)}`;
}

function homeNumbers(s) {
  const inc = s.incomeItems, rec = inc.filter(i => i.received).length;
  const fx = s.fixedItems, paid = fx.filter(f => f.paid).length;
  const sobra = s.isCurrent ? s.leftover : s.result;
  const next = inc.find(i => !i.received);
  const out = Math.max(1, s.fixedCost + s.varProjected + Math.max(0, sobra));
  const split = `<div class="split" aria-hidden="true"><i style="flex:${s.fixedCost} 1 0;background:var(--fixed-fill)"></i><i style="flex:${s.varProjected} 1 0;background:var(--over-fill)"></i>${sobra > 0 ? `<i style="flex:${sobra} 1 0;background:var(--ok-fill)"></i>` : ''}</div>`;
  const hero = s.isCurrent ? `<div class="kcard hero ${s.perDay > 0 ? '' : 'zero'}">
      <span class="kl">Hoje dá para gastar</span>
      <span class="kv">${money(s.perDay || 0)}</span>
      <div class="segbar" aria-hidden="true">${segs(s.totalDays, s.totalDays - s.daysLeft)}</div>
      <span class="ks">${s.perDay > 0 ? `${money(s.perDay * 7)} por semana · ${s.daysLeft} ${s.daysLeft === 1 ? 'dia' : 'dias'} até ${L.dayMonth(s.cycle.end)}` : `Os tetos variáveis acabaram. Até ${L.dayMonth(s.cycle.end)}, só o essencial.`}</span>
    </div>` : '';
  const k = (label, value, bar, foot, cls = '') => `<div class="kcard"><span class="kl">${label}</span><span class="kv ${cls}">${value}</span>${bar}<span class="ks">${foot}</span></div>`;
  const incBar = `<div class="segbar" aria-hidden="true">${inc.length ? segs(inc.length, rec, 'okf') : ''}</div>`;
  const fxBar = `<div class="segbar" aria-hidden="true">${fx.length ? segs(fx.length, paid, 'okf') : ''}</div>`;
  const incFoot = `${rec} de ${inc.length} recebidas${next ? ` · ${esc(next.name.toLowerCase())} em ${L.ddmm(next.date)}` : ''}`;
  const fxFoot = fx.length ? `${paid} de ${fx.length} pagas${fx.find(f => !f.paid) ? ` · falta ${esc(fx.find(f => !f.paid).name.toLowerCase())}` : ''}` : 'nenhuma conta cadastrada';
  const sCls = s.income > 0 ? (sobra < 0 ? 'neg' : 'pos') : '';
  return `<div class="only-desk"><section class="kgrid" aria-label="Resumo">
      ${hero}
      ${k(`Entradas de ${mName(s.month)}`, money(s.income), incBar, incFoot)}
      ${k('Contas do mês', money(s.fixedCost), fxBar, fxFoot)}
      ${k(`Sobra prevista de ${mName(s.month)}`, s.income > 0 ? (sobra >= 0 && !state.priv ? '+' : '') + signed(sobra) : '—', split, 'entradas − contas − cartões (projeção)', sCls)}
    </section></div>
    <div class="only-mob" style="display:flex;flex-direction:column;gap:14px">
      ${hero}
      <section class="mini3" aria-label="Resumo do mês">
        ${k('Entradas', money(s.income), incBar, `${rec} de ${inc.length} recebidas`)}
        ${k('Contas', money(s.fixedCost), fxBar, `${paid} de ${fx.length} pagas`)}
        ${k('Sobra prevista', s.income > 0 ? (sobra >= 0 && !state.priv ? '+' : '') + signed(sobra) : '—', split, `de ${mName(s.month)}`, sCls)}
      </section>
    </div>`;
}

// Posso comprar?
function possoCard(s) {
  if (!s.isCurrent) return '';
  const cats = s.rows.filter(r => !r.fixed && r.varBudget > 0);
  if (!cats.length) return '';
  const pc = state.pc;
  if (!pc.cat || !cats.some(r => r.name === pc.cat)) pc.cat = (cats.find(r => r.status !== 'ok') || cats[0]).name;
  const row = cats.find(r => r.name === pc.cat);
  const amt = Number(pc.amt) || 0;
  const left = Math.max(0, row.left);
  const fits = amt <= left;
  const newDay = Math.max(0, (s.varLeft - Math.min(amt, left)) / Math.max(1, s.daysLeft));
  const sobraAfter = s.leftover - Math.max(0, amt - left);
  const v = fits
    ? { cls: 'ok', ic: icon('check', 18, 2.6), t: 'Cabe', x: `Sobram ${money(left - amt)} no teto de ${esc(row.name)}. O “hoje dá para gastar” vai de ${money(s.perDay || 0)} para ${money(newDay)}.` }
    : { cls: 'no', ic: '!', t: 'Não cabe no teto', x: `Passa ${money(amt - left)} do teto de ${esc(row.name)}.${s.income > 0 ? ` Se comprar, a sobra prevista de ${mName(s.month)} vai de ${signed(s.leftover)} para ${signed(sobraAfter)}.` : ''}` };
  return `<section class="card" id="pc" aria-labelledby="pc-h">
    <div class="card-head"><h2 id="pc-h">Posso comprar?</h2><span class="sub">teste antes de passar o cartão</span></div>
    <div class="lbl">Valor</div>
    <div class="amt-row">${[20, 50, 100, 250].map(x => `<button class="chip" data-act="pc-amt" data-v="${x}" aria-pressed="${amt === x}">R$ ${x}</button>`).join('')}
      <label class="money"><span>R$</span><input id="pc-in" inputmode="decimal" placeholder="outro" aria-label="Outro valor" value="${[20, 50, 100, 250].includes(amt) ? '' : fmtIn(amt)}"></label></div>
    <div class="lbl" style="margin-top:12px">Rubrica</div>
    <div class="chips" style="margin-top:8px">${cats.map(r => `<button class="chip" data-act="pc-cat" data-v="${esc(r.name)}" aria-pressed="${r.name === pc.cat}">${esc(r.name)}</button>`).join('')}</div>
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
  const share = s.varSpent > 0 ? (s.bySource[prim.id] || 0) / s.varSpent : 1;
  const ag = L.moneyAgenda({ settings: st, txs: state.txs, rules: state.rules, incomes: state.incomes, today: today(), primaryProjection: Math.round(s.varProjected * share * 100) / 100 });
  const hasBal = ag.start != null;
  const stale = hasBal && ag.balanceDate && L.daysBetween(ag.balanceDate, today()) > 3;
  let alert = '';
  if (hasBal && ag.min && ag.min.balance < 0) {
    alert = `<div class="alert bad">${icon('warn', 20)}<span><b>Em ${L.ddmm(ag.min.date)} a conta fica ${money(-ag.min.balance)} no negativo.</b>${ag.tip && ag.tip.from ? ` Separe ${money(ag.tip.need)} da ${esc(ag.tip.from.toLowerCase())} de ${L.ddmm(ag.tip.fromDate)} para não precisar converter crédito.` : ' Reveja as saídas antes dessa data.'}</span></div>`;
  } else if (hasBal && ag.min) {
    alert = `<div class="alert good">${icon('check', 20, 2.4)}<span><b>A conta não fica negativa nesse período.</b> Ponto mais baixo: ${money(ag.min.balance)} em ${L.ddmm(ag.min.date)}.</span></div>`;
  }
  const rows = ag.events.map(e => `<div class="ev">
      <span class="d"><b>${L.ddmm(e.date)}</b><small>${L.weekdayShort(e.date)}</small></span>
      <span class="p ${e.kind}" aria-hidden="true"></span>
      <span class="t"><b>${esc(e.title)}</b><small class="${e.balance != null && e.balance < 0 && e.kind !== 'info' ? 'neg' : ''}">${e.kind === 'info' ? esc(e.sub) : e.balance != null ? `${esc(e.sub)} · saldo ${signed(e.balance)}` : esc(e.sub)}</small></span>
      <span class="a ${e.amount > 0 ? 'in' : ''}">${e.kind === 'info' ? '' : (e.amount > 0 && !state.priv ? '+' : '') + signed(e.amount)}</span>
    </div>`).join('');
  return `<section class="card" aria-labelledby="ag-h">
    <div class="card-head"><h2 id="ag-h">Agenda do dinheiro</h2><span class="sub">próximas 5 semanas</span></div>
    <div class="balbox"><span>Saldo na conta ${hasBal ? `<b>${money(ag.start)}</b>${stale ? ` <span class="muted">· de ${L.ddmm(ag.balanceDate)}</span>` : ''}` : '<b>não informado</b>'}</span><button class="btn small" data-act="balance">${hasBal ? 'Atualizar' : 'Informar saldo'}</button></div>
    ${alert ? `<div style="margin-top:10px">${alert}</div>` : ''}
    ${!hasBal ? '<p class="help">Com o saldo da conta, a agenda mostra quanto sobra depois de cada entrada e saída e avisa antes de ficar no negativo.</p>' : ''}
    <div class="agenda" style="margin-top:6px">${rows || '<p class="help">Nada previsto nas próximas semanas.</p>'}</div>
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

// Contas do mês (Início)
function homeBills(s) {
  const fx = s.fixedItems;
  const toPay = fx.filter(f => !f.paid), paid = fx.filter(f => f.paid);
  const ym = s.month, canPay = ym <= today().slice(0, 7);
  const bills = L.billsOut(state.settings, ym, state.txs, state.rules);
  const meta = f => { const b = bills.find(x => x.index === f.index); return b ? [b.parcel ? `parcela ${b.parcel.n} de ${b.parcel.total}` : '', b.day ? `vence dia ${b.day}` : ''].filter(Boolean).join(' · ') : ''; };
  const list = (state.homeTab === 'a' ? toPay : paid).map(f => `<div class="lrow">
      <span class="ic ${f.paid ? 'ok' : 'warn'}">${icon('doc', 18)}</span>
      <span class="m"><b>${esc(f.name)}</b><small class="${f.paid ? 'g' : 'w'}">${esc(f.category || '')}${meta(f) ? ' · ' + esc(meta(f)) : ''}${f.paid ? ' · paga' : ''}</small></span>
      <span class="r"><b>${money(f.paid ? f.paidAmount : f.value)}</b>${f.paid ? `<button class="pill ok" data-act="fix-unpay" data-id="${f.tx.id}">paga ✓</button>` : canPay ? `<button class="pill" data-act="fix-pay" data-i="${f.index}" data-ym="${ym}">Marcar paga</button>` : ''}</span>
    </div>`).join('');
  return `<section class="card" aria-labelledby="cm-h">
    <div class="card-head"><h2 id="cm-h">Contas do mês</h2><button class="btn small" data-act="view" data-v="contas">Gerenciar</button></div>
    ${fx.length ? `<div class="tablist" role="tablist"><button role="tab" data-act="home-tab" data-v="a" aria-selected="${state.homeTab === 'a'}">A pagar · ${toPay.length}</button><button role="tab" data-act="home-tab" data-v="b" aria-selected="${state.homeTab === 'b'}">Pagas · ${paid.length}</button></div>
    <div style="margin-top:6px">${list || `<p class="help">${state.homeTab === 'a' ? 'Tudo pago neste mês.' : 'Nada pago ainda.'}</p>`}</div>`
    : '<p class="help">Cadastre aluguel, mestrado, plano do celular… na tela Contas.</p>'}
  </section>`;
}

// Rubricas: primeiro o que pede atenção
function rubricasCard(s) {
  const vr = s.rows.filter(r => !r.fixed && r.varBudget > 0);
  const att = vr.filter(r => r.status !== 'ok');
  const calm = vr.filter(r => r.status === 'ok');
  const N = 30;
  const attHTML = att.map(r => {
    const over = r.status === 'over';
    const txt = over ? `${money(r.varSpent)} de ${money(r.varBudget)}. Os ${money(-r.left)} a mais saem da sobra do mês.`
      : `${money(r.varSpent)} de ${money(r.varBudget)} com ${pct(s.elapsed)} do ciclo. Restam ${money(r.left)}${r.perWeek != null ? `, cerca de ${money(r.perWeek)} por semana` : ''}.`;
    return `<button class="attc ${over ? 'o' : 'w'}" data-act="cat-open" data-c="${esc(r.name)}">
      <span class="h"><b>${esc(r.name)}</b><span class="tag">${over ? 'teto estourado' : 'acima do ritmo'}</span></span>
      <span class="segbar thin" aria-hidden="true">${segs(N, Math.min(N, Math.round(r.varSpent / r.varBudget * N)), over ? 'of' : 'wf')}</span>
      <p>${txt}</p></button>`;
  }).join('');
  const calmHTML = calm.map(r => `<button class="calmc" data-act="cat-open" data-c="${esc(r.name)}">
      <small>${esc(r.name)}</small><b>${money(r.left)}</b>
      <span class="thinbar" aria-hidden="true"><i style="width:${Math.min(100, Math.round(r.varSpent / r.varBudget * 100))}%"></i></span>
      <em>${r.perWeek != null ? `${money(r.perWeek)} por semana` : `restam de ${money(r.varBudget)}`}</em></button>`).join('');
  return `<section class="card" aria-labelledby="rb-h">
    <div class="card-head"><h2 id="rb-h">Rubricas</h2><span class="sub">${att.length ? `${att.length} ${att.length === 1 ? 'pede' : 'pedem'} atenção` : 'tudo no ritmo'} · toque para ver os gastos</span></div>
    ${att.length ? `<div class="att">${attHTML}</div>` : ''}
    ${calm.length ? `<div class="calm">${calmHTML}</div>` : ''}
    ${!vr.length ? '<p class="help">Defina tetos para as rubricas em Ajustes.</p>' : ''}
  </section>`;
}

// lembrete do envio semanal: última compra vinda de fatura
function uploadNudge() {
  const imported = state.txs.filter(t => !t.manual);
  if (!imported.length) return '';
  const last = imported.reduce((m, t) => { const d = (t.created_at || t.date).slice(0, 10); return d > m ? d : m; }, '');
  const days = L.daysBetween(last, today());
  if (days < 7) return '';
  return `<div class="notice"><span>Última fatura enviada há ${days} dias. Exporte o CSV ou Excel dos cartões e atualize.</span><button class="btn small" data-act="upload">Enviar agora</button></div>`;
}

// ----- Contas -----
function viewContas() {
  const ym = state.contasMonth || L.monthOfCycle(curCycle());
  const plan = L.monthPlan({ settings: state.settings, txs: state.txs, rules: state.rules, incomes: state.incomes, ym });
  const M = mName(ym).replace(/^./, c => c.toUpperCase()) + (ym.slice(0, 4) === today().slice(0, 4) ? '' : ` de ${ym.slice(0, 4)}`);
  const parts = [['Exatas fora do cartão', plan.exactOut, 'var(--brand)'], ['Estimadas fora do cartão', plan.estOut, 'var(--fixed-fill)'], ['Já no cartão', plan.onCard, 'var(--over-fill)']];
  if (plan.free > 0) parts.push(['Livre', plan.free, 'var(--ok-soft)']);
  const slackAlert = plan.income <= 0 ? `<div class="alert warn">${icon('warn', 20)}<span>Sem entradas previstas para ${mName(ym)}. Informe salário e vintena para ver o que fica livre.</span></div>`
    : plan.slack >= 0 ? `<div class="alert good">${icon('check', 20, 2.4)}<span><b>Os tetos cabem${plan.slack < 150 ? ', por pouco' : ''}.</b> Tirando o que já está no cartão dentro deles, os tetos variáveis pedem ${money(plan.tetoNeed)}. Ficam livres ${money(plan.free)}: folga de ${money(plan.slack)}.</span></div>`
    : `<div class="alert bad">${icon('warn', 20)}<span><b>Os tetos não cabem.</b> Eles pedem ${money(plan.tetoNeed)} e ficam livres ${money(plan.free)}. Se gastar tudo o que os tetos permitem, ${mName(ym)} fecha ${money(-plan.slack)} no negativo. Reduza algum teto.</span></div>`;

  const kind = state.contasKind;
  const list = (kind === 'exact' ? plan.exact : plan.est);
  const grp = (title, items) => items.length ? `<div class="grp-h"><span>${title}</span><b>${money(items.reduce((a, b) => a + b.value, 0))}</b></div>${items.map(billRow).join('')}` : '';
  const body = grp('Fora do cartão', list.filter(b => !b.onCard)) + grp('No cartão · já entram na fatura', list.filter(b => b.onCard));
  return `${pageHead('Contas', 'o que já está contratado ou se repete todo mês', `<div class="head-actions">
      <div class="cycle" style="padding:2px"><button class="icon-btn sm" data-act="contas-month" data-d="-1" aria-label="Mês anterior">‹</button><b style="min-width:110px;text-align:center">${M}</b><button class="icon-btn sm" data-act="contas-month" data-d="1" aria-label="Próximo mês">›</button></div>
      <button class="btn primary" data-act="bill-new" data-ym="${ym}">${icon('plus', 16, 2.4)}Nova conta</button></div>`, 'wrap')}
    <section class="card plan" aria-labelledby="pl-h">
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:14px">
        <div style="display:flex;flex-direction:column;gap:4px"><span id="pl-h" class="k">${M} já começa com</span><span class="big">${money(plan.committed)}</span><span class="small muted">comprometidos antes de qualquer gasto do dia a dia</span></div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px"><span class="small muted">Entradas previstas ${money(plan.income)}</span><span>Livre <b style="font-size:22px" class="${plan.free < 0 ? 'neg' : 'pos'}">${signed(plan.free)}</b></span></div>
      </div>
      <div class="split" aria-hidden="true">${parts.map(([, v, c]) => `<i style="flex:${Math.max(0, v)} 1 0;background:${c}"></i>`).join('')}</div>
      <div class="legend2">${parts.map(([l, v, c]) => `<span><span class="dot" style="background:${c}"></span>${l} <b>${money(v)}</b></span>`).join('')}</div>
      <div style="margin-top:14px">${slackAlert}</div>
    </section>
    <section class="card" aria-label="Lista de contas">
      <div class="tablist" role="tablist" style="max-width:440px"><button role="tab" data-act="contas-kind" data-v="exact" aria-selected="${kind === 'exact'}">Exatas · ${plan.exact.length}</button><button role="tab" data-act="contas-kind" data-v="estimate" aria-selected="${kind === 'estimate'}">Estimadas · ${plan.est.length}</button></div>
      <p class="help">${kind === 'exact' ? 'Valor certo todo mês. Parcelas do cartão entram aqui sozinhas quando a fatura mostra “Parcela 3/5”.' : 'Valor que oscila pouco (aluguel, luz). O app usa a média dos últimos 3 meses de pagamentos com o mesmo nome.'}</p>
      ${body || `<p class="help">Nenhuma conta ${kind === 'exact' ? 'exata' : 'estimada'} em ${mName(ym)}.</p>`}
      <button class="row add" data-act="bill-new" data-ym="${ym}" data-kind="${kind}">Adicionar conta ${kind === 'exact' ? 'exata' : 'estimada'}</button>
    </section>`;
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
  const list = s.txs.filter(t => f === 'all' ? true : f === 'unc' ? !known.has(t.cat) : f.startsWith('src:') ? (t.source || 'nubank') === f.slice(4) : f.startsWith('cat:') ? t.cat === f.slice(4) : true)
    .filter(t => !qq || L.normalize(`${t.title} ${L.prettyTitle(t.title)} ${t.cat} ${t.amount.toFixed(2).replace('.', ',')}`).includes(qq))
    .sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  if (!list.length) return `<p class="help" style="margin-top:20px">${qq ? 'Nada encontrado.' : 'Nada aqui neste ciclo.'}</p>`;
  const days = [];
  for (const t of list) { let d = days[days.length - 1]; if (!d || d.date !== t.date) { d = { date: t.date, items: [], sum: 0 }; days.push(d); } d.items.push(t); if (t.cat !== L.IGNORE) d.sum += t.amount; }
  const ini = name => { const w = L.prettyTitle(name).replace(/^iFood · /, 'iF ').split(/\s+/).filter(Boolean); return esc(((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase()); };
  const html = days.map(d => `<div class="day"><span>${longDay(d.date)}</span><span>${money(d.sum)}</span></div><div class="daybox">${d.items.map(t => {
    const isUnc = !known.has(t.cat);
    const sub = isUnc ? 'Sem rubrica · toque para classificar' : `${t.cat === L.IGNORE ? 'Ignorado' : esc(t.cat)} · ${esc(sourceName(t.source))}${t.isFixed ? ` · conta de ${L.MONTHS[+t.date.slice(5, 7) - 1]}` : t.manual ? ' · à mão' : ''}`;
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
  const srcIds = [...new Set(s.txs.map(t => t.source || 'nubank'))];
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
      ${srcIds.map(id => chip('src:' + id, `<span class="dot" style="background:${safeColor(sourceColor(id))}"></span>${esc(sourceName(id))}`)).join('')}
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
  return `<section class="card month">
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
        <span><small>− Contas</small>${money(m.fixedCost)}</span>
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
        <div class="mtitle"><span>Contas</span><b>${money(m.fixedCost)}</b></div>
        ${fix || '<p class="help">Nenhuma conta fora do cartão. Cadastre na tela Contas.</p>'}
        <div class="mact"><button class="btn small" data-act="view" data-v="contas">Gerenciar contas</button></div>
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
      <div class="trk"><div class="val ${r.spent > r.budget ? 'over' : ''}" style="width:${(r.spent / maxBar * 100).toFixed(1)}%"></div>${r.budget > 0 ? `<div class="tick" style="left:${(r.budget / maxBar * 100).toFixed(1)}%"></div>` : ''}</div>
    </div>`).join('');

  const totalSrc = Object.values(s.bySource).reduce((a, b) => a + Math.max(0, b), 0) || 1;
  const allSrc = sources().filter(x => x.card || s.bySource[x.id]);
  const stack = allSrc.filter(x => (s.bySource[x.id] || 0) > 0).map(x => `<div style="width:${(s.bySource[x.id] / totalSrc * 100).toFixed(1)}%;background:${safeColor(x.color)}"></div>`).join('');
  const srcRows = allSrc.map(x => {
    const v = s.bySource[x.id];
    return `<div class="list-row ${v ? '' : 'muted'}"><span style="display:flex;align-items:center;gap:10px"><span class="dot" style="background:${safeColor(x.color)}"></span>${esc(x.name)}</span><span>${v ? `<b>${money(v)}</b>` : (x.card ? 'sem fatura' : 'nada lançado')}</span></div>`;
  }).join('');
  const top = s.topMerchants.map(m => `<div class="list-row"><span>${esc(m.label)}</span><b>${money(m.total)}</b></div>`).join('');

  return `${pageHead('Painel', 'o mês inteiro e o ritmo do cartão')}
    ${monthBlock()}
    <h2 class="h2" style="margin-top:10px">Ciclo do cartão</h2>
    ${cycleRow(s)}
    <div class="kpis">${kpis.map(([k, v, sm, cls]) => `<div><span class="kl">${k}</span><b class="${cls || ''}">${v}</b>${sm ? `<small>${sm}</small>` : ''}</div>`).join('')}</div>
    ${!s.txs.length ? `<p class="help" style="margin-top:20px">Ainda não há gastos neste ciclo.</p>` : `
    <div class="dash" style="margin-top:16px">
      <section class="card">
        <div class="card-head"><h2>Ritmo do ciclo</h2></div>
        <div class="legend"><span><span class="sw-line"></span>Gasto acumulado (sem fixos)</span>${s.varBudget > 0 ? `<span><span class="sw-dash"></span>Soma dos tetos · ${money(s.varBudget)}</span>` : ''}</div>
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
      ${negWarn ? `<div class="small muted">A ${L.invoiceName(lastClosed.cycle, card(), today()).toLowerCase()} fechou no negativo. O aporte só cabe se este ciclo ficar dentro dos tetos.</div>` : ''}
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
      <input class="input" data-bind="categories.${i}.budget" data-type="money" inputmode="decimal" value="${fmtIn(c.budget)}" aria-label="Teto">
      <label class="check"><input type="checkbox" data-bind="categories.${i}.fixed" data-type="bool" ${c.fixed ? 'checked' : ''}> fixa</label>
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
      <div class="card-head"><h2>Rubricas e tetos</h2></div>
      <p class="help">O teto é o que dá para gastar variando (cartão, Pix, à mão). As contas de cada rubrica somam por cima. Marque "fixa" na rubrica que não varia no mês.</p>
      <button class="btn soft small" data-act="suggest">Sugerir tetos pela média dos últimos ciclos</button>
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

  return `${pageHead('Entradas', '<button class="btn small ghost" data-act="view" data-v="ajustes" style="padding:0;min-height:0;border:0">‹ Ajustes</button>', headActions({ upload: false }))}
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
    case 'classify': state.cycle = curCycle(); state.view = 'gastos'; state.filter = 'unc'; render(); window.scrollTo(0, 0); return;
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
    case 'card-open': state.cycle = curCycle(); state.view = 'gastos'; state.filter = 'src:' + el.dataset.id; state.q = ''; render(); window.scrollTo(0, 0); return;
    case 'pc-amt': state.pc.amt = Number(el.dataset.v); return refreshPC();
    case 'pc-cat': state.pc.cat = el.dataset.v; return refreshPC();
    case 'home-tab': state.homeTab = el.dataset.v; { const y = window.scrollY; render(); window.scrollTo(0, y); } return;
    case 'balance': return balanceSheet();
    case 'contas-kind': state.contasKind = el.dataset.v; { const y = window.scrollY; render(); window.scrollTo(0, y); } return;
    case 'contas-month': state.contasMonth = L.ymAdd(state.contasMonth || L.monthOfCycle(curCycle()), Number(el.dataset.d)); return render();
    case 'bill-new': return billSheet(null, el.dataset.ym || state.contasMonth || L.monthOfCycle(curCycle()), el.dataset.kind || 'exact');
    case 'bill-edit': return billSheet(Number(el.dataset.i), state.contasMonth || L.monthOfCycle(curCycle()));
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
    case 'fix-edit': state.view = 'contas'; render(); window.scrollTo(0, 0); return;
    case 'cat-open': if (state.view === 'home') state.cycle = curCycle(); state.view = 'gastos'; state.filter = 'cat:' + el.dataset.c; state.q = ''; render(); window.scrollTo(0, 0); return;
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
  input.type = 'file'; input.accept = '.csv,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    if (f.size > 15e6) return toast('Arquivo grande demais para uma fatura.');
    let text;
    try {
      if (/\.xlsx$/i.test(f.name)) { const X = await import('./xlsx.js?v=20261117c'); text = await X.xlsxToCSV(await f.arrayBuffer()); }
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
      <div class="wrapchips">${srcs.map((s, i) => `<button class="chip" data-src="${esc(s.id)}" aria-pressed="${i === 0}"><span class="dot" style="background:${safeColor(s.color)}"></span>${esc(s.name)}</button>`).join('')}</div>
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
    <button class="row" data-go="entradas"><span>Entradas</span><span class="end">›</span></button>
    <button class="row" data-go="ajustes"><span>Ajustes e regras</span><span class="end">›</span></button>
    <div class="lbl" style="margin-top:16px">Tema</div>
    <div class="seg" role="group" aria-label="Tema" style="margin-top:8px">${[['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Escuro']].map(([v, l]) => `<button data-th="${v}" aria-pressed="${theme === v}">${l}</button>`).join('')}</div>
    <div class="actions"><button class="btn ghost grow" data-close>Fechar</button></div>`;
  openSheet(html, (sh, close) => {
    sh.$$('[data-go]').forEach(b => b.addEventListener('click', () => {
      close();
      const v = b.dataset.go;
      if (['ajustes', 'entradas'].includes(v)) startDraft(); else state.draft = null;
      state.view = v; render(); window.scrollTo(0, 0);
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
  const html = `<div class="head"><h2>${b ? esc(b.name) : 'Nova conta'}</h2></div>
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
