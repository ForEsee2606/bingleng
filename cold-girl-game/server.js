const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// ============ 卡牌定义 ============
const CARD_DEFS = {
  '外星人':  { mp: -1, priority: 1, win: 'imprisoned',      color: '#6c5ce7', desc: '持有时，可在优等生技能触发时假冒犯人' },
  '感染者':  { mp:  0, priority: 2, win: 'embalm_fail',     color: '#e17055', desc: '下回合开始时若此牌仍在你面前，从调和区取1张牌入手' },
  '犯人':    { mp:  0, priority: 3, win: 'not_imprisoned',  color: '#d63031', desc: '无法主动使用，只能被其他效果移动' },
  '共犯':    { mp:  0, priority: 3, win: 'criminal_wins',   color: '#fd79a8', desc: '将任意玩家面前的1张嫌疑牌移至另一名玩家面前' },
  '学生会长':{ mp:  3, priority: 4, win: 'embalm_success',  color: '#0984e3', desc: '持有者为起始玩家（面朝上使用无额外效果）' },
  '班长':    { mp:  2, priority: 4, win: 'embalm_success',  color: '#00b894', desc: '选择1名玩家，双方各选1张手牌面朝下互换' },
  '优等生':  { mp:  2, priority: 4, win: 'embalm_success',  color: '#00cec9', desc: '其他玩家闭眼，持有犯人的玩家伸舌头，收回后所有人睁眼' },
  '风纪委员':{ mp:  1, priority: 4, win: 'embalm_success',  color: '#55efc4', desc: '查看1名玩家的全部手牌' },
  '保健委员':{ mp:  1, priority: 4, win: 'embalm_success',  color: '#a29bfe', desc: '取走另一名玩家已正面朝上使用的1张非保健委员牌' },
  '图书委员':{ mp:  1, priority: 4, win: 'embalm_success',  color: '#fdcb6e', desc: '查看调和区全部牌（不改变顺序）' },
  '大小姐':  { mp:  1, priority: 4, win: 'embalm_success',  color: '#e84393', desc: '随机取走另一名玩家1张手牌，再选1张自己的牌还给对方' },
  '新闻部':  { mp:  1, priority: 4, win: 'embalm_success',  color: '#fab1a0', desc: '所有玩家同时各选1张手牌，传给左边玩家' },
  '归宅部':  { mp:  0, priority: 5, win: 'no_winner',       color: '#b2bec3', desc: '将1张手牌与调和区1张牌交换' },
};

const DECK_CONFIG = {
  3: { '外星人':1,'感染者':1,'犯人':1,'共犯':1,'学生会长':1,'班长':2,'优等生':1,'风纪委员':1,'保健委员':1,'图书委员':1,'大小姐':2,'新闻部':2,'归宅部':2 },
  4: { '外星人':1,'感染者':1,'犯人':1,'共犯':1,'学生会长':1,'班长':2,'优等生':2,'风纪委员':2,'保健委员':2,'图书委员':2,'大小姐':3,'新闻部':3,'归宅部':2 },
  5: { '外星人':1,'感染者':1,'犯人':1,'共犯':1,'学生会长':1,'班长':2,'优等生':2,'风纪委员':2,'保健委员':2,'图书委员':2,'大小姐':3,'新闻部':3,'归宅部':3 },
  6: { '外星人':1,'感染者':1,'犯人':1,'共犯':1,'学生会长':1,'班长':2,'优等生':2,'风纪委员':2,'保健委员':2,'图书委员':2,'大小姐':3,'新闻部':3,'归宅部':2 },
};

const TARGET_MP = { 3: 9, 4: 8, 5: 7, 6: 6 };

let _uid = 0;
function uid() { return ++_uid; }

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeCard(name) {
  return { id: uid(), name, ...CARD_DEFS[name] };
}

function buildDeck(n) {
  const cfg = DECK_CONFIG[n];
  const deck = [];
  for (const [name, count] of Object.entries(cfg)) {
    for (let i = 0; i < count; i++) deck.push(makeCard(name));
  }
  return shuffle(deck);
}

