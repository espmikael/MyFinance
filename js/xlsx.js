// Leitor mínimo de planilhas .xlsx (sem biblioteca externa): abre o zip, lê a primeira aba
// e devolve o conteúdo como CSV para o mesmo leitor das faturas.
// Usa só recursos do navegador (DecompressionStream). Nada sai do aparelho.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

async function unzip(buf) {
  const b = new Uint8Array(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('O arquivo não parece uma planilha .xlsx.');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  if (count > 2000) throw new Error('Planilha grande demais.');
  const files = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (u32(b, p) !== 0x02014b50) break;
    const method = u16(b, p + 10), csize = u32(b, p + 20), usize = u32(b, p + 24);
    const nlen = u16(b, p + 28), xlen = u16(b, p + 30), clen = u16(b, p + 32), lho = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml|workbook\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) continue;
    if (usize > 30e6) throw new Error('Planilha grande demais.');
    const start = lho + 30 + u16(b, lho + 26) + u16(b, lho + 28);
    const data = b.subarray(start, start + csize);
    files[name] = dec.decode(method === 0 ? data : await inflate(data));
  }
  return files;
}

const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const serialToISO = v => new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);

export function sheetToRows(sheetXML, sharedXML = '') {
  // alguns geradores (LibreOffice, exportadores em Java/.NET) usam prefixo (<x:row>) e aspas simples
  const NS = '(?:[\\w.-]+:)?';
  // abre com <tag ...> (nunca o vazio <tag .../>) e fecha em </tag>
  const tag = (name, flags = 'g') => new RegExp(`<${NS}${name}(?:\\s[^>]*[^/>])?>([\\s\\S]*?)<\\/${NS}${name}>`, flags);
  const texts = xml => [...xml.matchAll(tag('t'))].map(x => x[1]).join('');
  const shared = [...sharedXML.matchAll(tag('si'))].map(m => unxml(texts(m[1])));
  const rows = [];
  for (const rm of sheetXML.matchAll(tag('row'))) {
    const row = [];
    for (const cm of rm[1].matchAll(new RegExp(`<${NS}c\\s([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${NS}c>)`, 'g'))) {
      const attrs = cm[1], inner = cm[2] || '';
      const ref = (attrs.match(/\br=["']([A-Z]+\d+)["']/) || [])[1];
      const t = (attrs.match(/\bt=["'](\w+)["']/) || [])[1];
      let v = (inner.match(tag('v', '')) || [])[1];
      if (t === 's') v = shared[+v] ?? '';
      else if (t === 'inlineStr') v = unxml(texts(inner));
      else if (v != null) v = unxml(v);
      row[ref ? colIndex(ref) : row.length] = v ?? '';
    }
    rows.push(Array.from(row, x => x ?? ''));
  }
  // datas como número de série na coluna de data
  const hi = rows.findIndex(r => r.filter(x => String(x).trim()).length >= 3);
  if (hi >= 0) {
    const di = rows[hi].findIndex(h => /^(data|date)/i.test(String(h).normalize('NFD').replace(/[̀-ͯ]/g, '').trim()));
    if (di >= 0) for (const r of rows.slice(hi + 1)) { const n = Number(r[di]); if (r[di] !== '' && n > 20000 && n < 80000) r[di] = serialToISO(n); }
  }
  return rows;
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const rowsToCSV = rows => rows.map(r => r.map(csvCell).join(',')).join('\n');

// a primeira aba da pasta de trabalho (nem sempre é sheet1.xml: abas apagadas ou reordenadas mudam o número)
function firstSheet(f) {
  const wb = f['xl/workbook.xml'] || '', rels = f['xl/_rels/workbook.xml.rels'] || '';
  const s1 = wb.match(/<(?:[\w.-]+:)?sheet\s[^>]*?\br:id=["']([^"']+)["']/);
  if (s1) {
    const rel = [...rels.matchAll(/<(?:[\w.-]+:)?Relationship\s([^>]*)\/?>/g)].map(m => m[1]).find(a => new RegExp(`\\bId=["']${s1[1]}["']`).test(a));
    const target = rel && (rel.match(/\bTarget=["']([^"']+)["']/) || [])[1];
    if (target) { const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, ''); if (f[path]) return f[path]; }
  }
  if (f['xl/worksheets/sheet1.xml']) return f['xl/worksheets/sheet1.xml'];
  const k = Object.keys(f).filter(x => /^xl\/worksheets\/sheet\d+\.xml$/.test(x)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)))[0];
  return k ? f[k] : null;
}

export async function xlsxToCSV(buf) {
  const f = await unzip(buf);
  const sheet = firstSheet(f);
  if (!sheet) throw new Error('Não encontrei a primeira aba da planilha.');
  return rowsToCSV(sheetToRows(sheet, f['xl/sharedStrings.xml'] || ''));
}
