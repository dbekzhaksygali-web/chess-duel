// Дуэль без сервера: телефон хозяина ведёт партию, друг подключается по ссылке.
// Связь — через публичный MQTT-брокер (WebSocket), поэтому работает в любой сети.
import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js';

const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
const PREFIX = 'duel-chess-v1/';
const HOST_KEY = 'duel-host';
const TIME_CONTROLS = { none: null, '3+2': [180, 2], '5+0': [300, 0], '10+0': [600, 0], '15+10': [900, 10] };

const $ = (id) => document.getElementById(id);
const rid = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

let myId = localStorage.getItem('duel-id');
if (!myId) { myId = rid(12); localStorage.setItem('duel-id', myId); }

// ======================================================================
// Сеть
// ======================================================================
// Подключаемся сразу ко ВСЕМ брокерам и шлём через все: если один тормозит или лежит,
// хозяин и друг всё равно встретятся на другом. Дубликаты отсекаются по seq/stamp.
function connectNet(clientId, will) {
  const onMsg = [], onConn = [];
  const clients = BROKERS.map((url) => {
    const c = mqtt.connect(url, { clientId: clientId + '-' + rid(4), clean: true, reconnectPeriod: 3000, connectTimeout: 10000, will });
    c.on('connect', () => { onConn.forEach((f) => f(c)); updateConn(); });
    c.on('message', (t, p) => onMsg.forEach((f) => f(t, p)));
    c.on('offline', updateConn);
    c.on('close', updateConn);
    c.on('error', () => {});
    return c;
  });
  function updateConn() {
    showConn(clients.some((c) => c.connected) ? '' : 'Нет связи, переподключаюсь…');
  }
  const net = {
    onConnect: (f) => { onConn.push(f); clients.forEach((c) => c.connected && f(c)); },
    onMessage: (f) => onMsg.push(f),
    publish: (t, p, o) => clients.forEach((c) => c.connected && c.publish(t, p, o)),
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Нет связи с сервером синхронизации')), 15000);
    clients.forEach((c) => c.once('connect', () => { clearTimeout(timer); resolve(net); }));
  });
}

function showConn(text) {
  $('conn').hidden = !text;
  $('conn').textContent = text || '';
}

// ======================================================================
// Движок партии (работает только у хозяина)
// ======================================================================
let G = null;
let gameId = null;

function newGame(tc = '10+0', hostColor = 'w', keep = {}) {
  const t = TIME_CONTROLS[tc];
  G = {
    chess: new Chess(),
    undo: [], moves: [], last: null, tc, hostColor,
    clock: t ? { w: t[0] * 1000, b: t[0] * 1000, inc: t[1] * 1000, running: false, since: 0 } : null,
    over: null,
    guestId: keep.guestId || null,
    seen: keep.seen || {},
  };
}

const guestColor = () => (G.hostColor === 'w' ? 'b' : 'w');

function saveHost() {
  const { chess, ...rest } = G;
  try { localStorage.setItem(HOST_KEY, JSON.stringify({ gameId, G: { ...rest, fen: chess.fen() } })); } catch {}
}

function loadHost() {
  try {
    const d = JSON.parse(localStorage.getItem(HOST_KEY));
    if (!d || !d.gameId) return false;
    gameId = d.gameId;
    const { fen, ...rest } = d.G;
    G = { ...rest, chess: new Chess() };
    G.chess.load(fen, { skipValidation: true });
    return true;
  } catch { return false; }
}

function tickClock() {
  const c = G.clock;
  if (!c || !c.running) return false;
  const now = Date.now();
  const side = G.chess.turn();
  c[side] -= now - c.since;
  c.since = now;
  if (c[side] <= 0) { c[side] = 0; endGame(side === 'w' ? '0-1' : '1-0', 'время вышло'); return true; }
  return false;
}

function endGame(result, reason) {
  G.over = { result, reason };
  if (G.clock) G.clock.running = false;
}

function checkEnd() {
  const c = G.chess;
  try {
    if (c.isCheckmate()) endGame(c.turn() === 'w' ? '0-1' : '1-0', 'мат');
    else if (c.isStalemate()) endGame('½-½', 'пат');
    else if (c.isInsufficientMaterial()) endGame('½-½', 'мало материала');
    else if (c.isThreefoldRepetition()) endGame('½-½', 'троекратное повторение');
    else if (c.isDraw()) endGame('½-½', 'правило 50 ходов');
  } catch {}
}