// ============ 房间管理 ============
function newRoom(hostId, hostName) {
  const code = Math.random().toString(36).substr(2, 5).toUpperCase();
  rooms[code] = {
    code,
    phase: 'lobby',
    host: hostId,
    players: [newPlayer(hostId, hostName)],
    embalm: [],
    curIdx: 0,
    pending: null,
    infectPending: null,
    log: [],
  };
  return code;
}

function newPlayer(socketId, name, isBot=false) {
  return { socketId, name, hand: [], faceUp: [], suspects: [], retired: null, isRetired: false, isBot };
}

// ============ 机器人逻辑 ============
function botDelay(room) {
  const p = room.players[room.curIdx];
  if (!p || !p.isBot || p.isRetired) return;
  setTimeout(() => botTakeTurn(room), 1200 + Math.random() * 800);
}

function botTakeTurn(room) {
  if (room.phase !== 'playing') return;
  const pi = room.curIdx;
  const p = room.players[pi];
  if (!p || !p.isBot || p.isRetired || room.pending) return;
  if (!p.hand.length) { nextTurn(room); return; }

  const hand = [...p.hand];
  const playable = hand.filter(c => c.name !== '犯人');
  const mustSuspect = hand.filter(c => c.name === '犯人');

  let card, action, targetIdx;

  if (mustSuspect.length && Math.random() < 0.7) {
    card = mustSuspect[0];
    action = 'suspect';
    const others = room.players.map((_,i)=>i).filter(i=>i!==pi);
    targetIdx = others[Math.floor(Math.random()*others.length)];
  } else if (playable.length) {
    card = playable[Math.floor(Math.random() * playable.length)];
    const r = Math.random();
    if (r < 0.5) {
      action = 'embalm';
    } else if (r < 0.8) {
      action = 'skill';
    } else {
      action = 'suspect';
      const others = room.players.map((_,i)=>i).filter(i=>i!==pi);
      targetIdx = others[Math.floor(Math.random()*others.length)];
    }
  } else {
    card = hand[0]; action = 'embalm';
  }

  playCard(room, pi, card.id, action, targetIdx);
}

function botRespondPending(room) {
  const pa = room.pending;
  if (!pa) return;
  const pi = pa.initiator;
  const bot = room.players[pi];
  if (!bot || !bot.isBot) {
    if (pa.type === 'shinbunbu' && pa.waiting) {
      pa.waiting.forEach(wi => {
        if (room.players[wi]?.isBot) {
          setTimeout(() => {
            if (!room.pending) return;
            const bp = room.players[wi];
            if (bp.hand.length) {
              const card = bp.hand[Math.floor(Math.random()*bp.hand.length)];
              handleResponse(room, wi, {cardId: card.id});
            }
          }, 600 + Math.random()*400);
        }
      });
    }
    return;
  }

  setTimeout(() => {
    if (!room.pending || room.pending !== pa) return;
    switch(pa.type) {
      case 'bancho':
        if (pa.step === 1) handleResponse(room, pi, {playerIdx: botPickOther(room, pi)});
        else if (pa.step === 2) {
          if (room.players[pi]?.hand.length)
            handleResponse(room, pi, {cardId: room.players[pi].hand[0].id});
          if (room.players[pa.target]?.isBot && pa.tCard===null && room.players[pa.target]?.hand.length)
            handleResponse(room, pa.target, {cardId: room.players[pa.target].hand[0].id});
        }
        break;
      case 'fuukiin':
        handleResponse(room, pi, {playerIdx: botPickOther(room, pi)});
        break;
      case 'hokennin':
        if (pa.step===1) handleResponse(room, pi, {playerIdx: botPickOther(room, pi, true)});
        else if (pa.step===2 && room.players[pa.target]?.faceUp.length)
          handleResponse(room, pi, {cardId: room.players[pa.target].faceUp[0].id});
        break;
      case 'ojousama':
        if (pa.step===1) handleResponse(room, pi, {playerIdx: botPickOther(room, pi, false, true)});
        else if (pa.step===2 && room.players[pi]?.hand.length)
          handleResponse(room, pi, {cardId: room.players[pi].hand[0].id});
        break;
      case 'kitakubu':
        if (pa.step===1 && room.players[pi]?.hand.length)
          handleResponse(room, pi, {cardId: room.players[pi].hand[0].id});
        else if (pa.step===2)
          handleResponse(room, pi, {pos: 0});
        break;
      case 'kyouhan':
        if (pa.step===1) handleResponse(room, pi, {playerIdx: botPickWithSuspects(room, pi)});
        else if (pa.step===2) handleResponse(room, pi, {pos: 0});
        else if (pa.step===3) handleResponse(room, pi, {playerIdx: botPickOther(room, pi)});
        break;
      default:
        break;
    }
  }, 800 + Math.random()*600);
}

