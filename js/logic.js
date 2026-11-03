// Lógica pura do MyFinance: ler faturas, categorizar, calcular ciclos, vencimentos,
// datas de pagamento e os números das telas. Não toca em tela nem em banco.

export const IGNORE = 'Ignorar';
export const UNCLASSIFIED = 'A revisar';

// Regras genéricas de fábrica. As suas regras pessoais ficam só no banco
// (este arquivo é público no GitHub).
export const DEFAULT_RULES = [
  ['pagamento recebido', IGNORE],
  ['pagamento de fatura', IGNORE],
  ['one membership', 'Transporte'],
  ['uber', 'Transporte'],
  ['99app', 'Transporte'],
  ['ifood club', 'Alimentação'],
  ['ifd', 'Alimentação'],
  ['99food', 'Alimentação'],
  ['rappi', 'Alimentação'],
  ['spotify', 'Lazer e Entretenimento'],
  ['netflix', 'Lazer e Entretenimento'],
  ['paramount', 'Lazer e Entretenimento'],
  ['melimais', 'Lazer e Entretenimento'],
  ['hbo', 'Lazer e Entretenimento'],
  ['steam', 'Lazer e Entretenimento'],
  ['apple.com', 'Despesas Pessoais'],
  ['google one', 'Despesas Pessoais'],
  ['anthropic', 'Despesas Pessoais'],
  ['wellhub', 'Bem-Estar e Saúde'],
  ['smart fit', 'Bem-Estar e Saúde'],
  ['smartfit', 'Bem-Estar e Saúde'],
  ['farmacia', 'Bem-Estar e Saúde'],
  ['drogaria', 'Bem-Estar e Saúde'],
  ['panvel', 'Bem-Estar e Saúde'],
  ['raia', 'Bem-Estar e Saúde'],
  ['carrefour', 'Mercado'],
  ['zaffari', 'Mercado'],
  ['rissul', 'Mercado'],
  ['supermercado', 'Mercado'],
  ['iof', 'Pequenos gastos'],
  ['estorno', 'Pequenos gastos'],
].map(([keyword, category]) => ({ keyword, category }));

// Formas de pagamento lançadas à mão (os cartões vêm dos ajustes).
export const METHODS = [
  { id: 'pix', name: 'Pix', color: '#199e70' },
  { id: 'debito', name: 'Débito', color: '#199e70' },
  { id: 'dinheiro', name: 'Dinheiro', color: '#8b8e92' },
];

export const DEFAULT_SETTINGS = {
  cards: [
    { id: 'nubank', name: 'Nubank', closing: 3, due: 10, color: '#9085e9', primary: true },
    { id: 'inter', name: 'Inter', closing: null, due: null, color: '#d95926', primary: false },
  ],
  version: 2,
  fixed: [],              // gastos fora do cartão: [{ name, value, category }]
  incomeRules: [
    { key: 'salario', name: 'Salário', type: 'businessDay', n: 5, amount: 0 },
    { key: 'vintena', name: 'Vintena', type: 'day', day: 20, shift: 'before', amount: 0 },
  ],
  reserveMonths: 6,
  aporteGoal: 0,
  // as rubricas da planilha; o teto é só a parte variável (os fixos de cada rubrica somam por cima)
  categories: [
    { name: 'Alimentação', budget: 400, fixed: false },
    { name: 'Mercado', budget: 300, fixed: false },
    { name: 'Bem-Estar e Saúde', budget: 300, fixed: false },
    { name: 'Casa', budget: 260, fixed: true },
    { name: 'Despesas Pessoais', budget: 350, fixed: false },
    { name: 'Educação', budget: 0, fixed: true },
    { name: 'Lazer e Entretenimento', budget: 120, fixed: false },
    { name: 'Pequenos gastos', budget: 50, fixed: false },
    { name: 'Transporte', budget: 280, fixed: false },
    { name: 'Viagem', budget: 0, fixed: false },
  ],
};

