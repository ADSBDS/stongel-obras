// Stongel · backend do app de Formulários de Obras (POC)
// Dados, login por e-mail e código de 6 dígitos e envio dos e-mails de passagem de bastão, tudo numa Planilha Google.
//
// COMO INSTALAR (uma vez):
// 1. Crie uma Planilha Google nova (ex.: "Stongel Obras - dados") na conta que vai enviar os e-mails.
// 2. Na planilha: Extensões → Apps Script. Apague o conteúdo e cole este arquivo inteiro.
// 3. Selecione a função "configurar" e clique em Executar. Aceite as permissões. Ela cria as abas.
// 4. Implantar → Nova implantação → Tipo: App da Web. Executar como: Eu. Quem pode acessar: Qualquer pessoa.
//    Copie a URL (termina em /exec) e coloque no arquivo config.js do site.
// 5. Para liberar alguém: na aba "usuarios", preencha email, nome, papel e ativo = SIM.
//    Ao digitar o e-mail, a planilha gera sozinha um código de 6 dígitos na coluna "codigo".
//    Passe o e-mail e o código para a pessoa. Para trocar o código, apague a célula (gera outro)
//    ou digite você mesmo 6 dígitos. Menu "Stongel" → "Gerar códigos que faltam" preenche todos.
//
// Ao alterar este código depois: Implantar → Gerenciar implantações → editar (lápis) → Versão: Nova versão.

const SESSAO_DIAS = 30;        // quanto tempo o aparelho fica logado
const MAX_ERROS_15MIN = 5;     // códigos errados por e-mail a cada 15 minutos antes de bloquear
const NOME_REMETENTE = 'Stongel Obras';

const KINDS = ['obras', 'forms', 'team', 'handoffs'];
const CHUNK = 45000; // limite de ~50 mil caracteres por célula: JSON grande é dividido em várias colunas

const ABAS = {
  usuarios: ['email', 'nome', 'papel', 'ativo', 'codigo', 'criadoEm', 'ultimoAcesso'],
  acessos: ['data', 'email', 'resultado'],
  sessoes: ['token', 'email', 'criadoEm', 'expiraEm', 'ultimoUso', 'revogado'],
  log: ['Data', 'Obra', 'Cliente', 'Formulário', 'De', 'Para', 'Assunto'],
};
KINDS.forEach(k => ABAS[k] = ['id', 'updatedAt', 'updatedBy', 'deleted', 'json']);

// ============ entrada ============
function doGet() { return ContentService.createTextOutput('Stongel Obras: serviço ativo'); }

function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (x) { return out({ ok: false, error: 'requisicao' }); }
  try {
    if (d.action === 'login') return out(login(d.email, d.codigo));
    const s = checkSession(d.session);
    if (!s) return out({ ok: false, error: 'auth' });
    switch (d.action) {
      case 'me': return out({ ok: true, user: s.user });
      case 'list': return out(list(d.since));
      case 'put': return out(put(d.kind, d.id, d.val, s.user.email));
      case 'del': return out(put(d.kind, d.id, null, s.user.email));
      case 'bulk': return out(bulk(d.ops || [], s.user.email));
      case 'send': return out(send(d, s.user));
      case 'logout': return out(logout(d.session));
    }
    return out({ ok: false, error: 'acao' });
  } catch (err) {
    return out({ ok: false, error: 'servidor', detail: String(err && err.message || err) });
  }
}

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

// ============ instalação ============
function configurar() {
  Object.keys(ABAS).forEach(sheet);
  gerarCodigosQueFaltam();
  MailApp.getRemainingDailyQuota(); // pede a permissão de envio de e-mail (passagem de bastão)
  Logger.log('Pronto. Os códigos de acesso estão na aba "usuarios". Agora faça a implantação como App da Web.');
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Stongel')
    .addItem('Gerar códigos que faltam', 'gerarCodigosQueFaltam')
    .addItem('Gerar novo código para a linha selecionada', 'novoCodigoLinhaSelecionada')
    .addToUi();
}