function botPickOther(room, myPi, needFaceUp=false, needHand=false) {
  const others = room.players.map((_,i)=>i).filter(i=>{
    if (i===myPi) return false;
    if (needFaceUp && !room.players[i].faceUp.some(c=>c.name!=='保健委员')) return false;
    if (needHand && !room.players[i].hand.length) return false;
    return true;
  });
  if (!others.length) return (myPi+1)%room.players.length;
  return others[Math.floor(Math.random()*others.length)];
}

function botPickWithSuspects(room, myPi) {
  const valid = room.players.map((_,i)=>i).filter(i=>room.players[i].suspects.length>0);
  if (!valid.length) return (myPi+1)%room.players.length;
  return valid[Math.floor(Math.random()*valid.length)];
}

function getRoom(socketId) {
  for (const r of Object.values(rooms)) {
    if (r.players.some(p => p.socketId === socketId)) return r;
  }
  return null;
}

function pidx(room, socketId) {
  return room.players.findIndex(p => p.socketId === socketId);
}

// ============ 广播 ============
function pub(room) {
  const state = {
    code: room.code,
    phase: room.phase,
    curIdx: room.curIdx,
    embalmCount: room.embalm.length,
    pending: room.pending ? { type: room.pending.type, initiator: room.pending.initiator, step: room.pending.step, waiting: room.pending.waiting } : null,
    log: room.log.slice(-30),
    players: room.players.map((p, i) => ({
      i, name: p.name,
      handCount: p.hand.length,
      faceUp: p.faceUp,
      suspectCount: p.suspects.length,
      isRetired: p.isRetired,
      hasRetired: p.isRetired,
    })),
  };
  io.to(room.code).emit('state', state);
  room.players.forEach(p => io.to(p.socketId).emit('hand', p.hand));
}

function log(room, msg) { room.log.push(msg); }

// ============ 游戏开始 ============
function startGame(room) {
  const n = room.players.length;
  const deck = buildDeck(n);
  const per = Math.floor(deck.length / n);

  room.phase = 'playing';
  room.embalm = [];
  room.pending = null;
  room.infectPending = null;
  room.log = [];

  room.players.forEach((p, i) => {
    p.hand = deck.slice(i * per, (i + 1) * per);
    p.faceUp = [];
    p.suspects = [];
    p.retired = null;
    p.isRetired = false;
  });

  let start = 0;
  room.players.forEach((p, i) => {
    if (p.hand.some(c => c.name === '学生会长')) start = i;
  });
  room.curIdx = start;

  log(room, `游戏开始！${n}人局，每人${per}张牌，目标MP: ${TARGET_MP[n]}`);
  log(room, `${room.players[start].name} 持有学生会长，先行动`);
  pub(room);
  promptTurn(room);
}

function promptTurn(room) {
  const p = room.players[room.curIdx];
  if (!p || p.isRetired) return;
  if (p.isBot) {
    botDelay(room);
  } else {
    io.to(p.socketId).emit('your_turn', { idx: room.curIdx });
  }
}

// ============ 暂退检查 ============
function checkRetire(room, idx) {
  const p = room.players[idx];
  if (!p.isRetired && p.hand.length === 1) {
    p.isRetired = true;
    p.retired = p.hand[0];
    p.hand = [];
    log(room, `${p.name} 手牌仅剩1张，进入暂退`);
    return true;
  }
  return false;
}

function checkEnd(room) {
  if (room.players.every(p => p.isRetired)) { endGame(room); return true; }
  return false;
}

