export function parseClientsCsv(text) {
  if (typeof text !== 'string' || text.length > 200000) throw new Error('Use um CSV de até 200 KB e 200 clientes.');
  text = text.replace(/^\uFEFF/, '');
  const delimiter = text.split(/\r?\n/)[0].includes(';') ? ';' : ',';
  const records = []; let fields = [], value = '', quoted = false, afterQuote = false;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"' && text[i + 1] === '"') { value += '"'; i++; } else if (c === '"') { quoted = false; afterQuote = true; } else if (c === undefined) throw new Error('Há aspas sem fechamento no CSV.'); else value += c; continue; }
    if (c === '"' && !value && !afterQuote) { quoted = true; continue; }
    if (c === delimiter || c === '\r' || c === '\n' || c === undefined) { fields.push(value); value = ''; afterQuote = false; if (c !== delimiter) { if (fields.some(v => v.trim())) records.push(fields); fields = []; if (c === '\r' && text[i + 1] === '\n') i++; } }
    else { if (afterQuote || c === '"') throw new Error('Formato de aspas inválido. Use o modelo de CSV.'); value += c; }
  }
  if (!records.length) throw new Error('O arquivo está vazio.');
  const header = records.shift().map(v => v.trim().toLowerCase());
  if (header.join(',') !== 'nome,whatsapp,email,observacoes') throw new Error('Use as colunas nome;whatsapp;email;observacoes, nesta ordem.');
  if (!records.length || records.length > 200) throw new Error('Importe de 1 a 200 clientes por vez.');
  return records.map((r, i) => { if (r.length !== 4) throw new Error(`Confira as quatro colunas da linha ${i + 2}.`); return { name: r[0], phone: r[1], email: r[2], notes: r[3] }; });
}
export function clientsCsv(rows) {
  const cell = v => { const text = String(v ?? ''); return '"' + (/^[=+\-@\t\r]/.test(text.trimStart()) ? "'" : '') + text.replaceAll('"', '""') + '"'; };
  return '\uFEFFnome;whatsapp;email;observacoes\r\n' + rows.map(r => [r.name, r.phone, r.email, r.notes].map(cell).join(';')).join('\r\n');
}