function resumeClock() {
  if (G.clock && G.moves.length) { G.clock.running = true; G.clock.since = Date.now(); }
}

const fenToBoard = (fen) => fen.split(' ')[0].split('/').map((row) => {
  const out = [];
  for (const ch of row) {
    if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) out.push(null);
    else out.push(ch);
  }
  return out;
});
const boardToFen = (b) => b.map((row) => {
  let s = '', e = 0;
  for (const p of row) { if (!p) { e++; continue; } if (e) { s += e; e = 0; } s += p; }
  return s + (e || '');
}).join('/');
const rc = (sq) => [8 - +sq[1], sq.charCodeAt(0) - 97];

function setPosition(board, turn) {
  const old = G.chess.fen().split(' ');
  const at = (sq) => { const [r, c] = rc(sq); return board[r][c]; };
  let cs = '';
  if (old[2].includes('K') && at('e1') === 'K' && at('h1') === 'R') cs += 'K';
  if (old[2].includes('Q') && at('e1') === 'K' && at('a1') === 'R') cs += 'Q';
  if (old[2].includes('k') && at('e8') === 'k' && at('h8') === 'r') cs += 'k';
  if (old[2].includes('q') && at('e8') === 'k' && at('a8') === 'r') cs += 'q';
  G.undo.push({ fen: G.chess.fen(), wasMove: false, last: G.last });
  G.chess.load(`${boardToFen(board)} ${turn} ${cs || '-'} - 0 ${old[5]}`, { skipValidation: true });
  G.over = null;
  resumeClock();
  checkEnd();
}

function doMove(color, { from, to, promotion }) {
  if (G.over || !G.guestId || G.chess.turn() !== color) return;
  if (tickClock()) return;
  const fenBefore = G.chess.fen();
  let m;
  try { m = G.chess.move({ from, to, promotion: promotion || 'q' }); } catch { return; }
  G.undo.push({ fen: fenBefore, wasMove: true, last: G.last });
  G.moves.push(m.san);
  G.last = { from: m.from, to: m.to };
  if (G.clock) {
    if (G.clock.running) G.clock[color] += G.clock.inc;
    G.clock.running = true;
    G.clock.since = Date.now();
  }
  checkEnd();
}

function adminAction(msg) {
  tickClock();
  switch (msg.action) {
    case 'edit': {
      const board = fenToBoard(G.chess.fen());
      const [r, c] = rc(msg.square);
      board[r][c] = msg.piece || null;
      setPosition(board, G.chess.turn());
      break;
    }
    case 'turn':
      setPosition(fenToBoard(G.chess.fen()), msg.color);
      break;
    case 'undo': {
      const u = G.undo.pop();
      if (!u) return;
      G.chess.load(u.fen, { skipValidation: true });
      if (u.wasMove) G.moves.pop();
      G.last = u.last;
      G.over = null;
      resumeClock();
      checkEnd();
      break;
    }
    case 'time':
      if (G.clock) G.clock[msg.color] = Math.max(1000, G.clock[msg.color] + msg.seconds * 1000);
      break;
    case 'newGame': {
      let color = msg.color;
      if (color === 'random') color = Math.random() < 0.5 ? 'w' : 'b';
      newGame(msg.tc, color, { guestId: G.guestId, seen: G.seen });
      break;
    }
    case 'kick':
      G.guestId = null;
      break;
  }
}

function snapshot() {
  tickClock();
  const c = G.chess;
  const legal = {};
  if (!G.over && G.guestId) {
    try { for (const m of c.moves({ verbose: true })) (legal[m.from] ||= []).push({ to: m.to, promo: !!m.promotion }); } catch {}
  }
  let check = false;
  try { check = c.isCheck(); } catch {}
  return {
    fen: c.fen(), turn: c.turn(), check, moves: G.moves, last: G.last, legal, over: G.over,
    tc: G.tc, hostColor: G.hostColor, guestId: G.guestId,
    clock: G.clock && { w: G.clock.w, b: G.clock.b, running: G.clock.running },
    stamp: Date.now(), canUndo: G.undo.length > 0,
  };
}