// ---------- migração das categorias antigas (v1) para as rubricas da planilha ----------
const OLD_TO_NEW = {
  'Refeições livres': 'Alimentação', 'Mimos': 'Alimentação',
  'Suplementos': 'Bem-Estar e Saúde', 'Saúde': 'Bem-Estar e Saúde',
  'Outros': 'Pequenos gastos', 'Assinaturas': 'Despesas Pessoais', 'Parcelas': null,
};
const OLD_SUBS = [
  [/wellhub|smart ?fit|academia/, 'Bem-Estar e Saúde'],
  [/one membership|uber/, 'Transporte'],
  [/ifood/, 'Alimentação'],
  [/spotify|netflix|paramount|melimais|hbo|max|disney|prime|globoplay|youtube|deezer/, 'Lazer e Entretenimento'],
  [/nio|fibra|internet|vivo|claro|tim/, 'Casa'],
];
export const isOldCategory = name => Object.prototype.hasOwnProperty.call(OLD_TO_NEW, name);
// Nova rubrica para uma regra/compra antiga. undefined = não muda; null = volta para "sem categoria".
export function migrateCategory(oldCat, text = '') {
  if (!isOldCategory(oldCat)) return undefined;
  const t = normalize(text);
  if (oldCat === 'Assinaturas') { const hit = OLD_SUBS.find(([re]) => re.test(t)); return hit ? hit[1] : 'Despesas Pessoais'; }
  if (oldCat === 'Outros' && /steam|jogo|game/.test(t)) return 'Lazer e Entretenimento';
  return OLD_TO_NEW[oldCat];
}
export function fixedCategoryGuess(name) {
  const t = normalize(name);
  if (/aluguel|condominio|luz|agua|internet|gas|iptu/.test(t)) return 'Casa';
  if (/mestrado|faculdade|curso|escola|mensalidade/.test(t)) return 'Educação';
  if (/academia|plano de saude|terapia/.test(t)) return 'Bem-Estar e Saúde';
  return 'Despesas Pessoais';
}
// Ajustes antigos → novos (mantém cartões, entradas, fixos e reservas).
export function migrateSettings(saved) {
  const s = structuredClone(saved || {});
  if ((s.version || 1) >= 2) return s;
  s.categories = structuredClone(DEFAULT_SETTINGS.categories);
  s.fixed = (s.fixed || []).map(f => ({ ...f, category: f.category || fixedCategoryGuess(f.name) }));
  s.version = 2;
  return s;
}

export function withDefaults(saved) {
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...(saved ? migrateSettings(saved) : {}) };
  // migra o formato antigo (closingDay solto / income único)
  if (saved && saved.closingDay && !saved.cards) s.cards[0].closing = saved.closingDay;
  if (!Array.isArray(s.cards) || !s.cards.length) s.cards = structuredClone(DEFAULT_SETTINGS.cards);
  if (!s.cards.some(c => c.primary)) s.cards[0].primary = true;
  return s;
}

export const primaryCard = s => s.cards.find(c => c.primary) || s.cards[0];

export function sourcesOf(settings) {
  return [...settings.cards.map(c => ({ id: c.id, name: c.name, color: c.color, card: true })), ...METHODS];
}

// ---------- texto e números ----------
export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function slug(s) {
  return normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cartao';
}

export function suggestKeyword(title) {
  return normalize(title)
    .replace(/^pix no credito - /, '')
    .replace(/ - parcela \d+\/\d+$/, '')
    .replace(/^(dl|ifd|ec|mp|pg|zp|app|ebn|jim\.com)\s*\*\s*/, '')
    .slice(0, 40).trim();
}

export function parseAmount(raw) {
  if (typeof raw === 'number') return raw;
  let s = String(raw ?? '').replace(/\s/g, '').replace(/R\$/i, '');
  if (s === '') return NaN;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return neg ? -Math.abs(n) : n;
}

const round = n => Math.round(n * 100) / 100;