// Na aba "usuarios": ao digitar um e-mail sem código, gera um; código digitado à mão precisa ter 6 dígitos.
function onEdit(e) {
  const sh = e.range.getSheet();
  if (sh.getName() !== 'usuarios' || e.range.getLastRow() < 2) return;
  const c = userCols(sh);
  if (!c.email || !c.codigo) return;
  for (let r = Math.max(2, e.range.getRow()); r <= e.range.getLastRow(); r++) {
    const email = norm(sh.getRange(r, c.email).getValue()), cel = sh.getRange(r, c.codigo);
    const v = String(cel.getDisplayValue() || '').trim();
    if (email && !v) cel.setNumberFormat('@').setValue(novoCodigo());
    else if (v && !/^\d{6}$/.test(v)) cel.setNumberFormat('@').setValue(/^\d{1,6}$/.test(v) ? ('00000' + v).slice(-6) : novoCodigo());
    if (email && c.criadoem && !sh.getRange(r, c.criadoem).getValue()) sh.getRange(r, c.criadoem).setValue(new Date());
  }
}

function novoCodigo() {
  const b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid());
  const n = ((b[0] & 255) * 16777216 + (b[1] & 255) * 65536 + (b[2] & 255) * 256 + (b[3] & 255)) % 1000000;
  return ('00000' + n).slice(-6);
}

function gerarCodigosQueFaltam() {
  const sh = sheet('usuarios'), c = userCols(sh), n = sh.getLastRow();
  if (n < 2 || !c.email || !c.codigo) return;
  sh.getRange(2, c.codigo, n - 1, 1).setNumberFormat('@');
  let k = 0;
  for (let r = 2; r <= n; r++) {
    const cel = sh.getRange(r, c.codigo);
    if (norm(sh.getRange(r, c.email).getValue()) && !/^\d{6}$/.test(String(cel.getDisplayValue()).trim())) { cel.setValue(novoCodigo()); k++; }
  }
  Logger.log(k + ' código(s) gerado(s).');
}

function novoCodigoLinhaSelecionada() {
  const sh = SpreadsheetApp.getActiveSheet(), r = sh.getActiveRange().getRow();
  if (sh.getName() !== 'usuarios' || r < 2) { SpreadsheetApp.getUi().alert('Selecione uma linha da aba "usuarios".'); return; }
  const c = userCols(sh);
  sh.getRange(r, c.codigo).setNumberFormat('@').setValue(novoCodigo());
}

function sheet(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(ABAS[name]);
    sh.setFrozenRows(1);
    if (KINDS.indexOf(name) >= 0 || name === 'sessoes') sh.getRange('A:A').setNumberFormat('@'); // ids/tokens como texto
    sh.getRange(1, 1, 1, ABAS[name].length).setFontWeight('bold');
  }
  else if (name === 'usuarios') {
    const head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(norm);
    const old = head.indexOf('senha');
    if (old >= 0 && head.indexOf('codigo') < 0) { sh.getRange(1, old + 1).setValue('codigo'); head[old] = 'codigo'; }
    ABAS.usuarios.forEach(c => { if (head.indexOf(c) < 0) { head.push(c); sh.getRange(1, head.length).setValue(c).setFontWeight('bold'); } });
  }
  return sh;
}

function rows(name) {
  const sh = sheet(name);
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues();
}