// ======================================================================
// Режимы: хозяин / гость
// ======================================================================
let S = null;          // то, что рисуем
let sendAction = () => {};
// Присутствие: каждый шлёт "пинг" со временем раз в 5 с; нет пинга 15 с — не в сети.
const peerSeen = {};
const isOnline = (id) => !!id && Date.now() - (peerSeen[id] || 0) < 15000;
function notePresence(id, payload) {
  const v = payload.toString();
  peerSeen[id] = v === '0' ? 0 : +v || 0;
}
function startBeat(selfKey) {
  const beat = () => netClient.publish(topic('presence/' + selfKey), String(Date.now()), { retain: true, qos: 0 });
  beat();
  setInterval(beat, 5000);
  netClient.onConnect((c) => c.publish(topic('presence/' + selfKey), String(Date.now()), { retain: true, qos: 0 }));
  setInterval(() => { if (S) { renderPlayers(); renderNote(); } }, 2000);
}
let netClient = null;

const topic = (t) => PREFIX + gameId + '/' + t;

async function startHost() {
  showConn('Подключение…');
  $('game').hidden = false;
  netClient = await connectNet('h-' + gameId, { topic: topic('presence/host'), payload: '0', retain: true, qos: 1 });
  showConn('');
  startBeat('host');

  let lastSnap = null;
  const commit = () => {
    const snap = snapshot();
    lastSnap = JSON.stringify(snap);
    saveHost();
    netClient.publish(topic('state'), lastSnap, { retain: true, qos: 1 });
    S = { ...snap, role: 'host', myColor: G.hostColor };
    render();
  };

  netClient.onConnect((c) => {
    c.subscribe([topic('in/+'), topic('presence/+')], { qos: 1 });
    if (lastSnap) c.publish(topic('state'), JSON.stringify(snapshot()), { retain: true, qos: 1 });
  });

  netClient.onMessage((t, payload) => {
    const parts = t.split('/');
    const kind = parts[2], from = parts[3];
    if (kind === 'presence') {
      if (from !== 'host') notePresence(from, payload);
      return;
    }
    if (kind !== 'in') return;
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    if (!msg.seq || msg.seq <= (G.seen[from] || 0)) return; // уже обработано
    G.seen[from] = msg.seq;
    if (msg.type === 'hello' && !G.guestId) G.guestId = from;
    else if (msg.type === 'move' && from === G.guestId) doMove(guestColor(), msg);
    else if (msg.type === 'resign' && from === G.guestId && !G.over) {
      endGame(guestColor() === 'w' ? '0-1' : '1-0', (guestColor() === 'w' ? 'белые' : 'чёрные') + ' сдались');
    }
    commit();
  });

  sendAction = (msg) => {
    if (msg.type === 'move') doMove(G.hostColor, msg);
    else if (msg.type === 'resign' && !G.over) endGame(G.hostColor === 'w' ? '0-1' : '1-0', (G.hostColor === 'w' ? 'белые' : 'чёрные') + ' сдались');
    else if (msg.type === 'admin') adminAction(msg);
    commit();
  };

  setInterval(() => { if (tickClock()) commit(); }, 250);
  commit();
}

async function startGuest() {
  showConn('Подключение…');
  $('game').hidden = false;
  netClient = await connectNet('g-' + myId, { topic: topic('presence/' + myId), payload: '0', retain: true, qos: 1 });
  showConn('');
  startBeat(myId);

  const hello = () => netClient.publish(topic('in/' + myId), JSON.stringify({ type: 'hello', seq: Date.now() }), { retain: true, qos: 1 });
  netClient.onConnect((c) => {
    c.subscribe([topic('state'), topic('presence/host')], { qos: 1 });
    c.publish(topic('in/' + myId), JSON.stringify({ type: 'hello', seq: Date.now() }), { retain: true, qos: 1 });
  });

  let raw = null;
  const rebuild = () => {
    if (!raw) return;
    const role = raw.guestId === myId ? 'guest' : 'spectator';
    S = {
      ...raw, role,
      myColor: role === 'guest' ? (raw.hostColor === 'w' ? 'b' : 'w') : null,
    };
    render();
  };

  netClient.onMessage((t, payload) => {
    if (t.endsWith('/presence/host')) { notePresence('host', payload); return rebuild(); }
    let next;
    try { next = JSON.parse(payload); } catch { return; }
    if (raw && next.stamp < raw.stamp) return; // старая копия с другого брокера
    raw = next;
    if (!raw.guestId) setTimeout(hello, Math.random() * 300); // место свободно — занимаем
    rebuild();
  });

  sendAction = (msg) => {
    if (msg.type === 'admin') return;
    netClient.publish(topic('in/' + myId), JSON.stringify({ ...msg, seq: Date.now() }), { retain: true, qos: 1 });
    $('note').textContent = 'Отправка…';
  };
}