// ---------- CSV ----------
function splitCSVLine(line, sep) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim());
}

export function toISODate(s) {
  s = String(s ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (m) return `20${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

const DATE_COLS = ['date', 'data', 'data da compra', 'data compra', 'data lancamento', 'data de lancamento'];
const TITLE_COLS = ['title', 'descricao', 'lancamento', 'estabelecimento', 'historico', 'description', 'descricao do lancamento'];
const AMOUNT_COLS = ['amount', 'valor', 'valor (r$)', 'valor em r$', 'valor r$'];

function findCol(header, names) {
  let i = header.findIndex(h => names.includes(h));
  if (i < 0) i = header.findIndex(h => names.some(n => h.startsWith(n)));
  return i;
}

// Lê a fatura de um cartão. Reconhece o formato do Nubank (date,title,amount)
// e tenta um formato genérico para outros bancos (data, descrição, valor).
// Devolve { rows, error, bank } — bank = 'nubank' quando reconhecido, senão null.
export function parseInvoiceCSV(text) {
  let lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim() !== '');
  if (!lines.length) return { rows: [], error: 'O arquivo está vazio.', bank: null };

  // alguns bancos colocam linhas de título antes do cabeçalho: procura a primeira linha com data e valor
  let headerIdx = -1, sep = ',', header = [];
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    for (const sp of [',', ';', '\t']) {
      const h = splitCSVLine(lines[i], sp).map(normalize);
      if (findCol(h, DATE_COLS) >= 0 && findCol(h, AMOUNT_COLS) >= 0 && findCol(h, TITLE_COLS) >= 0) { headerIdx = i; sep = sp; header = h; break; }
    }
    if (headerIdx >= 0) break;
  }
  if (headerIdx < 0) return { rows: [], error: 'Não reconheci as colunas do arquivo. Ele precisa ter data, descrição e valor.', bank: null };

  const bank = header.join(',') === 'date,title,amount' ? 'nubank' : null;
  const iD = findCol(header, DATE_COLS), iT = findCol(header, TITLE_COLS), iA = findCol(header, AMOUNT_COLS);

  let rows = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const cols = splitCSVLine(line, sep);
    const date = toISODate(cols[iD]);
    const title = String(cols[iT] ?? '').trim();
    const amount = round(parseAmount(cols[iA]));
    if (!date || !title || !Number.isFinite(amount)) continue;
    rows.push({ date, title, amount });
  }
  if (!rows.length) return { rows: [], error: 'Não encontrei nenhuma compra no arquivo.', bank };

  // em outros bancos as compras podem vir negativas: se a maioria for negativa, inverte o sinal
  if (!bank) {
    const neg = rows.filter(r => r.amount < 0).length;
    if (neg > rows.length / 2) rows = rows.map(r => ({ ...r, amount: -r.amount }));
  }
  return { rows, error: null, bank };
}

// Mantido por compatibilidade com o nome antigo.
export const parseNubankCSV = parseInvoiceCSV;

// Impressão digital estável de cada linha (compras iguais no mesmo dia viram #1, #2…)
export function fingerprint(rows, source) {
  const seen = new Map();
  return rows.map(r => {
    const base = `${source}|${r.date}|${normalize(r.title)}|${r.amount.toFixed(2)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return { ...r, source, uid: `${base}|${n}` };
  });
}