function nextTurn(room) {
  if (checkEnd(room)) return;
  let next = (room.curIdx + 1) % room.players.length;
  let tries = 0;
  while (room.players[next].isRetired && tries++ < room.players.length) {
    next = (next + 1) % room.players.length;
  }
  if (tries >= room.players.length) { endGame(room); return; }
  room.curIdx = next;

  if (room.infectPending && room.infectPending.pi === next) {
    const inf = room.players[next];
    const still = inf.faceUp.some(c => c.id === room.infectPending.cid);
    if (still && room.embalm.length > 0) {
      const taken = room.embalm.shift();
      inf.hand.push(taken);
      log(room, `${inf.name} 的感染者效果触发，从调和区取得一张牌`);
    }
    room.infectPending = null;
  }

  pub(room);
  promptTurn(room);
}

// ============ 执行出牌 ============
function playCard(room, pi, cardId, action, targetIdx) {
  const player = room.players[pi];
  const card = player.hand.find(c => c.id === cardId);
  if (!card) return;
  if (card.name === '犯人' && action === 'skill') {
    io.to(player.socketId).emit('err', '犯人无法使用技能！');
    return;
  }

  player.hand = player.hand.filter(c => c.id !== cardId);

  if (action === 'embalm') {
    room.embalm.push(card);
    log(room, `${player.name} 将牌放入调和区`);
    checkRetire(room, pi);
    pub(room);
    nextTurn(room);

  } else if (action === 'suspect') {
    room.players[targetIdx].suspects.push(card);
    log(room, `${player.name} 将牌作为嫌疑牌放在 ${room.players[targetIdx].name} 面前`);
    checkRetire(room, pi);
    pub(room);
    nextTurn(room);

  } else {
    player.faceUp.push(card);
    log(room, `${player.name} 使用了 ${card.name} 的技能`);
    checkRetire(room, pi);
    execSkill(room, pi, card);
    if (room.pending && player.isBot) botRespondPending(room);
  }
}