// ======================================================================
// Интерфейс
// ======================================================================
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';
let selected = null, flipped = false, editTool = 'Q', dismissedOver = null, lastMovesLen = 0;

function parseFen(fen) {
  const board = {};
  fen.split(' ')[0].split('/').forEach((row, ri) => {
    let fi = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) fi += +ch;
      else { board[FILES[fi] + (8 - ri)] = ch; fi++; }
    }
  });
  return board;
}

function pieceEl(ch) {
  const s = document.createElement('span');
  s.className = 'pc ' + (ch === ch.toUpperCase() ? 'w' : 'b');
  s.textContent = GLYPH[ch.toLowerCase()] + '︎';
  return s;
}

const editing = () => S && S.role === 'host' && $('editMode').checked;
const myLegal = () => (S && S.myColor && S.turn === S.myColor && !S.over ? S.legal : {});

function renderBoard() {
  const boardEl = $('board');
  boardEl.innerHTML = '';
  const pos = parseFen(S.fen);
  const blackBottom = (S.myColor === 'b') !== flipped;
  const legal = myLegal();
  const targets = selected && legal[selected] ? legal[selected].map((m) => m.to) : [];
  let kingInCheck = null;
  if (S.check) {
    const k = S.turn === 'w' ? 'K' : 'k';
    kingInCheck = Object.keys(pos).find((sq) => pos[sq] === k);
  }
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const file = blackBottom ? 7 - f : f;
      const rank = blackBottom ? r + 1 : 8 - r;
      const sq = FILES[file] + rank;
      const el = document.createElement('div');
      el.className = 'sq ' + ((file + rank) % 2 === 1 ? 'd' : 'l');
      if (S.last && (S.last.from === sq || S.last.to === sq)) el.classList.add('last');
      if (selected === sq) el.classList.add('sel');
      if (kingInCheck === sq) el.classList.add('check');
      if (r === 7) el.insertAdjacentHTML('beforeend', `<span class="coord f">${FILES[file]}</span>`);
      if (f === 0) el.insertAdjacentHTML('beforeend', `<span class="coord r">${rank}</span>`);
      if (pos[sq]) el.appendChild(pieceEl(pos[sq]));
      if (targets.includes(sq)) {
        const m = document.createElement('div');
        m.className = pos[sq] ? 'ring' : 'dot';
        el.appendChild(m);
      }
      el.onclick = () => onSquare(sq);
      boardEl.appendChild(el);
    }
  }
}

function onSquare(sq) {
  if (!S) return;
  if (editing()) {
    sendAction({ type: 'admin', action: 'edit', square: sq, piece: editTool === 'x' ? null : editTool });
    return;
  }
  const legal = myLegal();
  if (selected) {
    const move = (legal[selected] || []).find((m) => m.to === sq);
    if (move) {
      const from = selected;
      selected = null;
      if (move.promo) return askPromotion(from, sq);
      sendAction({ type: 'move', from, to: sq });
      return;
    }
  }
  selected = legal[sq] ? (selected === sq ? null : sq) : null;
  renderBoard();
}

function askPromotion(from, to) {
  const box = $('promo');
  box.innerHTML = '';
  for (const p of ['q', 'r', 'b', 'n']) {
    const b = document.createElement('button');
    b.appendChild(pieceEl(S.myColor === 'w' ? p.toUpperCase() : p));
    b.onclick = () => { box.hidden = true; sendAction({ type: 'move', from, to, promotion: p }); };
    box.appendChild(b);
  }
  box.hidden = false;
  renderBoard();
}