const norm = s => String(s || '').trim().toLowerCase();
const iso = d => (d instanceof Date ? d : new Date(d)).toISOString();
function sha(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ============ usuários e login ============
function userCols(sh) {
  const head = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(norm);
  const c = {}; head.forEach((h, i) => { if (h) c[h] = i + 1; });
  return c;
}
function findUser(email) {
  email = norm(email);
  const sh = sheet('usuarios'), c = userCols(sh), n = sh.getLastRow();
  if (n < 2 || !c.email) return null;
  const r = sh.getRange(2, 1, n - 1, sh.getLastColumn()).getValues();
  const g = (row, k) => c[k] ? row[c[k] - 1] : '';
  for (let i = 0; i < r.length; i++) if (norm(g(r[i], 'email')) === email)
    return { row: i + 2, cols: c, email, nome: String(g(r[i], 'nome') || ''), papel: String(g(r[i], 'papel') || ''), ativo: norm(g(r[i], 'ativo')) === 'sim', codigo: c.codigo ? String(sh.getRange(i + 2, c.codigo).getDisplayValue()).trim() : '' };
  return null;
}

function login(email, codigo) {
  email = norm(email); codigo = String(codigo || '').replace(/\D/g, '');
  if (!email || codigo.length !== 6) return { ok: false, error: 'login' };
  return withLock(() => {
    const log = sheet('acessos'), now = new Date();
    const erros = rows('acessos').filter(r => norm(r[1]) === email && now - new Date(r[0]) < 15 * 60000 && String(r[2]).indexOf('código errado') === 0).length;
    if (erros >= MAX_ERROS_15MIN) { log.appendRow([now, email, 'bloqueado (muitas tentativas)']); return { ok: false, error: 'bloqueado' }; }
    const u = findUser(email);
    if (!u) { log.appendRow([now, email, 'não cadastrado']); return { ok: false, error: 'login' }; }
    if (!u.ativo) { log.appendRow([now, email, 'inativo']); return { ok: false, error: 'login' }; }
    if (!/^\d{6}$/.test(u.codigo) || u.codigo !== codigo) { log.appendRow([now, email, 'código errado']); return { ok: false, error: 'login', restantes: MAX_ERROS_15MIN - erros - 1 }; }
    const sh = sheet('usuarios');
    if (u.cols.ultimoacesso) sh.getRange(u.row, u.cols.ultimoacesso).setValue(now);
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    sheet('sessoes').appendRow([token, email, now, new Date(now.getTime() + SESSAO_DIAS * 86400000), now, '']);
    log.appendRow([now, email, 'ok']);
    return { ok: true, session: token, user: { email: u.email, nome: u.nome, papel: u.papel } };
  });
}

function checkSession(token) {
  if (!token) return null;
  const cache = CacheService.getScriptCache();
  const hit = cache.get('s_' + token);
  if (hit) return JSON.parse(hit);
  const r = rows('sessoes');
  for (let i = 0; i < r.length; i++) {
    if (r[i][0] !== token) continue;
    if (norm(r[i][5]) === 'sim' || new Date() > new Date(r[i][3])) return null;
    const u = findUser(r[i][1]);
    if (!u || !u.ativo) return null;
    sheet('sessoes').getRange(i + 2, 5).setValue(new Date());
    const s = { user: { email: u.email, nome: u.nome, papel: u.papel } };
    cache.put('s_' + token, JSON.stringify(s), 120); // revogação vale em até 2 minutos
    return s;
  }
  return null;
}

function logout(token) {
  const r = rows('sessoes');
  for (let i = 0; i < r.length; i++) if (r[i][0] === token) sheet('sessoes').getRange(i + 2, 6).setValue('SIM');
  CacheService.getScriptCache().remove('s_' + token);
  return { ok: true };
}

// ============ dados ============
function list(since) {
  const out = {};
  const now = new Date();
  KINDS.forEach(k => {
    out[k] = {};
    rows(k).forEach(r => {
      if (!r[0]) return;
      const at = r[1] ? iso(r[1]) : '';
      if (since && at && at <= since) return;
      out[k][r[0]] = r[3] === true || norm(r[3]) === 'true' ? null : safeParse(r.slice(4).join(''));
    });
  });
  return { ok: true, now: iso(now), full: !since, data: out };
}

function safeParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }

function put(kind, id, val, by) {
  if (KINDS.indexOf(kind) < 0 || !id) return { ok: false, error: 'dados' };
  return withLock(() => { writeDoc(kind, String(id), val, by); return { ok: true }; });
}

function bulk(ops, by) {
  return withLock(() => {
    ops.forEach(o => { if (KINDS.indexOf(o.kind) >= 0 && o.id) writeDoc(o.kind, String(o.id), o.val === undefined ? null : o.val, by); });
    return { ok: true, n: ops.length };
  });
}

function writeDoc(kind, id, val, by) {
  const sh = sheet(kind);
  const json = val === null ? '' : JSON.stringify(val);
  const parts = [];
  for (let i = 0; i < json.length; i += CHUNK) parts.push(json.slice(i, i + CHUNK));
  if (!parts.length) parts.push('');
  const line = [id, new Date(), by || '', val === null, ...parts];
  const f = sh.getRange('A:A').createTextFinder(id).matchEntireCell(true).findNext();
  if (f && f.getRow() > 1) {
    const row = f.getRow();
    const width = Math.max(sh.getLastColumn(), line.length);
    while (line.length < width) line.push('');
    sh.getRange(row, 1, 1, width).setValues([line]);
  } else {
    sh.appendRow(line);
  }
}

// ============ e-mail da passagem de bastão ============
function send(d, user) {
  if (!d.to) return { ok: false, error: 'destinatario' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'cota' };
  MailApp.sendEmail({
    to: d.to, cc: d.cc || '', subject: d.subject || '(sem assunto)', htmlBody: d.html, body: d.text,
    name: (user.nome ? user.nome + ' · ' : '') + NOME_REMETENTE, replyTo: user.email
  });
  const l = d.log || {};
  sheet('log').appendRow([new Date(), l.obra || '', l.cliente || '', l.form || '', user.email, d.to, d.subject || '']);
  return { ok: true };
}