// ============ 技能执行 ============
function execSkill(room, pi, card) {
  const player = room.players[pi];

  switch (card.name) {
    case '学生会长':
      log(room, `${player.name} 使用了学生会长（先手效果已在开始时生效）`);
      pub(room); nextTurn(room);
      break;

    case '外星人':
      log(room, `${player.name} 正面打出外星人，无效果`);
      pub(room); nextTurn(room);
      break;

    case '感染者':
      room.infectPending = { pi, cid: card.id };
      log(room, `${player.name} 的感染者效果将在下回合触发`);
      pub(room); nextTurn(room);
      break;

    case '优等生': {
      let crimHolder = -1;
      room.players.forEach((p, i) => {
        if (p.hand.some(c => c.name === '犯人')) crimHolder = i;
        if (p.isRetired && p.retired && p.retired.name === '犯人') crimHolder = i;
      });
      let alienHolder = -1;
      room.players.forEach((p, i) => {
        if (p.hand.some(c => c.name === '外星人')) alienHolder = i;
        if (p.isRetired && p.retired && p.retired.name === '外星人') alienHolder = i;
      });
      let msg = '';
      if (crimHolder >= 0) msg += `犯人在 ${room.players[crimHolder].name} 手中`;
      else msg += '犯人不在任何人手牌中';
      if (alienHolder >= 0 && alienHolder !== pi) msg += `；外星人在 ${room.players[alienHolder].name} 手中（可冒充犯人）`;
      io.to(player.socketId).emit('private', { type: 'youtosei', msg });
      log(room, `${player.name} 使用优等生，获得了秘密情报`);
      pub(room); nextTurn(room);
      break;
    }

    case '风纪委员':
      room.pending = { type: 'fuukiin', step: 1, initiator: pi };
      io.to(player.socketId).emit('prompt', {
        type: 'pick_player', msg: '风纪委员：选择1名玩家查看其全部手牌',
        exclude: [pi], onlyActive: true,
      });
      pub(room);
      break;

    case '班长':
      room.pending = { type: 'bancho', step: 1, initiator: pi, target: null, iCard: null, tCard: null };
      io.to(player.socketId).emit('prompt', {
        type: 'pick_player', msg: '班长：选择1名玩家与你交换手牌',
        exclude: [pi], onlyActive: false,
      });
      pub(room);
      break;

    case '保健委员': {
      const valid = room.players.map((p, i) => ({ p, i }))
        .filter(({ p, i }) => i !== pi && p.faceUp.some(c => c.name !== '保健委员'));
      if (!valid.length) {
        log(room, '保健委员：无可选目标');
        pub(room); nextTurn(room);
      } else {
        room.pending = { type: 'hokennin', step: 1, initiator: pi, target: null };
        io.to(player.socketId).emit('prompt', {
          type: 'pick_player', msg: '保健委员：选择1名玩家取走其已使用的1张牌',
          validTargets: valid.map(x => x.i),
        });
        pub(room);
      }
      break;
    }

    case '图书委员':
      io.to(player.socketId).emit('private', {
        type: 'library', msg: `调和区 ${room.embalm.length} 张牌（从上到下）：`,
        cards: room.embalm.map(c => c.name),
      });
      log(room, `${player.name} 查看了调和区`);
      pub(room); nextTurn(room);
      break;

    case '大小姐': {
      const valid = room.players.map((p, i) => i).filter(i => i !== pi && room.players[i].hand.length > 0);
      if (!valid.length) {
        log(room, '大小姐：无可选目标');
        pub(room); nextTurn(room);
      } else {
        room.pending = { type: 'ojousama', step: 1, initiator: pi, target: null, drawn: null };
        io.to(player.socketId).emit('prompt', {
          type: 'pick_player', msg: '大小姐：选择1名玩家，随机取走其1张手牌',
          validTargets: valid,
        });
        pub(room);
      }
      break;
    }

    case '新闻部': {
      const parts = room.players.map((p, i) => i).filter(i => !room.players[i].isRetired && room.players[i].hand.length > 0);
      if (parts.length <= 1) {
        log(room, '新闻部：参与人数不足');
        pub(room); nextTurn(room);
      } else {
        room.pending = { type: 'shinbunbu', initiator: pi, parts, sel: {}, waiting: [...parts] };
        parts.forEach(i => {
          io.to(room.players[i].socketId).emit('prompt', {
            type: 'pick_hand', msg: '新闻部：选择1张手牌传给左边玩家',
            cards: room.players[i].hand,
          });
        });
        pub(room);
      }
      break;
    }

    case '归宅部':
      if (!room.embalm.length) {
        log(room, '归宅部：调和区为空');
        pub(room); nextTurn(room);
      } else {
        room.pending = { type: 'kitakubu', step: 1, initiator: pi, hCard: null };
        io.to(player.socketId).emit('prompt', {
          type: 'pick_hand', msg: '归宅部：选择1张手牌与调和区的牌交换',
          cards: player.hand,
        });
        pub(room);
      }
      break;

    case '共犯': {
      const withS = room.players.map((p, i) => i).filter(i => room.players[i].suspects.length > 0);
      if (!withS.length) {
        log(room, '共犯：无嫌疑牌可移动');
        pub(room); nextTurn(room);
      } else {
        room.pending = { type: 'kyouhan', step: 1, initiator: pi, srcPi: null, sPos: null };
        io.to(player.socketId).emit('prompt', {
          type: 'pick_player', msg: '共犯：选择有嫌疑牌的玩家',
          validTargets: withS,
        });
        pub(room);
      }
      break;
    }

    default:
      log(room, `未知技能: ${card.name}`);
      pub(room); nextTurn(room);
  }
}

// ============ 技能回应处理 ============
function handleResponse(room, pi, data) {
  const pa = room.pending;
  if (!pa) return;
  switch (pa.type) {
    case 'bancho':    resolveBancho(room, pi, data); break;
    case 'fuukiin':   resolveFuukiin(room, pi, data); break;
    case 'hokennin':  resolveHokennin(room, pi, data); break;
    case 'ojousama':  resolveOjousama(room, pi, data); break;
    case 'shinbunbu': resolveShinbunbu(room, pi, data); break;
    case 'kitakubu':  resolveKitakubu(room, pi, data); break;
    case 'kyouhan':   resolveKyouhan(room, pi, data); break;
  }
}