const fmt = (ms) => {
  if (ms == null) return '--:--';
  if (ms < 10000) return `0:${(Math.max(0, ms) / 1000).toFixed(1).padStart(4, '0')}`;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function clockValue(color) {
  if (!S.clock) return null;
  let v = S.clock[color];
  if (S.clock.running && S.turn === color && !S.over) v -= Date.now() - S.stamp;
  return Math.max(0, v);
}

function renderClocks() {
  if (!S) return;
  const me = S.myColor || 'w';
  const opp = me === 'w' ? 'b' : 'w';
  const [top, bottom] = flipped ? [me, opp] : [opp, me];
  for (const [id, color] of [['oppClock', top], ['meClock', bottom]]) {
    const el = $(id);
    const v = clockValue(color);
    el.textContent = S.clock ? fmt(v) : '∞';
    el.classList.toggle('active', !S.over && S.turn === color && !!S.guestId);
    el.classList.toggle('low', v != null && v < 20000);
  }
}

function renderPlayers() {
  const me = S.myColor || 'w';
  const opp = me === 'w' ? 'b' : 'w';
  const name = (c) => (c === 'w' ? 'белые' : 'чёрные');
  const isHost = S.role === 'host';
  const spect = S.role === 'spectator';
  const oppOnline = isHost ? isOnline(S.guestId) : isOnline('host');
  const meInfo = { title: spect ? 'Белые' : 'Вы', sub: spect ? '' : name(me), online: true };
  const oppInfo = {
    title: spect ? 'Чёрные' : isHost ? 'Друг' : 'Соперник',
    sub: spect ? '' : name(opp) + ' · ' + (oppOnline ? 'в сети' : isHost && !S.guestId ? 'ещё не зашёл' : 'не в сети'),
    online: oppOnline,
  };
  const [top, bottom] = flipped ? [meInfo, oppInfo] : [oppInfo, meInfo];
  $('oppName').textContent = top.title;
  $('oppStatus').textContent = top.sub;
  $('oppStatus').className = 'pstatus ' + (top.online ? 'on' : 'off');
  $('oppAvatar').textContent = top.title[0];
  $('meName').textContent = bottom.title;
  $('meStatus').textContent = bottom.sub;
  $('meStatus').className = 'pstatus ' + (bottom.online ? 'on' : 'off');
  $('meAvatar').textContent = bottom.title[0];
}

function renderMoves() {
  const box = $('moves');
  box.innerHTML = '';
  for (let i = 0; i < S.moves.length; i += 2) {
    const d = document.createElement('div');
    d.className = 'mv' + (i >= S.moves.length - 2 ? ' cur' : '');
    d.innerHTML = `<span class="n">${i / 2 + 1}.</span>${S.moves[i]} ${S.moves[i + 1] || ''}`;
    box.appendChild(d);
  }
  box.scrollLeft = box.scrollWidth;
}

function renderBanner() {
  const key = S.over && S.over.result + S.over.reason + S.moves.length;
  if (!S.over || dismissedOver === key) { $('banner').hidden = true; return; }
  const winner = S.over.result === '1-0' ? 'w' : S.over.result === '0-1' ? 'b' : null;
  let title = 'Ничья';
  if (winner) title = S.myColor ? (winner === S.myColor ? 'Победа! 🎉' : 'Поражение') : winner === 'w' ? 'Белые победили' : 'Чёрные победили';
  $('bannerTitle').textContent = title;
  $('bannerSub').textContent = `${S.over.result} · ${S.over.reason}`;
  $('bannerBtn').onclick = () => { dismissedOver = key; $('banner').hidden = true; };
  $('banner').hidden = false;
}

function renderNote() {
  let t = '';
  if (S.role === 'spectator') t = 'Вы зрители: партия уже идёт между двумя игроками.';
  else if (S.role === 'guest' && !isOnline('host')) t = 'Соперник отключился — ждём…';
  else if (!S.guestId) t = S.role === 'host' ? 'Отправь другу ссылку — кнопка «Пригласить» сверху.' : 'Подключаюсь к партии…';
  else if (S.over) t = S.role === 'host' ? 'Новая партия — в меню ⋯ внизу справа.' : 'Партия окончена. Ждём новую партию.';
  else if (S.myColor) t = S.turn === S.myColor ? 'Ваш ход' : 'Ход соперника';
  $('note').textContent = t;
}

function render() {
  if (!S) return;
  const isHost = S.role === 'host';
  if (lastMovesLen && S.moves.length > lastMovesLen && S.turn === S.myColor && navigator.vibrate) {
    try { navigator.vibrate(40); } catch {}
  }
  lastMovesLen = S.moves.length;
  if (selected && !myLegal()[selected]) selected = null;
  $('inviteBtn').hidden = !isHost;
  $('gear').hidden = !isHost;
  if (!isHost) $('sheet').hidden = true;
  $('resignBtn').hidden = !S.myColor || !!S.over || !S.guestId;
  document.body.classList.toggle('editing', editing());
  renderBoard();
  renderPlayers();
  renderClocks();
  renderMoves();
  renderBanner();
  renderNote();
}

setInterval(renderClocks, 100);

// ---------- Кнопки ----------
$('flipBtn').onclick = () => { flipped = !flipped; render(); };
$('resignBtn').onclick = () => { if (confirm('Сдаться?')) sendAction({ type: 'resign' }); };
$('inviteBtn').onclick = async () => {
  const link = location.origin + location.pathname + '#g=' + gameId;
  if (navigator.share) {
    try { await navigator.share({ title: 'Сыграем в шахматы?', text: 'Го партию в шахматы!', url: link }); return; } catch {}
  }
  try { await navigator.clipboard.writeText(link); alert('Ссылка скопирована:\n' + link); }
  catch { prompt('Скопируй ссылку для друга:', link); }
};

const palette = $('palette');
for (const p of ['K', 'Q', 'R', 'B', 'N', 'P', 'x', 'k', 'q', 'r', 'b', 'n', 'p']) {
  const b = document.createElement('button');
  if (p === 'x') { b.textContent = '🧽'; b.className = 'eraser'; }
  else b.appendChild(pieceEl(p));
  b.dataset.tool = p;
  b.onclick = () => {
    editTool = p;
    $('editMode').checked = true;
    palette.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.tool === p));
    render();
  };
  palette.appendChild(b);
}
palette.querySelector('[data-tool="Q"]').classList.add('on');
$('editMode').onchange = () => { selected = null; render(); };
$('gear').onclick = () => { $('sheet').hidden = false; };
$('sheetClose').onclick = () => { $('sheet').hidden = true; $('editMode').checked = false; render(); };

