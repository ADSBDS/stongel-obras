// Stongel · backend do app de Formulários de Obras (POC)
// Dados, login por código de e-mail e envio de e-mails, tudo numa Planilha Google.
//
// COMO INSTALAR (uma vez):
// 1. Crie uma Planilha Google nova (ex.: "Stongel Obras - dados") na conta que vai enviar os e-mails.
// 2. Na planilha: Extensões → Apps Script. Apague o conteúdo e cole este arquivo inteiro.
// 3. Selecione a função "configurar" e clique em Executar. Aceite as permissões.
//    Ela cria as abas e cadastra VOCÊ como primeiro usuário (admin) na aba "usuarios".
// 4. Implantar → Nova implantação → Tipo: App da Web. Executar como: Eu. Quem pode acessar: Qualquer pessoa.
//    Copie a URL (termina em /exec) e coloque no arquivo config.js do site.
// 5. Para liberar alguém: adicione uma linha na aba "usuarios" com e-mail, nome, papel e ativo = SIM.
//
// Ao alterar este código depois: Implantar → Gerenciar implantações → editar (lápis) → Versão: Nova versão.

const SESSAO_DIAS = 30;        // quanto tempo o aparelho fica logado
const CODIGO_MINUTOS = 10;     // validade do código
const MAX_TENTATIVAS = 5;      // erros antes de bloquear o código
const MAX_CODIGOS_15MIN = 3;   // códigos por e-mail a cada 15 minutos
const NOME_REMETENTE = 'Stongel Obras';

const KINDS = ['obras', 'forms', 'team', 'handoffs'];
const CHUNK = 45000; // limite de ~50 mil caracteres por célula: JSON grande é dividido em várias colunas

const ABAS = {
  usuarios: ['email', 'nome', 'papel', 'ativo', 'criadoEm', 'ultimoAcesso'],
  codigos: ['email', 'codigoHash', 'criadoEm', 'expiraEm', 'usadoEm', 'tentativas', 'status'],
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
    if (d.action === 'requestCode') return out(requestCode(d.email));
    if (d.action === 'verifyCode') return out(verifyCode(d.email, d.code));
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
  const me = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
  if (me && !findUser(me)) sheet('usuarios').appendRow([me.toLowerCase(), 'Administrador', 'admin', 'SIM', new Date(), '']);
  MailApp.getRemainingDailyQuota(); // pede a permissão de envio de e-mail
  Logger.log('Pronto. Usuário admin: ' + me + '. Agora faça a implantação como App da Web.');
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
function findUser(email) {
  email = norm(email);
  const r = rows('usuarios');
  for (let i = 0; i < r.length; i++) if (norm(r[i][0]) === email) return { row: i + 2, email, nome: String(r[i][1] || ''), papel: String(r[i][2] || ''), ativo: norm(r[i][3]) === 'sim' };
  return null;
}

function requestCode(email) {
  email = norm(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'email' };
  return withLock(() => {
    const sh = sheet('codigos');
    const now = new Date();
    const data = rows('codigos');
    const recent = data.filter(r => norm(r[0]) === email && now - new Date(r[2]) < 15 * 60000).length;
    if (recent >= MAX_CODIGOS_15MIN) return { ok: false, error: 'limite' };
    const u = findUser(email);
    if (!u || !u.ativo) {
      // registra a tentativa para controle, mas responde igual (não revela quem está cadastrado)
      sh.appendRow([email, '', now, now, '', 0, u ? 'negado (inativo)' : 'negado (não cadastrado)']);
      return { ok: true };
    }
    // invalida códigos pendentes anteriores deste e-mail
    data.forEach((r, i) => { if (norm(r[0]) === email && r[6] === 'pendente') sh.getRange(i + 2, 7).setValue('substituido'); });
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const exp = new Date(now.getTime() + CODIGO_MINUTOS * 60000);
    sh.appendRow([email, sha(email + ':' + code), now, exp, '', 0, 'pendente']);
    MailApp.sendEmail({
      to: email, name: NOME_REMETENTE,
      subject: 'Seu código de acesso: ' + code + ' · Stongel Obras',
      body: 'Olá' + (u.nome ? ' ' + u.nome : '') + ',\n\nSeu código de acesso ao app de Formulários de Obras é: ' + code +
        '\n\nEle vale por ' + CODIGO_MINUTOS + ' minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail.',
      htmlBody: '<div style="font-family:Arial,sans-serif;color:#1A1F2B"><p>Olá' + (u.nome ? ' ' + u.nome : '') + ',</p>' +
        '<p>Seu código de acesso ao app de Formulários de Obras Stongel é:</p>' +
        '<p style="font-size:30px;font-weight:bold;letter-spacing:6px;color:#1C2C4C">' + code + '</p>' +
        '<p style="color:#5B6577;font-size:13px">Ele vale por ' + CODIGO_MINUTOS + ' minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail.</p></div>'
    });
    return { ok: true };
  });
}

function verifyCode(email, code) {
  email = norm(email); code = String(code || '').replace(/\D/g, '');
  return withLock(() => {
    const sh = sheet('codigos');
    const data = rows('codigos');
    let idx = -1;
    for (let i = data.length - 1; i >= 0; i--) if (norm(data[i][0]) === email && data[i][6] === 'pendente') { idx = i; break; }
    if (idx < 0) return { ok: false, error: 'codigo' };
    const r = data[idx], row = idx + 2, now = new Date();
    if (now > new Date(r[3])) { sh.getRange(row, 7).setValue('expirado'); return { ok: false, error: 'expirado' }; }
    if (sha(email + ':' + code) !== r[1]) {
      const t = Number(r[5] || 0) + 1;
      sh.getRange(row, 6).setValue(t);
      if (t >= MAX_TENTATIVAS) { sh.getRange(row, 7).setValue('bloqueado'); return { ok: false, error: 'bloqueado' }; }
      return { ok: false, error: 'codigo', restantes: MAX_TENTATIVAS - t };
    }
    const u = findUser(email);
    if (!u || !u.ativo) { sh.getRange(row, 7).setValue('negado (inativo)'); return { ok: false, error: 'codigo' }; }
    sh.getRange(row, 5, 1, 3).setValues([[now, r[5], 'usado']]);
    const token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    sheet('sessoes').appendRow([token, email, now, new Date(now.getTime() + SESSAO_DIAS * 86400000), now, '']);
    sheet('usuarios').getRange(u.row, 6).setValue(now);
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