// Proteções extras contra duplicar ao reenviar a fatura:
// 1) compra que mudou de descrição ou de valor entre um envio e outro: a versão antiga
//    sumiu do arquivo novo e aparece uma "nova" no mesmo dia, com o mesmo valor ou a mesma descrição.
// 2) a mesma fatura marcada com o cartão errado: as compras já existem com outra origem.
export function findSuspects(rows, fresh, existing, source) {
  const fileUids = new Set(rows.map(r => r.uid));
  const dates = rows.map(r => r.date).sort();
  const lo = dates[0], hi = dates[dates.length - 1];
  const orphans = existing.filter(t => (t.source || 'nubank') === source && !t.manual && t.date >= lo && t.date <= hi && !fileUids.has(t.uid));
  const suspects = new Set();
  for (const r of fresh) {
    const i = orphans.findIndex(t => t.date === r.date && (Math.abs(Number(t.amount) - r.amount) < 0.005 || normalize(t.title) === normalize(r.title)));
    if (i >= 0) { suspects.add(r.uid); orphans.splice(i, 1); }
  }
  const sig = t => `${t.date}|${normalize(t.title)}|${Number(t.amount).toFixed(2)}`;
  const counts = {};
  const freshSigs = new Set(fresh.map(sig));
  for (const t of existing) {
    const s = t.source || 'nubank';
    if (s !== source && !t.manual && freshSigs.has(sig(t))) counts[s] = (counts[s] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { suspects, otherSource: top ? { id: top[0], count: top[1] } : null };
}

// ---------- categorias ----------
export function matchRule(title, rules) {
  const t = normalize(title);
  let best = null;
  for (const r of rules) {
    const k = normalize(r.keyword);
    if (k && t.includes(k) && (!best || k.length > normalize(best.keyword).length)) best = r;
  }
  return best;
}

export function categoryOf(tx, rules) {
  if (tx.category) return tx.category;
  const r = matchRule(tx.title, rules);
  return r ? r.category : UNCLASSIFIED;
}

// ---------- datas ----------
const DAY = 86400000;
export const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const MONTHS_SHORT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function parseISO(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
export function fmtISO(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function addDays(iso, n) { return fmtISO(parseISO(iso) + n * DAY); }
export function daysBetween(a, b) { return Math.round((parseISO(b) - parseISO(a)) / DAY); }
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return fmtISO(Date.UTC(y, m - 1 + n, Math.min(d, last)));
}
export function dayMonth(iso) { return `${+iso.slice(8, 10)} ${MONTHS_SHORT[+iso.slice(5, 7) - 1]}`; }
export function ddmm(iso) { return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`; }
export function weekdayShort(iso) { return WEEKDAYS[new Date(parseISO(iso)).getUTCDay()]; }

const clampDay = d => Math.min(Math.max(1, d | 0), 28);

// Ciclo do cartão que contém a data. Compras no dia do fechamento já vão para a fatura seguinte.
export function cycleFor(dateISO, closingDay) {
  const cd = clampDay(closingDay);
  const [y, m, d] = dateISO.split('-').map(Number);
  const startMs = d >= cd ? Date.UTC(y, m - 1, cd) : Date.UTC(y, m - 2, cd);
  const s = new Date(startMs);
  const endMs = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, cd) - DAY;
  return { start: fmtISO(startMs), end: fmtISO(endMs) };
}

export function shiftCycle(startISO, n, closingDay) {
  const s = new Date(parseISO(startISO));
  return cycleFor(fmtISO(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + n, clampDay(closingDay))), closingDay);
}

// Vencimento da fatura de um ciclo, e o nome dela (o mês em que vence, como o Nubank faz).
export function dueDateFor(cycle, card) {
  const closeDate = addDays(cycle.end, 1);
  const [y, m] = closeDate.split('-').map(Number);
  const due = card.due || 10;
  const sameMonth = due > clampDay(card.closing || 1);
  return fmtISO(Date.UTC(y, m - 1 + (sameMonth ? 0 : 1), due));
}

export function invoiceName(cycle, card, today) {
  const due = dueDateFor(cycle, card);
  const name = `Fatura de ${MONTHS[+due.slice(5, 7) - 1]}`;
  return due.slice(0, 4) === today.slice(0, 4) ? name : `${name} de ${due.slice(0, 4)}`;
}

// ---------- dias úteis e feriados nacionais ----------
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, month - 1, day);
}

const holidayCache = {};
export function holidays(y) {
  if (holidayCache[y]) return holidayCache[y];
  const fixed = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'].map(md => `${y}-${md}`);
  const e = easter(y);
  // Carnaval (seg e ter), Sexta-feira Santa e Corpus Christi: bancos fechados
  const mobile = [-48, -47, -2, 60].map(n => fmtISO(e + n * DAY));
  return (holidayCache[y] = new Set([...fixed, ...mobile]));
}

export function isBusinessDay(iso) {
  const wd = new Date(parseISO(iso)).getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays(+iso.slice(0, 4)).has(iso);
}

export function nthBusinessDay(y, m, n) {
  let d = fmtISO(Date.UTC(y, m - 1, 1)), count = 0;
  for (let i = 0; i < 40; i++) {
    if (isBusinessDay(d) && ++count === n) return d;
    d = addDays(d, 1);
  }
  return d;
}

export function shiftToBusinessDay(iso, shift) {
  let d = iso;
  for (let i = 0; i < 10 && !isBusinessDay(d); i++) d = addDays(d, shift === 'after' ? 1 : -1);
  return d;
}

// Datas previstas das entradas fixas num mês.
export function incomeSchedule(rules, y, m) {
  return (rules || []).map(r => {
    let date, why = '';
    if (r.type === 'businessDay') {
      date = nthBusinessDay(y, m, r.n || 5);
      why = `${r.n || 5}º dia útil`;
    } else {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const raw = fmtISO(Date.UTC(y, m - 1, Math.min(r.day || 20, last)));
      date = shiftToBusinessDay(raw, r.shift);
      why = date === raw ? `dia ${r.day}` : `dia ${r.day} não é dia útil · ${r.shift === 'after' ? 'vai para' : 'adianta para'} ${+date.slice(8, 10)}`;
    }
    return { key: r.key, name: r.name, date, amount: Number(r.amount) || 0, why };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- resumo das telas ----------
const MERCHANT_LABEL = { uber: 'Uber', rge: 'Luz (RGE)' };
function merchantOf(t, rules) {
  const r = matchRule(t.title, rules);
  let key = r && r.category !== IGNORE && !/parcela/.test(r.keyword) ? normalize(r.keyword) : suggestKeyword(t.title);
  if (['ifd', '99food', 'rappi'].includes(key)) return { key: 'delivery', label: 'Delivery (iFood, 99Food)' };
  const label = MERCHANT_LABEL[key] || key.replace(/\b\p{L}/gu, c => c.toUpperCase());
  return { key, label };
}

// Mês que o ciclo "consome": o do vencimento da fatura (fatura de novembro → entradas e fixos de novembro).
export function monthOfCycle(cycle, settings) {
  return dueDateFor(cycle, primaryCard(settings)).slice(0, 7);
}

// Entradas do mês: o que já caiu (confirmado) ou o valor esperado, mais as avulsas (13º, freela…).
export function monthIncomes(settings, incomes, ym) {
  const [y, m] = ym.split('-').map(Number);
  const sched = incomeSchedule(settings.incomeRules, y, m);
  const inMonth = (incomes || []).filter(i => i.date.slice(0, 7) === ym);
  const items = sched.map(it => {
    const got = inMonth.find(i => i.rule_key === it.key);
    return { key: it.key, name: it.name, date: got ? got.date : it.date, amount: got ? Number(got.amount) : it.amount, expected: it.amount, received: !!got, id: got ? got.id : null, why: it.why };
  });
  for (const i of inMonth) if (!i.rule_key || !sched.some(s => s.key === i.rule_key)) items.push({ key: null, name: i.name, date: i.date, amount: Number(i.amount), received: true, extra: true, id: i.id });
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { items, total: round(items.reduce((s, i) => s + i.amount, 0)) };
}

// Liga cada fixo a um pagamento do mês: mesma rubrica e (nome na descrição, ou lançado à mão com valor parecido).
export function matchFixed(fixed, txs, ym) {
  const used = new Set();
  return (fixed || []).map((f, i) => {
    const value = Number(f.value) || 0;
    const name = normalize(f.name);
    const pool = txs.filter(t => !used.has(t) && t.cat === f.category && t.amount > 0);
    const hit = pool.find(t => t.uid && t.uid.startsWith(`fixed|${i}|`))
      || pool.find(t => name && normalize(t.title).includes(name))
      || pool.find(t => t.manual && Math.abs(t.amount - value) <= Math.max(2, value * 0.1));
    if (hit) used.add(hit);
    return { index: i, name: f.name, value, category: f.category, month: ym, paid: !!hit, paidAmount: hit ? Number(hit.amount) : 0, tx: hit || null };
  });
}

const txKey = t => t.id ?? t.uid;

export function summarize({ txs, rules, settings, cycle, today, incomes = [] }) {
  const cats = settings.categories || [];
  const totalDays = daysBetween(cycle.start, cycle.end) + 1;
  const isCurrent = today >= cycle.start && today <= cycle.end;
  const isPast = today > cycle.end;
  const elapsedDays = isPast ? totalDays : isCurrent ? daysBetween(cycle.start, today) + 1 : 0;
  const elapsed = elapsedDays / totalDays;
  const daysLeft = isCurrent ? daysBetween(today, cycle.end) + 1 : 0;
  const withCat = t => ({ ...t, cat: categoryOf(t, rules) });
  const monthTx = m => txs.filter(t => t.date.slice(0, 7) === m).map(withCat).filter(t => t.cat !== IGNORE);

  // o mês do ciclo (o do vencimento): as entradas e os fixos que esta fatura disputa
  const ym = monthOfCycle(cycle, settings);
  const fixedItems = matchFixed(settings.fixed, monthTx(ym), ym);

  // pagamentos de fixo contam no mês deles, não no ciclo em que a data caiu
  const fixedTx = new Set();
  for (const m of new Set([cycle.start.slice(0, 7), cycle.end.slice(0, 7)]))
    for (const f of matchFixed(settings.fixed, monthTx(m), m)) if (f.tx) fixedTx.add(txKey(f.tx));

  const inCycle = txs.filter(t => t.date >= cycle.start && t.date <= cycle.end).map(withCat)
    .map(t => (fixedTx.has(txKey(t)) ? { ...t, isFixed: true } : t));
  const counted = inCycle.filter(t => t.cat !== IGNORE && !t.isFixed);

  const spentBy = {};
  for (const t of counted) spentBy[t.cat] = (spentBy[t.cat] || 0) + Number(t.amount);

  const rows = cats.map(c => {
    const mine = fixedItems.filter(f => f.category === c.name);
    const linked = round(mine.reduce((s, f) => s + f.value, 0));
    const paidLinked = round(mine.reduce((s, f) => s + f.paidAmount, 0));
    const unpaidLinked = round(mine.filter(f => !f.paid).reduce((s, f) => s + f.value, 0));
    const varSpent = round(spentBy[c.name] || 0);
    const varBudget = Number(c.budget) || 0;
    const left = round(varBudget - varSpent);
    let status = 'ok';
    if (varSpent > varBudget + 0.005) status = 'over';
    else if (!c.fixed && isCurrent && varBudget > 0 && varSpent > varBudget * elapsed * 1.1) status = 'warn';
    const perWeek = (!c.fixed && isCurrent && varBudget > 0) ? round(Math.max(0, left) / Math.max(1, daysLeft / 7)) : null;
    let varProj = varSpent;
    if (isCurrent && elapsed > 0) varProj = c.fixed ? Math.max(varSpent, varBudget) : Math.max(varSpent / elapsed, varSpent + Math.max(0, varBudget - varSpent) * (1 - elapsed));
    const spent = round(varSpent + paidLinked);
    const budget = round(varBudget + linked);
    return { name: c.name, budget, varBudget, varSpent, linked, unpaidLinked, spent, left, status, perWeek,
      varProj: round(varProj), fixed: !!c.fixed, pct: budget > 0 ? spent / budget : (spent > 0 ? 1 : 0) };
  });

  const known = new Set(cats.map(c => c.name).concat([IGNORE]));
  const toClassify = inCycle.filter(t => !known.has(t.cat));
  const unclassifiedTotal = round(toClassify.reduce((s, t) => s + Number(t.amount), 0));

  const varSpent = round(counted.reduce((s, t) => s + Number(t.amount), 0));
  const varBudget = round(rows.reduce((s, r) => s + r.varBudget, 0));
  const fixedTotal = round(fixedItems.reduce((s, f) => s + f.value, 0));
  const fixedPaid = round(fixedItems.reduce((s, f) => s + f.paidAmount, 0));
  const fixedCost = round(fixedItems.reduce((s, f) => s + (f.paid ? f.paidAmount : f.value), 0)); // o que ainda não foi pago conta pelo valor previsto

  const inc = monthIncomes(settings, incomes, ym);
  const income = inc.total;

  let varProjected = varSpent;
  if (isCurrent && elapsed > 0) {
    const other = varSpent - rows.reduce((s, r) => s + r.varSpent, 0);   // sem categoria
    varProjected = round(rows.reduce((s, r) => s + r.varProj, 0) + other / elapsed);
  }

  // gasto variável acumulado dia a dia (gráfico do painel), comparado com a soma dos tetos
  const cumulative = [];
  let acc = 0;
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(cycle.start, i);
    acc += counted.filter(t => t.date === d).reduce((s, t) => s + Number(t.amount), 0);
    cumulative.push({ date: d, value: round(acc), future: d > today });
  }
  const overDay = cumulative.find(p => varBudget > 0 && p.value > varBudget);

  const bySource = {};
  for (const t of counted) bySource[t.source || 'nubank'] = round((bySource[t.source || 'nubank'] || 0) + Number(t.amount));

  const merch = {};
  for (const t of counted) {
    if (t.amount <= 0) continue;
    const m = merchantOf(t, rules);
    (merch[m.key] ||= { label: m.label, total: 0 });
    merch[m.key].total = round(merch[m.key].total + Number(t.amount));
  }
  const topMerchants = Object.values(merch).sort((a, b) => b.total - a.total).slice(0, 5);

  return {
    cycle, isCurrent, isPast, totalDays, elapsed, daysLeft, month: ym,
    rows, varSpent, varBudget, varProjected,
    spent: round(varSpent + fixedPaid), budget: round(varBudget + fixedTotal),
    projected: round(varProjected + fixedCost),
    income, incomeItems: inc.items,
    fixedItems, fixedTotal, fixedPaid, fixedCost,
    available: round(income - fixedCost),                 // o que sobra das entradas depois dos fixos
    leftover: round(income - fixedCost - varProjected),
    result: round(income - fixedCost - varSpent),
    overBudget: round(varSpent - varBudget),               // só a parte variável: fixo não "estoura teto"
    toClassify, unclassifiedTotal, txs: inCycle,
    cumulative, overDay, bySource, topMerchants,
  };
}

// Total gasto (sem ignorados) num ciclo — usado para comparar com a fatura anterior.
export function cycleTotal(txs, rules, cycle) {
  return round(txs.filter(t => t.date >= cycle.start && t.date <= cycle.end && categoryOf(t, rules) !== IGNORE)
    .reduce((s, t) => s + Number(t.amount), 0));
}

// Gera as linhas de um gasto parcelado lançado à mão.
export function installmentRows({ date, title, amount, n, source, category }) {
  n = Math.max(1, n | 0);
  const cents = Math.round(amount * 100), base = Math.floor(cents / n);
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  return Array.from({ length: n }, (_, i) => ({
    date: addMonths(date, i),
    title: n > 1 ? `${title} - Parcela ${i + 1}/${n}` : title,
    amount: (i === n - 1 ? cents - base * (n - 1) : base) / 100,
    source, category: category || null, manual: true,
    uid: `manual|${stamp}|${i + 1}`,
  }));
}