function resolveBancho(room, pi, data) {
  const pa = room.pending;
  if (pa.step === 1 && pi === pa.initiator) {
    pa.target = data.playerIdx;
    pa.step = 2;
    const ip = room.players[pa.initiator], tp = room.players[pa.target];
    io.to(ip.socketId).emit('prompt', { type: 'pick_hand', msg: `班长：选择1张手牌传给 ${tp.name}`, cards: ip.hand });
    io.to(tp.socketId).emit('prompt', { type: 'pick_hand', msg: `班长：${ip.name} 要与你交换手牌，选择1张传给他`, cards: tp.hand });
    pub(room);
  } else if (pa.step === 2) {
    if (pi === pa.initiator) pa.iCard = data.cardId;
    else if (pi === pa.target) pa.tCard = data.cardId;
    if (pa.iCard !== null && pa.tCard !== null) {
      const ip = room.players[pa.initiator], tp = room.players[pa.target];
      const ic = ip.hand.find(c => c.id === pa.iCard);
      const tc = tp.hand.find(c => c.id === pa.tCard);
      if (ic && tc) {
        ip.hand = ip.hand.filter(c => c.id !== pa.iCard);
        tp.hand = tp.hand.filter(c => c.id !== pa.tCard);
        ip.hand.push(tc); tp.hand.push(ic);
        log(room, `${ip.name} 和 ${tp.name} 互换了1张手牌`);
        checkRetire(room, pa.initiator); checkRetire(room, pa.target);
      }
      room.pending = null; pub(room); nextTurn(room);
    } else { pub(room); }
  }
}

function resolveFuukiin(room, pi, data) {
  if (pi !== room.pending.initiator) return;
  const tp = room.players[data.playerIdx];
  io.to(room.players[pi].socketId).emit('private', { type: 'hand_view', name: tp.name, cards: tp.hand });
  log(room, `${room.players[pi].name} 查看了 ${tp.name} 的手牌`);
  room.pending = null; pub(room); nextTurn(room);
}

function resolveHokennin(room, pi, data) {
  const pa = room.pending;
  if (pi !== pa.initiator) return;
  if (pa.step === 1) {
    pa.target = data.playerIdx; pa.step = 2;
    const tp = room.players[pa.target];
    const valid = tp.faceUp.filter(c => c.name !== '保健委员');
    io.to(room.players[pi].socketId).emit('prompt', {
      type: 'pick_faceup', msg: `选择 ${tp.name} 已使用的1张牌加入手中`,
      targetIdx: pa.target, cards: valid,
    });
    pub(room);
  } else {
    const ip = room.players[pa.initiator], tp = room.players[pa.target];
    const c = tp.faceUp.find(x => x.id === data.cardId);
    if (c && c.name !== '保健委员') {
      tp.faceUp = tp.faceUp.filter(x => x.id !== data.cardId);
      ip.hand.push(c);
      log(room, `${ip.name} 从 ${tp.name} 处取得了 ${c.name}`);
    }
    room.pending = null; pub(room); nextTurn(room);
  }
}

function resolveOjousama(room, pi, data) {
  const pa = room.pending;
  if (pi !== pa.initiator) return;
  if (pa.step === 1) {
    pa.target = data.playerIdx;
    const tp = room.players[pa.target];
    if (!tp.hand.length) { room.pending = null; pub(room); nextTurn(room); return; }
    const ri = Math.floor(Math.random() * tp.hand.length);
    pa.drawn = tp.hand.splice(ri, 1)[0];
    const ip = room.players[pa.initiator];
    ip.hand.push(pa.drawn);
    pa.step = 2;
    log(room, `${ip.name} 从 ${tp.name} 随机取走1张牌`);
    io.to(ip.socketId).emit('prompt', {
      type: 'pick_hand_return', msg: `大小姐：选1张手牌还给 ${tp.name}（你刚取到：${pa.drawn.name}）`,
      cards: ip.hand, drawn: pa.drawn,
    });
    pub(room);
  } else {
    const ip = room.players[pa.initiator], tp = room.players[pa.target];
    const c = ip.hand.find(x => x.id === data.cardId);
    if (c) { ip.hand = ip.hand.filter(x => x.id !== data.cardId); tp.hand.push(c); }
    log(room, `${ip.name} 将1张牌还给了 ${tp.name}`);
    room.pending = null; pub(room); nextTurn(room);
  }
}

