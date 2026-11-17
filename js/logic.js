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
    { id: 'nubank', name: 'Nubank', closing: 3, due: 10, color: '#820AD1', primary: true },
    { id: 'inter', name: 'Inter', closing: null, due: null, color: '#FF7A00', primary: false },
  ],
  version: 4,
  // contas: [{ id, name, kind: 'exact'|'estimate', value, day, category, pay, match, basis, parcels: { total, current, ym } | null }]
  // pay = 'pix' | 'boleto' | 'debito' | 'dinheiro' | id de um cartão (aí ela já entra pela fatura)
  fixed: [],
  hiddenCards: [],        // cartões escondidos no Início
  balance: null,          // { value, date }: saldo na conta, para a agenda do dinheiro
  incomeRules: [
    { key: 'vintena', name: 'Vintena', type: 'day', day: 20, shift: 'before', amount: 0, monthOffset: 0 },
    { key: 'salario', name: 'Salário', type: 'businessDay', n: 5, amount: 0, monthOffset: 1 },
  ],
  reserveMonths: 6,
  aporteGoal: 0,
  // limite do gasto variável no mês: null = automático (entradas − contas − meta de aporte)
  varLimit: null,
  oneOff: [],             // uids de compras pontuais: contam no gasto, mas não no ritmo nem na média
  // as rubricas da planilha; teto por rubrica é opcional (0 = sem teto, compara com a média)
  categories: [
    { name: 'Alimentação', budget: 0, fixed: false },
    { name: 'Mercado', budget: 0, fixed: false },
    { name: 'Bem-Estar e Saúde', budget: 0, fixed: false },
    { name: 'Casa', budget: 0, fixed: true },
    { name: 'Despesas Pessoais', budget: 0, fixed: false },
    { name: 'Educação', budget: 0, fixed: true },
    { name: 'Lazer e Entretenimento', budget: 0, fixed: false },
    { name: 'Pequenos gastos', budget: 0, fixed: false },
    { name: 'Transporte', budget: 0, fixed: false },
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
  // v3: contas ganham tipo, forma de pagamento e parcelas; cores reais dos cartões
  const OLD_COLORS = { nubank: '#9085e9', inter: '#d95926' };
  s.cards = s.cards.map(c => (OLD_COLORS[c.id] && c.color === OLD_COLORS[c.id] ? { ...c, color: DEFAULT_SETTINGS.cards.find(d => d.id === c.id).color } : c));
  s.fixed = (s.fixed || []).map((f, i) => ({
    id: f.id || 'c' + i + '-' + slug(f.name || 'conta').slice(0, 12),
    name: f.name || '', kind: f.kind || 'exact', value: Number(f.value) || 0, day: f.day ?? null,
    category: f.category || fixedCategoryGuess(f.name), pay: f.pay || 'pix', match: f.match || '',
    basis: f.basis || 'avg', parcels: f.parcels || null,
  }));
  if (!Array.isArray(s.hiddenCards)) s.hiddenCards = [];
  // salário cai no mês seguinte ao de referência; as demais entradas, no próprio mês
  s.incomeRules = (s.incomeRules || []).map(r => (r.monthOffset == null ? { ...r, monthOffset: r.key === 'salario' ? 1 : 0 } : r));
  // v4: sai o teto por rubrica, entra um limite único para o variável (teto por rubrica vira opcional)
  if ((Number(s.version) || 0) < 4) {
    s.categories = (s.categories || []).map(c => ({ ...c, budget: 0 }));
    s.varLimit = null;
    s.version = 4;
  }
  if (s.varLimit != null && !(Number(s.varLimit) >= 0)) s.varLimit = null;
  if (!Array.isArray(s.oneOff)) s.oneOff = [];
  // rubricas essenciais (o mínimo do modo contenção): por padrão Mercado e Transporte
  s.categories = (s.categories || []).map(c => (c.essential == null ? { ...c, essential: /^(mercado|transporte)$/i.test(normalize(c.name)) } : c));
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

// Nome legível para a lista de gastos ("Ifd*Vm Pizzaria e Hamb" → "iFood · Vm Pizzaria e Hamb").
const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'em', 'na', 'no']);
const titleCase = s => s.toLowerCase().split(' ').map((w, i) => (i > 0 && SMALL.has(w)) ? w : w.replace(/^\p{L}/u, c => c.toUpperCase())).join(' ');
export function prettyTitle(title) {
  let t = String(title || '').replace(/\s+/g, ' ').trim();
  let part = '';
  const pm = t.match(/\s*-\s*parcela\s*(\d+\/\d+)\s*$/i);
  if (pm) { part = ` · ${pm[1]}`; t = t.slice(0, pm.index); }
  t = t.replace(/^pix no cr[eé]dito\s*-\s*/i, '');
  const n = normalize(t);
  if (/^dl\s*\*?\s*uber|^uber\b|uberrides|uber \*trip/.test(n)) return (/eats/.test(n) ? 'Uber Eats' : /one/.test(n) ? 'Uber One' : 'Uber') + part;
  if (/^99\s*app|^99 ?pop|^99\*/.test(n) && !/food/.test(n)) return '99' + part;
  let prefix = '';
  if (/^ifd\s*\*\s*ifood/.test(n)) return 'iFood Club' + part;
  if (/^ru unisinos/.test(n)) return 'RU Unisinos' + part;
  if (/^ifd\s*\*/.test(n)) { prefix = 'iFood · '; t = t.replace(/^ifd\s*\*\s*/i, ''); }
  else if (/^99food/.test(n)) { prefix = '99Food · '; t = t.replace(/^99food\s*\*?\s*/i, ''); }
  else t = t.replace(/^(dl|ec|mp|pg|zp|app|ebn|pag|pp|sumup|stone|jim\.com|mercadopago|picpay)\s*\*\s*/i, '');
  t = t.replace(/\b(comercio|com\.?) de (alim(entos)?|alimen\w*)\b/ig, '')
    .replace(/\b(ltda|eireli|me|epp|s\.?a\.?)\.?$/i, '').replace(/\s+\d{3,}$/, '').replace(/[*_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return (prefix ? prefix.replace(' · ', '') : String(title)) + part;
  const cased = /[a-z]/.test(t) && /[A-Z]/.test(t.slice(1)) && !/^[A-Z][a-z]/.test(t) ? t : titleCase(t);
  return prefix + cased + part;
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
  const iP = header.findIndex(h => h === 'tipo' || h === 'parcela' || h === 'parcelas');

  let rows = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const cols = splitCSVLine(line, sep);
    const date = toISODate(cols[iD]);
    let title = String(cols[iT] ?? '').trim();
    const pm = iP >= 0 && String(cols[iP] ?? '').match(/(\d+)\s*(?:de|\/)\s*(\d+)/i);
    if (pm && !/parcela \d+\/\d+/i.test(title) && Number(pm[2]) > 1) title += ` - Parcela ${Number(pm[1])}/${Number(pm[2])}`;
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

// Compras no cartão lançadas à mão durante a semana que a fatura agora traz de verdade.
// Mesmo cartão, mesmo valor, até 3 dias de diferença; cada lançamento à mão casa com uma linha só.
// A linha da fatura fica (descrição e data reais) e o lançamento à mão sai, levando a rubrica escolhida.
export function matchManual(fresh, existing, source) {
  const pool = existing.filter(t => t.manual && (t.source || 'nubank') === source);
  const parc = title => (String(title).match(PARC_RE) || []).slice(1, 3).join('/');
  const pairs = [];
  for (const r of fresh) {
    let best = -1, bestGap = 99;
    pool.forEach((t, i) => {
      if (Math.abs(Number(t.amount) - Number(r.amount)) >= 0.005) return;
      if (parc(t.title) !== parc(r.title)) return;
      const gap = Math.abs(daysBetween(t.date, r.date));
      if (gap <= 3 && gap < bestGap) { best = i; bestGap = gap; }
    });
    if (best >= 0) { pairs.push({ row: r, manual: pool[best] }); pool.splice(best, 1); }
  }
  return pairs;
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

// Competência do ciclo: o mês em que ele começa (ciclo 3/10–2/11 = outubro, paga com a vintena de
// outubro e o salário do 5º dia útil de novembro, na fatura que vence em 10/11).
export function monthOfCycle(cycle) {
  return cycle.start.slice(0, 7);
}
const ymShift = (ym, n) => addMonths(`${ym}-01`, n).slice(0, 7);
// Mês em que cada entrada fixa da competência ym cai (salário = mês seguinte).
export const incomeMonthFor = (rule, ym) => ymShift(ym, Number(rule.monthOffset) || 0);

// Entradas da competência: o que já caiu (confirmado) ou o valor esperado, mais as avulsas do mês (13º, freela…).
export function monthIncomes(settings, incomes, ym) {
  const items = (settings.incomeRules || []).map(r => {
    const target = incomeMonthFor(r, ym);
    const [y, m] = target.split('-').map(Number);
    const it = incomeSchedule([r], y, m)[0];
    const got = (incomes || []).find(i => i.rule_key === r.key && i.date.slice(0, 7) === target);
    return { key: r.key, name: r.name, date: got ? got.date : it.date, amount: got ? Number(got.amount) : it.amount, expected: it.amount,
      received: !!got, id: got ? got.id : null, why: it.why, target };
  });
  const keys = new Set((settings.incomeRules || []).map(r => r.key));
  for (const i of incomes || []) if (i.date.slice(0, 7) === ym && (!i.rule_key || !keys.has(i.rule_key)))
    items.push({ key: null, name: i.name, date: i.date, amount: Number(i.amount), received: true, extra: true, id: i.id });
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { items, total: round(items.reduce((s, i) => s + i.amount, 0)) };
}

// Liga cada fixo a um pagamento do mês: mesma rubrica e (nome na descrição, ou lançado à mão com valor parecido).
export function matchFixed(fixed, txs, ym) {
  const used = new Set();
  return (fixed || []).map((f, j) => {
    const i = f.index ?? j;
    const value = Number(f.value) || 0;
    const name = normalize(f.match || f.name);
    const pool = txs.filter(t => !used.has(t) && t.cat === f.category && t.amount > 0);
    const hit = pool.find(t => t.uid && t.uid.startsWith(`fixed|${i}|${ym}|`))
      || pool.find(t => name && normalize(t.title).includes(name))
      || pool.find(t => t.manual && Math.abs(t.amount - value) <= Math.max(2, value * 0.1));
    if (hit) used.add(hit);
    return { index: i, name: f.name, value, category: f.category, month: ym, paid: !!hit, paidAmount: hit ? Number(hit.amount) : 0, tx: hit || null };
  });
}

const txKey = t => t.id ?? t.uid;

// Em qual ciclo do app uma compra entra. Cartão principal: pela data. Outro cartão com fechamento
// informado: pela fatura dele — a compra entra no ciclo em que a fatura daquele cartão fecha
// (ex.: Inter de 31/10, na fatura que fecha em novembro, conta no ciclo de novembro do Nubank).
export function billingDate(t, settings) {
  const src = t.source || 'nubank';
  const prim = primaryCard(settings);
  if (src === prim.id) return t.date;
  const c = (settings.cards || []).find(x => x.id === src);
  if (!c || !c.closing) return t.date;
  return cycleFor(t.date, c.closing).end;
}
export const inCycleOf = (t, cycle, settings) => { const b = billingDate(t, settings); return b >= cycle.start && b <= cycle.end; };

export function summarize({ txs, rules, settings, cycle, today, incomes = [], avg = null }) {
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
  const ym = monthOfCycle(cycle);
  const fixedItems = matchFixed(billsOut(settings, ym, txs, rules), monthTx(ym), ym);

  // pagamentos de fixo contam no mês deles, não no ciclo em que a data caiu
  const fixedTx = new Set();
  for (const m of new Set([cycle.start.slice(0, 7), cycle.end.slice(0, 7)]))
    for (const f of matchFixed(billsOut(settings, m, txs, rules), monthTx(m), m)) if (f.tx) fixedTx.add(txKey(f.tx));

  const commits = cardCommitments({ txs, rules, settings, cycle, today });
  const oneOff = new Set(settings.oneOff || []);
  // day: o dia em que a compra pesa no ciclo (a data real, ou o 1º dia do ciclo se veio de antes por outro cartão)
  const inCycle = txs.filter(t => inCycleOf(t, cycle, settings)).map(withCat)
    .map(t => ({ ...t, day: t.date < cycle.start ? cycle.start : t.date > cycle.end ? cycle.end : t.date, ...(oneOff.has(t.uid) ? { oneOff: true } : {}) }))
    .map(t => (fixedTx.has(txKey(t)) ? { ...t, isFixed: true } : commits.kinds.has(txKey(t)) ? { ...t, commit: commits.kinds.get(txKey(t)) } : t));
  const counted = inCycle.filter(t => t.cat !== IGNORE && !t.isFixed);

  const spentBy = {}, freeBy = {}, paceBy = {};
  for (const t of counted) {
    spentBy[t.cat] = (spentBy[t.cat] || 0) + Number(t.amount);
    if (!t.commit) freeBy[t.cat] = (freeBy[t.cat] || 0) + Number(t.amount);
    if (!t.commit && !t.oneOff) paceBy[t.cat] = (paceBy[t.cat] || 0) + Number(t.amount);
  }

  const rows = cats.map(c => {
    const mine = fixedItems.filter(f => f.category === c.name);
    const linked = round(mine.reduce((s, f) => s + f.value, 0));
    const paidLinked = round(mine.reduce((s, f) => s + f.paidAmount, 0));
    const unpaidLinked = round(mine.filter(f => !f.paid).reduce((s, f) => s + f.value, 0));
    const varSpent = round(spentBy[c.name] || 0);
    const freeSpent = round(freeBy[c.name] || 0);     // sem parcelas e assinaturas: o que se decide no dia a dia
    const paceSpent = round(paceBy[c.name] || 0);     // e sem compras pontuais: o que se repete
    const varBudget = Number(c.budget) || 0;          // teto opcional
    const left = varBudget > 0 ? round(varBudget - varSpent) : null;
    const average = avg && avg[c.name] > 0 ? avg[c.name] : 0;
    // comparação com a média: no ciclo atual, contra o que você costuma ter gasto até este ponto; nos fechados, contra o ciclo inteiro
    const expected = average > 0 ? round(isPast ? average : average * elapsed) : 0;
    const vsAvg = expected > 0 && !c.fixed && (isPast || (isCurrent && elapsed >= 0.2)) ? Math.round((paceSpent / expected - 1) * 100) / 100 : null;
    let status = 'ok';
    if (varBudget > 0 && varSpent > varBudget + 0.005) status = 'over';
    else if (!c.fixed && isCurrent && varBudget > 0 && varSpent > varBudget * elapsed * 1.1) status = 'warn';
    else if (vsAvg != null && paceSpent - expected > 30 && vsAvg >= 0.25) status = 'above';
    const perWeek = (!c.fixed && isCurrent && varBudget > 0) ? round(Math.max(0, left) / Math.max(1, daysLeft / 7)) : null;
    const spent = round(varSpent + paidLinked);
    const budget = round(varBudget + linked);
    return { name: c.name, budget, varBudget, varSpent, freeSpent, paceSpent, essential: !!c.essential, linked, unpaidLinked, spent, left, status, perWeek, avg: average, expected, vsAvg,
      fixed: !!c.fixed, pct: budget > 0 ? spent / budget : (spent > 0 ? 1 : 0) };
  });

  const known = new Set(cats.map(c => c.name).concat([IGNORE]));
  const toClassify = inCycle.filter(t => !known.has(t.cat));
  const unclassifiedTotal = round(toClassify.reduce((s, t) => s + Number(t.amount), 0));

  const varSpent = round(counted.reduce((s, t) => s + Number(t.amount), 0));
  const fixedTotal = round(fixedItems.reduce((s, f) => s + f.value, 0));
  const fixedPaid = round(fixedItems.reduce((s, f) => s + f.paidAmount, 0));
  const fixedCost = round(fixedItems.reduce((s, f) => s + (f.paid ? f.paidAmount : f.value), 0)); // o que ainda não foi pago conta pelo valor previsto

  const inc = monthIncomes(settings, incomes, ym);
  const income = inc.total;

  // limite único do variável: o que você definiu, ou o que sobra das entradas depois das contas e da meta de aporte
  const manual = settings.varLimit != null && Number(settings.varLimit) > 0;
  const autoLimit = round(income - fixedCost - (Number(settings.aporteGoal) || 0));
  const varBudget = manual ? round(Number(settings.varLimit)) : income > 0 ? Math.max(0, autoLimit) : 0;
  const limitMode = manual ? 'manual' : income > 0 ? 'auto' : 'none';

  // compromissos do cartão (parcelas e assinaturas) saem do limite de início; o resto é o livre do dia a dia
  const committed = commits.total;
  const freeBudget = varBudget > 0 ? round(Math.max(0, varBudget - committed)) : 0;
  const freeSpent = round(varSpent - commits.actualTotal);
  const oneOffSpent = round(counted.filter(t => t.oneOff && !t.commit).reduce((a, t) => a + Number(t.amount), 0));

  // projeção: compromissos + o dia a dia no ritmo dele. Na 1ª semana o ritmo ainda não diz nada: usa o plano.
  let varProjected = varSpent;
  if (isCurrent) {
    const repeats = freeSpent - oneOffSpent;            // o que se repete; compras pontuais entram uma vez só
    const pace = elapsedDays >= 7 ? repeats / elapsedDays * totalDays + oneOffSpent : Math.max(freeSpent, freeBudget || repeats / Math.max(1, elapsedDays) * totalDays + oneOffSpent);
    varProjected = round(committed + Math.max(freeSpent, pace));
  } else if (!isPast) varProjected = round(committed + freeBudget);
  const planProjected = round(committed + Math.max(freeSpent, freeBudget));   // se seguir as semanas
  const varLeft = round(Math.max(0, freeBudget - freeSpent));

  // gasto variável acumulado dia a dia (gráfico do painel), comparado com o limite
  const cumulative = [], cumFree = [];
  let acc = 0, accF = 0;
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(cycle.start, i);
    for (const t of counted) if (t.day === d) { acc += Number(t.amount); if (!t.commit) accF += Number(t.amount); }
    cumulative.push({ date: d, value: round(acc), future: d > today });
    cumFree.push({ date: d, value: round(accF), future: d > today });
  }
  const overDay = cumulative.find(p => varBudget > 0 && p.value > varBudget);
  const weeks = weekPlan({ cycle, today, varBudget: freeBudget, cumulative: cumFree });
  // modo contenção: o limite do mês acabou, mas comer e se deslocar continuam. A semana passa a liberar
  // só o essencial (média das rubricas essenciais por ciclo, proporcional aos dias).
  let containment = null;
  if (isCurrent && freeBudget > 0 && freeSpent > freeBudget) {
    const essCats = cats.filter(c => c.essential).map(c => c.name);
    const essAvg = avg ? essCats.reduce((a, n) => a + (avg[n] || 0), 0) : 0;
    const perDayEss = essAvg > 0 ? essAvg / totalDays : freeBudget / totalDays * 0.5;
    containment = { cats: essCats, perWeek: round(perDayEss * 7), fromAvg: essAvg > 0 };
    for (const w of weeks) {
      if (w.status === 'past') continue;
      w.limit = round(perDayEss * w.days); w.left = round(w.limit - w.spent); w.containment = true;
      if (w.status === 'now') w.perDay = round(Math.max(0, w.left) / w.daysLeft);
    }
  }

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
    // saldo previsto do mês com o que já se sabe: entradas − contas − cartões até agora − parcelas/assinaturas que ainda vêm
    balance: round(income - fixedCost - varSpent - (isPast ? 0 : commits.pendingTotal)),
    overBudget: round(varSpent - varBudget),               // só a parte variável: fixo não "estoura teto"
    toClassify, unclassifiedTotal, txs: inCycle,
    cumulative, overDay, bySource, topMerchants, weeks, containment, oneOffSpent, week: weeks.find(w => w.status === 'now') || null,
    // quanto ainda cabe por dia nas rubricas variáveis (o que estourou não "empresta" das outras)
    limitMode, autoLimit,
    commits, committed, freeBudget, freeSpent, planProjected,
    varLeft,
    perDay: isCurrent && varBudget > 0 ? round(varLeft / Math.max(1, daysLeft)) : null,
  };
}

// Compromissos do cartão num ciclo: parcelas (da 2ª em diante: a 1ª é a compra, decidida naquela semana)
// e assinaturas (mesma loja, uma vez por ciclo, valor parecido em pelo menos 2 dos 3 ciclos anteriores).
// Eles já estavam decididos antes do ciclo começar, então saem do limite logo de início e não pesam na semana.
const parcOf = t => { const m = String(t.title || '').match(PARC_RE); return m ? { k: +m[1], n: +m[2], base: normalize(String(t.title).replace(PARC_RE, '')) } : null; };
function recurringIn(txs, rules, settings, cycle) {
  const closing = primaryCard(settings).closing || 1;
  const cards = new Set(settings.cards.map(c => c.id));
  const cardTx = c => txs.filter(t => inCycleOf(t, c, settings) && Number(t.amount) > 0 && cards.has(t.source || 'nubank') && categoryOf(t, rules) !== IGNORE);
  const keyOf = t => merchantOf(t, rules).key;
  const byKey = list => { const m = {}; for (const t of list) if (!parcOf(t)) (m[keyOf(t)] ||= []).push(t); return m; };
  const cur = cardTx(cycle);
  const curBy = byKey(cur);
  const prevBy = [1, 2, 3].map(i => byKey(cardTx(shiftCycle(cycle.start, -i, closing))));
  const kind = new Map();
  for (const t of cur) {
    const p = parcOf(t);
    if (p) { if (p.k >= 2) kind.set(txKey(t), 'parcela'); continue; }
    const k = keyOf(t);
    if (curBy[k].length !== 1) continue;
    const near = x => Math.abs(Number(x.amount) - Number(t.amount)) <= Math.max(2, Number(t.amount) * 0.15);
    const hits = prevBy.filter(m => m[k] && m[k].length <= 2 && m[k].some(near)).length;
    if (hits >= 2) kind.set(txKey(t), 'assinatura');
  }
  return { cur, curBy, kind, keyOf };
}
export function cardCommitments({ txs, rules, settings, cycle, today }) {
  const now = recurringIn(txs, rules, settings, cycle);
  const actual = now.cur.filter(t => now.kind.has(txKey(t))).map(t => ({ title: t.title, amount: round(Number(t.amount)), kind: now.kind.get(txKey(t)), date: t.date, key: txKey(t) }));
  const pending = [];
  if (today <= cycle.end) {
    // o que veio no ciclo anterior e ainda deve vir neste
    const prevC = shiftCycle(cycle.start, -1, primaryCard(settings).closing || 1);
    const prev = recurringIn(txs, rules, settings, prevC);
    for (const t of prev.cur) {
      const kd = prev.kind.get(txKey(t)) || (parcOf(t) && parcOf(t).k === 1 && parcOf(t).n > 1 ? 'parcela' : null);
      if (!kd) continue;
      const p = parcOf(t);
      if (p) {
        if (p.k >= p.n) continue;
        const came = now.cur.some(x => { const q = parcOf(x); return q && q.base === p.base && q.k === p.k + 1; });
        if (!came) pending.push({ title: String(t.title).replace(PARC_RE, '') + ` - Parcela ${p.k + 1}/${p.n}`, amount: round(Number(t.amount)), kind: 'parcela', pending: true });
      } else if (!now.curBy[prev.keyOf(t)]) {
        pending.push({ title: t.title, amount: round(Number(t.amount)), kind: 'assinatura', pending: true });
      }
    }
  }
  const sum = l => round(l.reduce((a, x) => a + x.amount, 0));
  return { actual, pending, kinds: now.kind, actualTotal: sum(actual), pendingTotal: sum(pending), total: round(sum(actual) + sum(pending)) };
}

// Semanas de segunda a domingo dentro do ciclo (as das pontas ficam incompletas).
export function cycleWeeks(cycle) {
  const out = [];
  for (let d = cycle.start; d <= cycle.end;) {
    const dow = (new Date(parseISO(d)).getUTCDay() + 6) % 7;       // 0 = segunda
    let e = addDays(d, 6 - dow);
    if (e > cycle.end) e = cycle.end;
    out.push({ start: d, end: e, days: daysBetween(d, e) + 1 });
    d = addDays(e, 1);
  }
  return out;
}

// Quanto cada semana libera: no início de cada semana, o que resta do limite é dividido pelos dias
// que faltam no ciclo. O que uma semana passa sai das seguintes; o que sobra, vai para elas.
// As semanas futuras assumem que a atual gasta o liberado (ou o que já gastou, se passou).
export function weekPlan({ cycle, today, varBudget, cumulative }) {
  const ws = cycleWeeks(cycle);
  if (!(varBudget > 0)) return ws.map(w => ({ ...w, limit: null, spent: 0, status: w.end < today ? 'past' : w.start > today ? 'next' : 'now' }));
  const cumAt = d => { let v = 0; for (const p of cumulative) { if (p.date > d) break; v = p.value; } return v; };
  const before = d => (d <= cycle.start ? 0 : cumAt(addDays(d, -1)));
  const daily = d => round(cumAt(d) - before(d));
  let futureRate = null;
  const out = [];
  for (const w of ws) {
    const status = w.end < today ? 'past' : w.start > today ? 'next' : 'now';
    let limit;
    if (status === 'next' && futureRate != null) limit = round(futureRate * w.days);
    else if (status === 'next') { futureRate = Math.max(0, varBudget - before(w.start)) / (daysBetween(w.start, cycle.end) + 1); limit = round(futureRate * w.days); }
    else limit = round(Math.max(0, varBudget - before(w.start)) * w.days / (daysBetween(w.start, cycle.end) + 1));
    const spent = status === 'next' ? 0 : round(cumAt(w.end < today ? w.end : today) - before(w.start));
    const row = { ...w, status, limit, spent, left: round(limit - spent), days7: [] };
    for (let i = 0; i < w.days; i++) { const d = addDays(w.start, i); row.days7.push({ date: d, value: d > today ? 0 : daily(d), future: d > today }); }
    if (status === 'now') {
      row.daysLeft = daysBetween(today, w.end) + 1;
      row.perDay = round(Math.max(0, row.left) / row.daysLeft);
      const after = daysBetween(w.end, cycle.end);
      futureRate = after > 0 ? Math.max(0, varBudget - before(w.start) - Math.max(limit, spent)) / after : 0;
    }
    out.push(row);
  }
  return out;
}

// Média do gasto variável por rubrica nos últimos ciclos fechados que têm compras.
export function averageByCategory({ txs, rules, settings, incomes, today, cycles = 3 }) {
  const closing = primaryCard(settings).closing || 1;
  let c = shiftCycle(cycleFor(today, closing).start, -1, closing);
  const used = [];
  for (let i = 0; i < 12 && used.length < cycles; i++, c = shiftCycle(c.start, -1, closing)) {
    const s = summarize({ txs, rules, settings, cycle: c, today, incomes });
    if (s.varSpent > 0) used.push(s);
  }
  const out = {};
  for (const cat of settings.categories || []) {
    const vals = used.map(s => (s.rows.find(r => r.name === cat.name) || { paceSpent: 0 }).paceSpent);
    out[cat.name] = vals.length ? round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  }
  return { cycles: used.map(s => s.cycle), avg: out };
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

// ---------- contas (exatas e estimadas) ----------
const ymOf = iso => iso.slice(0, 7);
export function ymDiff(a, b) {
  const [ay, am] = a.split('-').map(Number), [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}
export const ymAdd = (ym, n) => addMonths(`${ym}-01`, n).slice(0, 7);
export const isCardPay = (b, settings) => settings.cards.some(c => c.id === b.pay);

// Parcela de uma conta no mês ym (null = sem parcelas, repete todo mês).
export function billParcel(b, ym) {
  const p = b.parcels;
  if (!p || !Number(p.total)) return null;
  const total = Number(p.total), n = Number(p.current || 1) + ymDiff(p.ym || ym, ym);
  return { n, total, active: n >= 1 && n <= total, endYM: ymAdd(p.ym || ym, total - Number(p.current || 1)) };
}

// Pagamentos que parecem desta conta nos meses anteriores a ym (para a média das estimadas).
export function billHistory(b, txs, rules, ym, months = 3) {
  const kw = normalize(b.match || b.name);
  if (!kw) return [];
  const byMonth = {};
  const lo = ymAdd(ym, -12);
  for (const t of txs) {
    const m = ymOf(t.date);
    if (m >= ym || m < lo || Number(t.amount) <= 0) continue;
    if (!normalize(t.title).includes(kw) && !normalize(prettyTitle(t.title)).includes(kw)) continue;
    if (categoryOf(t, rules) === IGNORE) continue;
    byMonth[m] = round((byMonth[m] || 0) + Number(t.amount));
  }
  return Object.keys(byMonth).sort().slice(-months).map(m => ({ ym: m, value: byMonth[m] }));
}

export function billValueFor(b, ym, txs, rules) {
  if (b.kind === 'estimate') {
    const h = billHistory(b, txs, rules, ym);
    if (h.length) {
      const v = h.map(x => x.value);
      return round(b.basis === 'max' ? Math.max(...v) : v.reduce((a, c) => a + c, 0) / v.length);
    }
  }
  return Number(b.value) || 0;
}

// Contas ativas no mês ym, com o valor do mês.
export function billsFor(settings, ym, txs, rules) {
  return (settings.fixed || []).map((b, index) => ({ ...b, index, parcel: billParcel(b, ym) }))
    .filter(b => !b.parcel || b.parcel.active)
    .map(b => ({
      ...b,
      value: billValueFor(b, ym, txs, rules),
      history: b.kind === 'estimate' ? billHistory(b, txs, rules, ym) : [],
      onCard: isCardPay(b, settings),
    }));
}
// As que saem da conta (fora do cartão): entram no mês como "fixos".
export function billsOut(settings, ym, txs, rules) {
  return billsFor(settings, ym, txs, rules).filter(b => !b.onCard);
}

// Compras parceladas no cartão ("Parcela 3/5") projetadas para o mês ym.
// A parcela pertence à fatura em que ela apareceu: a do lote de envio (mesmo created_at), não a da data da compra.
const PARC_RE = /\s*-\s*parcela\s*(\d+)\s*\/\s*(\d+)\s*$/i;
export function cardInstallments(txs, rules, settings, ym) {
  const prim = primaryCard(settings);
  const closingOf = src => (settings.cards.find(c => c.id === src) || prim).closing || prim.closing || 1;
  const batchMax = {};
  for (const t of txs) {
    if (t.manual || !t.created_at) continue;
    const k = (t.source || 'nubank') + '|' + t.created_at.slice(0, 16);
    if (!batchMax[k] || t.date > batchMax[k]) batchMax[k] = t.date;
  }
  const series = new Map();
  for (const t of txs) {
    if (t.manual) continue;
    const m = String(t.title).match(PARC_RE);
    if (!m) continue;
    const k = +m[1], n = +m[2];
    if (!(n > 1)) continue;
    const src = t.source || 'nubank';
    const anchor = (t.created_at && batchMax[src + '|' + t.created_at.slice(0, 16)]) || t.date;
    const anchorYM = monthOfCycle(cycleFor(anchor, closingOf(src)));
    const base = normalize(t.title.slice(0, m.index));
    const key = `${src}|${base}|${n}|${Number(t.amount).toFixed(2)}`;
    const first = ymAdd(anchorYM, -(k - 1));
    const cur = series.get(key);
    if (!cur || first > cur.first) series.set(key, { t, n, first, src });
  }
  const out = [];
  for (const s of series.values()) {
    const k = ymDiff(s.first, ym) + 1;
    if (k < 1 || k > s.n) continue;
    out.push({
      id: 'auto-' + slug(s.t.title).slice(0, 30), auto: true, kind: 'exact',
      name: prettyTitle(s.t.title.replace(PARC_RE, '')), value: round(Number(s.t.amount)),
      category: categoryOf(s.t, rules), pay: s.src, onCard: true,
      parcel: { n: k, total: s.n, active: true, endYM: ymAdd(s.first, s.n - 1) },
    });
  }
  return out;
}

// Quanto o mês ym já começa comprometido, e se os tetos cabem no que sobra.
export function monthPlan({ settings, txs, rules, incomes, ym }) {
  const bills = billsFor(settings, ym, txs, rules);
  const named = bills.filter(b => b.onCard).map(b => normalize(b.match || b.name));
  const auto = cardInstallments(txs, rules, settings, ym).filter(a => !named.some(k => k && normalize(a.name).includes(k)));
  const all = [...bills, ...auto];
  const sum = l => round(l.reduce((a, b) => a + (Number(b.value) || 0), 0));
  const exact = all.filter(b => b.kind !== 'estimate'), est = all.filter(b => b.kind === 'estimate');
  const exactOut = sum(exact.filter(b => !b.onCard)), estOut = sum(est.filter(b => !b.onCard)), onCard = sum(all.filter(b => b.onCard));
  const income = monthIncomes(settings, incomes, ym).total;
  const committed = round(exactOut + estOut + onCard);
  const free = round(income - committed);
  const aporte = Number(settings.aporteGoal) || 0;
  const forVar = round(free - aporte);                       // o que dá para gastar variando, já guardando o aporte
  const manual = settings.varLimit != null && Number(settings.varLimit) > 0 ? round(Number(settings.varLimit)) : null;
  return { ym, exact, est, all, exactOut, estOut, onCard, income, committed, free, aporte, forVar, manual,
    slack: manual != null ? round(forVar - manual) : forVar };
}

// Fatura aberta de cada cartão.
export function cardInvoices(settings, txs, rules, today) {
  const prim = primaryCard(settings);
  return settings.cards.map(c => {
    const conf = !!c.closing;
    const ref = conf ? c : prim;
    const closing = ref.closing || 1;
    const cycle = cycleFor(today, closing);
    const due = dueDateFor(cycle, { closing, due: (conf ? c.due : prim.due) || 10 });
    const sumOf = cy => round(txs.filter(t => (t.source || 'nubank') === c.id && t.date >= cy.start && t.date <= cy.end && categoryOf(t, rules) !== IGNORE)
      .reduce((a, t) => a + Number(t.amount), 0));
    const prev = shiftCycle(cycle.start, -1, closing);
    const prevDue = dueDateFor(prev, { closing, due: (conf ? c.due : prim.due) || 10 });
    return {
      card: c, configured: conf, cycle, due, total: sumOf(cycle),
      len: daysBetween(cycle.start, cycle.end) + 1, elapsed: daysBetween(cycle.start, today) + 1,
      daysToClose: daysBetween(today, cycle.end) + 1,
      prev: { cycle: prev, due: prevDue, total: sumOf(prev), unpaid: today <= prevDue },
    };
  });
}

// Agenda do dinheiro: o que entra e sai da conta corrente nas próximas semanas, com o saldo depois de cada dia.
export function moneyAgenda({ settings, txs, rules, incomes, today, days = 35, primaryProjection = null }) {
  const end = addDays(today, days);
  const ev = [];
  const inWin = d => d >= today && d <= end;
  // entradas fixas ainda não recebidas
  for (let k = 0; k <= 1; k++) {
    const ym = ymAdd(ymOf(today), k);
    const [y, m] = ym.split('-').map(Number);
    for (const it of incomeSchedule(settings.incomeRules, y, m)) {
      if (!inWin(it.date) || !(it.amount > 0)) continue;
      if ((incomes || []).some(i => i.rule_key === it.key && ymOf(i.date) === ym)) continue;
      ev.push({ date: it.date, kind: 'in', title: it.name, sub: 'entrada · ' + it.why, amount: it.amount });
    }
  }
  // contas que saem da conta
  for (let k = 0; k <= 1; k++) {
    const ym = ymAdd(ymOf(today), k);
    const matched = matchFixed(billsOut(settings, ym, txs, rules), txs.filter(t => ymOf(t.date) === ym).map(t => ({ ...t, cat: categoryOf(t, rules) })), ym);
    for (const b of billsOut(settings, ym, txs, rules)) {
      if (!b.day) continue;
      const last = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
      const date = `${ym}-${String(Math.min(b.day, last)).padStart(2, '0')}`;
      if (!inWin(date) || matched.find(f => f.index === b.index && f.paid)) continue;
      const p = b.parcel ? ` · parcela ${b.parcel.n} de ${b.parcel.total}` : '';
      ev.push({ date, kind: 'out', title: b.name, sub: (b.kind === 'estimate' ? 'conta estimada' : 'conta') + p, amount: -b.value, bill: { index: b.index, ym } });
    }
  }
  // faturas dos cartões
  for (const inv of cardInvoices(settings, txs, rules, today)) {
    const name = inv.card.name;
    if (inv.prev.unpaid && inv.prev.total > 0 && inWin(inv.prev.due))
      ev.push({ date: inv.prev.due, kind: 'out', title: `Fatura ${name} vence`, sub: 'fatura fechada', amount: -inv.prev.total });
    if (inv.configured && inWin(addDays(inv.cycle.end, 1))) ev.push({ date: addDays(inv.cycle.end, 1), kind: 'info', title: `${name} fecha a fatura`, sub: 'compras depois disso vão para a próxima', amount: 0 });
    if (inWin(inv.due)) {
      const proj = inv.card.primary && primaryProjection != null ? primaryProjection : inv.total;
      const sub = !inv.configured ? 'datas do cartão não configuradas: usei as do principal'
        : inv.card.primary && primaryProjection != null ? 'fatura aberta + parcelas e assinaturas a vir' : 'fatura aberta até agora';
      if (proj > 0) ev.push({ date: inv.due, kind: 'out', title: `Fatura ${name} vence`, sub, amount: -round(proj) });
    }
  }
  ev.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'in' ? -1 : 1));
  const bal = settings.balance && Number.isFinite(Number(settings.balance.value)) ? Number(settings.balance.value) : null;
  let run = bal, min = null;
  for (const e of ev) {
    if (run == null) continue;
    run = round(run + e.amount);
    e.balance = run;
    if (e.kind !== 'info' && (min == null || run < min.balance)) min = { date: e.date, balance: run };
  }
  // sugestão: quanto separar da última entrada antes do ponto mais baixo
  let tip = null;
  if (min && min.balance < 0) {
    const before = ev.filter(e => e.kind === 'in' && e.date <= min.date).pop();
    tip = { need: Math.ceil(-min.balance / 10) * 10, from: before ? before.title : null, fromDate: before ? before.date : null, fromAmount: before ? before.amount : 0 };
  }
  return { events: ev, start: bal, balanceDate: settings.balance ? settings.balance.date : null, min, tip };
}