document.querySelectorAll('[data-admin]').forEach((b) => {
  b.onclick = () => {
    const msg = { type: 'admin', action: b.dataset.admin };
    if (msg.action === 'turn') msg.color = b.dataset.color;
    if (msg.action === 'newGame') {
      msg.tc = $('tcSelect').value;
      msg.color = $('colorSelect').value;
      flipped = false;
      dismissedOver = null;
    }
    sendAction(msg);
  };
});
const oppColor = () => (S && S.myColor === 'b' ? 'w' : 'b');
$('timeMe').onclick = () => S && sendAction({ type: 'admin', action: 'time', color: S.myColor, seconds: 60 });
$('timeOpp').onclick = () => S && sendAction({ type: 'admin', action: 'time', color: oppColor(), seconds: -60 });
$('kickBtn').onclick = () => {
  if (confirm('Освободить место друга? Следующий, кто зайдёт по ссылке, станет соперником.')) sendAction({ type: 'admin', action: 'kick' });
};

// ======================================================================
// Старт
// ======================================================================
async function boot() {
  const hashGame = new URLSearchParams(location.hash.slice(1)).get('g');
  const haveHost = loadHost();
  try {
    if (hashGame && !(haveHost && hashGame === gameId)) {
      gameId = hashGame;
      await startGuest();
    } else if (haveHost) {
      history.replaceState(null, '', location.pathname);
      await startHost();
    } else {
      $('landing').hidden = false;
      $('createBtn').onclick = async () => {
        $('landing').hidden = true;
        gameId = rid(14);
        newGame();
        saveHost();
        await startHost();
      };
    }
  } catch (e) {
    showConn('Ошибка: ' + e.message);
  }
}

window.addEventListener('hashchange', () => location.reload());
boot();