function resolveShinbunbu(room, pi, data) {
  const pa = room.pending;
  if (!pa.parts.includes(pi)) return;
  pa.sel[pi] = data.cardId;
  pa.waiting = pa.waiting.filter(i => i !== pi);
  if (pa.waiting.length === 0) {
    const pulled = {};
    pa.parts.forEach(i => {
      const p = room.players[i];
      const c = p.hand.find(x => x.id === pa.sel[i]);
      if (c) { pulled[i] = c; p.hand = p.hand.filter(x => x.id !== pa.sel[i]); }
    });
    pa.parts.forEach(i => {
      const leftIdx = (pa.parts.indexOf(i) + 1) % pa.parts.length;
      const leftPi = pa.parts[leftIdx];
      if (pulled[i]) room.players[leftPi].hand.push(pulled[i]);
    });
    log(room, `新闻部：所有玩家将1张牌传给左边玩家`);
    pa.parts.forEach(i => checkRetire(room, i));
    room.pending = null; pub(room); nextTurn(room);
  } else {
    log(room, `新闻部：等待 ${pa.waiting.length} 名玩家选择…`);
    pub(room);
  }
}

function resolveKitakubu(room, pi, data) {
  const pa = room.pending;
  if (pi !== pa.initiator) return;
  if (pa.step === 1) {
    pa.hCard = data.cardId; pa.step = 2;
    io.to(room.players[pi].socketId).emit('prompt', {
      type: 'pick_embalm_pos', msg: `归宅部：选择调和区中第几张牌（共 ${room.embalm.length} 张）`,
      count: room.embalm.length,
    });
    pub(room);
  } else {
    const p = room.players[pi];
    const pos = Math.min(data.pos, room.embalm.length - 1);
    const hc = p.hand.find(c => c.id === pa.hCard);
    if (hc && room.embalm.length > 0) {
      p.hand = p.hand.filter(c => c.id !== pa.hCard);
      const ec = room.embalm.splice(pos, 1)[0];
      room.embalm.splice(pos, 0, hc);
      p.hand.push(ec);
      log(room, `${p.name} 将手牌与调和区第${pos + 1}张牌互换`);
    }
    room.pending = null; pub(room); nextTurn(room);
  }
}

function resolveKyouhan(room, pi, data) {
  const pa = room.pending;
  if (pi !== pa.initiator) return;
  if (pa.step === 1) {
    pa.srcPi = data.playerIdx; pa.step = 2;
    const sp = room.players[pa.srcPi];
    io.to(room.players[pi].socketId).emit('prompt', {
      type: 'pick_suspect', msg: `共犯：选择要移动 ${sp.name} 面前的第几张嫌疑牌`,
      count: sp.suspects.length,
    });
    pub(room);
  } else if (pa.step === 2) {
    pa.sPos = data.pos; pa.step = 3;
    const valid = room.players.map((p, i) => i).filter(i => i !== pa.srcPi);
    io.to(room.players[pi].socketId).emit('prompt', {
      type: 'pick_player', msg: '共犯：将嫌疑牌移到哪个玩家面前？',
      validTargets: valid,
    });
    pub(room);
  } else {
    const sp = room.players[pa.srcPi], dp = room.players[data.playerIdx];
    if (pa.sPos < sp.suspects.length) {
      const c = sp.suspects.splice(pa.sPos, 1)[0];
      dp.suspects.push(c);
      log(room, `${room.players[pi].name} 将嫌疑牌从 ${sp.name} 移至 ${dp.name} 面前`);
    }
    room.pending = null; pub(room); nextTurn(room);
  }
}

// ============ 游戏结算 ============
function endGame(room) {
  room.phase = 'gameover';
  const n = room.players.length;
  const target = TARGET_MP[n];
  const embMP = room.embalm.reduce((s, c) => s + c.mp, 0);
  const success = embMP >= target;

  log(room, `--- 游戏结束 ---`);
  log(room, `调和区MP合计: ${embMP} / 目标: ${target} → 调和${success ? '✓成功' : '✗失败'}`);

  const suspTotals = room.players.map(p => p.suspects.reduce((s, c) => s + c.mp, 0));
  const maxSusp = Math.max(...suspTotals);
  const imprisoned = suspTotals.map((t, i) => t === maxSusp ? i : -1).filter(i => i >= 0);

  log(room, `嫌疑值最高 ${maxSusp}：${imprisoned.map(i => room.players[i].name).join('、')} 被监禁`);

  const identity = room.players.map(p => p.retired || (p.hand[0]) || null);

  const crimIdx = identity.findIndex(c => c && c.name === '犯人');
  const crimImprisoned = crimIdx >= 0 && imprisoned.includes(crimIdx);

  const wins = identity.map((c, i) => {
    if (!c) return false;
    switch (c.win) {
      case 'imprisoned':     return imprisoned.includes(i);
      case 'embalm_fail':    return !success;
      case 'not_imprisoned': return !imprisoned.includes(i);
      case 'criminal_wins':  return !crimImprisoned;
      case 'embalm_success': return success;
      default: return false;
    }
  });

  identity.forEach((c, i) => {
    if (c && c.win === 'no_winner') {
      wins[i] = !wins.some((w, j) => w && identity[j] && identity[j].win !== 'no_winner');
    }
  });

  const winners = room.players.filter((_, i) => wins[i]).map(p => p.name);
  log(room, `胜利者：${winners.length ? winners.join('、') : '无人获胜'}`);

  const result = {
    embMP, target, success,
    imprisoned: imprisoned.map(i => room.players[i].name),
    players: room.players.map((p, i) => ({
      name: p.name,
      identity: identity[i] ? identity[i].name : '?',
      suspectCards: p.suspects.map(c => c.name),
      suspTotal: suspTotals[i],
      wins: wins[i],
      hand: p.hand,
      faceUp: p.faceUp,
    })),
    winners,
  };

  pub(room);
  io.to(room.code).emit('gameover', result);
}

// ============ Socket 连接 ============
io.on('connection', socket => {
  console.log('connected:', socket.id);

  socket.on('create', ({ name }) => {
    const code = newRoom(socket.id, name);
    socket.join(code);
    socket.emit('joined', { code, isHost: true });
    pub(rooms[code]);
  });

  socket.on('join', ({ code, name }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) return socket.emit('err', '房间不存在');
    if (room.phase !== 'lobby') return socket.emit('err', '游戏已开始');
    if (room.players.length >= 6) return socket.emit('err', '房间已满（最多6人）');
    room.players.push(newPlayer(socket.id, name));
    socket.join(room.code);
    socket.emit('joined', { code: room.code, isHost: false });
    log(room, `${name} 加入了房间`);
    pub(room);
  });

  socket.on('start', () => {
    const room = getRoom(socket.id);
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 3) return socket.emit('err', '至少需要3名玩家');
    if (room.phase !== 'lobby') return;
    startGame(room);
  });

  socket.on('test_mode', () => {
    const room = getRoom(socket.id);
    if (!room || room.host !== socket.id || room.phase !== 'lobby') return;
    while (room.players.length < 3) {
      const idx = room.players.filter(p => p.isBot).length + 1;
      room.players.push(newPlayer('bot_' + idx, `机器人${idx}`, true));
    }
    log(room, `测试模式：已补充机器人`);
    pub(room);
    startGame(room);
  });

  socket.on('play', ({ cardId, action, targetIdx }) => {
    const room = getRoom(socket.id);
    if (!room || room.phase !== 'playing' || room.pending) return;
    const pi = pidx(room, socket.id);
    if (pi !== room.curIdx) return;
    playCard(room, pi, cardId, action, targetIdx);
  });

  socket.on('resp', data => {
    const room = getRoom(socket.id);
    if (!room || !room.pending) return;
    const pi = pidx(room, socket.id);
    handleResponse(room, pi, data);
    if (room.pending) botRespondPending(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket.id);
    if (!room) return;
    if (room.phase === 'lobby') {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if (!room.players.length) { delete rooms[room.code]; return; }
      if (room.host === socket.id) room.host = room.players[0].socketId;
      pub(room);
    } else {
      const p = room.players.find(p => p.socketId === socket.id);
      if (p) log(room, `${p.name} 断开了连接`);
      pub(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`服务器运行在 http://localhost:${PORT}`));
