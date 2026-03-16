const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const Database = require('better-sqlite3');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

// ── SQLite: beta feedback DB ──────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'beta_feedback.db'));
db.prepare(`CREATE TABLE IF NOT EXISTS beta_feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT    NOT NULL,
  username     TEXT    NOT NULL,
  feedbacktext TEXT    NOT NULL,
  label        TEXT    NOT NULL,
  fix_status   TEXT    NOT NULL DEFAULT 'unassigned'
)`).run();
// ─────────────────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/feedback — save beta feedback entry
app.post('/api/feedback', (req, res) => {
  const { username, feedbacktext, label } = req.body || {};
  if (!username || !feedbacktext || !label)
    return res.status(400).json({ error: 'Missing fields' });
  if (feedbacktext.length > 1000)
    return res.status(400).json({ error: 'Feedback too long (max 1000 chars)' });
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  db.prepare(
    'INSERT INTO beta_feedback (date, username, feedbacktext, label, fix_status) VALUES (?, ?, ?, ?, ?)'
  ).run(date, username.trim(), feedbacktext.trim(), label, 'unassigned');
  res.json({ ok: true });
});

const rooms = new Map();

const WORDS = [
  'elephant','penguin','dolphin','flamingo','chameleon','platypus','crocodile',
  'porcupine','scorpion','peacock','toucan','octopus','jellyfish','butterfly',
  'cheetah','gorilla','narwhal','axolotl','hedgehog','armadillo','mongoose',
  'salamander','piranha','pelican','vulture','wolverine','lobster','ostrich',
  'pizza','spaghetti','croissant','avocado','watermelon','pineapple','sushi',
  'burrito','dumpling','pretzel','cinnamon','broccoli','eggplant','lemonade',
  'pancake','waffle','kebab','ramen','churro','cheesecake','nachos','macaron',
  'volcano','glacier','waterfall','lightning','tornado','blizzard','aurora',
  'rainbow','canyon','lagoon','geyser','stalactite','avalanche','quicksand',
  'thunderstorm','eclipse','whirlpool','iceberg','desert','tundra','rainforest',
  'umbrella','telescope','compass','hourglass','lantern','anchor','diamond',
  'binoculars','parachute','trampoline','saxophone','typewriter','kaleidoscope',
  'periscope','boomerang','hammock','windmill','catapult','sundial','pendulum',
  'accordion','microscope','thermometer','barometer','tambourine','magnifying',
  'dragon','mermaid','wizard','pyramid','sphinx','castle','lighthouse','galaxy',
  'comet','nebula','satellite','asteroid','rocket','submarine','treasure',
  'labyrinth','potion','cathedral','spaceship','portal','dungeon','unicorn',
  'hospital','library','museum','aquarium','observatory','fortress','monastery',
  'igloo','mansion','harbour','amphitheatre','skyscraper','greenhouse','bridge',
  'sunrise','thunder','snowflake','shadow','reflection','explosion','constellation',
  'camouflage','metamorphosis','migration','hibernation','photosynthesis',
  'skateboard','surfboard','archery','fencing','bobsled','kayak','tightrope',
  'trapeze','paragliding','gymnastics','snowboarding','windsurfing','marathon',
  'cactus','mushroom','spider','violin','sunflower','ladder','chimney','candle',
  'shield','sword','passport','guitar','bicycle','ocean','pirate','astronaut',
  'mountain','geyser','blizzard','compass','diamond','mermaid','castle','volcano'
];

function pickFourWords(usedWords) {
  const available = WORDS.filter(w => !usedWords.has(w));
  const pool = available.length >= 4 ? available : WORDS;
  return [...pool].sort(() => Math.random() - 0.5).slice(0, 4);
}

function generateRoomCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += c[Math.floor(Math.random() * c.length)];
  return code;
}

// FIX 1: Fisher-Yates shuffle for random drawer order
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeScribble() {
  return {
    active: false,
    paused: false,   // FIX 3: game pause state
    word: null, wordChoices: [],
    drawerId: null, drawerName: null,
    roundTimer: null, wordChoiceTimer: null,
    timeLeft: 60,
    turnOrder: [], roundsCompleted: 0, totalRounds: 0, roundsPerPlayer: 1,
    scores: {}, guessedThisRound: [],
    revealedPositions: new Set(), hintsGiven: 0,
    usedWords: new Set()
  };
}

function buildScoreList(room) {
  return Array.from(room.participants.entries())
    .map(([id, name]) => ({ id, name, score: room.scribble.scores[id] || 0 }))
    .sort((a, b) => b.score - a.score);
}

function clearScribbleTimers(sc) {
  if (sc.roundTimer)      { clearInterval(sc.roundTimer); sc.roundTimer = null; }
  if (sc.wordChoiceTimer) { clearTimeout(sc.wordChoiceTimer);  sc.wordChoiceTimer = null; }
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  /* ── CREATE ROOM ── */
  socket.on('create-room', ({ videoId, username, mode }) => {
    let roomCode;
    do { roomCode = generateRoomCode(); } while (rooms.has(roomCode));

    rooms.set(roomCode, {
      mode: mode || 'stream',
      hostId: socket.id,
      hostName: username || 'Host',
      videoId: videoId || null,
      timestamp: 0, isPlaying: false, lastUpdate: Date.now(),
      peerIds: new Map(),
      participants: new Map([[socket.id, username || 'Host']]),
      playerTabs: new Map([[socket.id, 'watch']]),  // FIX 3: tab tracking
      chatHistory: [],  // v22: store last 80 messages for sync
      scribble: makeScribble()
    });

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;
    socket.username = username || 'Host';

    socket.emit('room-created', {
      roomCode, videoId, mode: mode || 'stream',
      participants: [username || 'Host']
    });
  });

  /* ── JOIN ROOM ── */
  socket.on('join-room', ({ roomCode, username }) => {
    const code = (roomCode || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) { socket.emit('join-error', { message: 'Room not found.' }); return; }

    socket.join(code);
    socket.roomCode = code;
    socket.isHost = false;
    socket.username = username || 'Guest';
    room.participants.set(socket.id, socket.username);
    room.playerTabs.set(socket.id, 'watch');  // FIX 3

    const elapsed = room.isPlaying ? (Date.now() - room.lastUpdate) / 1000 : 0;
    const participantList = Array.from(room.participants.values());

    socket.emit('room-joined', {
      roomCode: code,
      videoId: room.videoId, mode: room.mode,
      timestamp: room.timestamp + elapsed, isPlaying: room.isPlaying,
      hostName: room.hostName,
      guestCount: room.participants.size - 1,
      participants: participantList
    });

    const newCount = room.participants.size - 1;
    io.to(room.hostId).emit('guest-joined', {
      guestCount: newCount, guestName: socket.username, participants: participantList
    });
    socket.to(code).emit('user-presence', {
      username: socket.username, action: 'joined',
      guestCount: newCount, participants: participantList
    });

    /* ── Send chat history to the new joiner ── */
    if (room.chatHistory.length > 0) {
      socket.emit('chat-history', { messages: room.chatHistory });
    }

    /* ── Silent game sync for late joiners ── */
    const sc = room.scribble;
    if (sc.active) {
      sc.scores[socket.id] = 0;
      if (sc.word) {
        const blanks = [...sc.word].map((c, i) => sc.revealedPositions.has(i) ? c : '_').join(' ');
        socket.emit('game-sync', {
          phase: 'drawing', drawerId: sc.drawerId, drawerName: sc.drawerName,
          roundNum: sc.roundsCompleted + 1, totalRounds: sc.totalRounds,
          timeLeft: sc.timeLeft, scores: buildScoreList(room), blanks, wordLength: sc.word.length
        });
      } else {
        socket.emit('game-sync', {
          phase: 'choosing', drawerId: sc.drawerId, drawerName: sc.drawerName,
          roundNum: sc.roundsCompleted + 1, totalRounds: sc.totalRounds,
          timeLeft: null, scores: buildScoreList(room), blanks: null, wordLength: 0
        });
      }
    }
  });

  /* ── FIX 3: Tab tracking — pause/resume game when all leave InkMind ── */
  socket.on('tab-change', ({ tab }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    room.playerTabs.set(socket.id, tab);
    checkGamePauseState(socket.roomCode);
  });

  function checkGamePauseState(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const sc = room.scribble;
    if (!sc.active) return;

    const inkCount = [...room.playerTabs.values()].filter(t => t === 'ink').length;

    if (inkCount === 0 && !sc.paused) {
      // Everyone left InkMind — pause the game
      sc.paused = true;
      clearScribbleTimers(sc);
      io.to(roomCode).emit('game-paused', { reason: 'all-watching-video' });
    } else if (inkCount > 0 && sc.paused) {
      // Someone returned — resume
      sc.paused = false;
      io.to(roomCode).emit('game-resumed');
      // Restart current phase
      if (sc.word) {
        // Resume drawing — restart the round timer from current timeLeft
        resumeDrawing(roomCode);
      } else {
        startRound(roomCode);
      }
    }
  }

  /* ── VOICE ── */
  socket.on('register-peer', ({ peerId }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const existing = [...room.peerIds.entries()]
      .filter(([id]) => id !== socket.id).map(([, pid]) => pid);
    room.peerIds.set(socket.id, peerId);
    if (existing.length) socket.emit('existing-peers', { peerIds: existing });
    socket.to(socket.roomCode).emit('new-peer', { peerId });
  });

  /* ── VIDEO SYNC ── */
  socket.on('sync-event', ({ type, timestamp, sentAt }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    room.timestamp = timestamp; room.lastUpdate = Date.now();
    if (type === 'play')  room.isPlaying = true;
    if (type === 'pause') room.isPlaying = false;
    // Broadcast to ALL other sockets — host must also react to guest sync-events
    socket.to(socket.roomCode).emit('sync-event', {
      type, timestamp, sentAt,
      username: socket.username || 'Someone'
    });
  });

  socket.on('heartbeat', ({ timestamp, isPlaying }) => {
    if (!socket.roomCode || !socket.isHost) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    // v22: Extended from 1.5s to 3.5s — gives YouTube enough time to buffer+settle at a new
    // seek position before the host's heartbeat resumes authority over the room state.
    const msSinceSync = Date.now() - room.lastUpdate;
    const effectivePlaying = msSinceSync < 3500 ? room.isPlaying : isPlaying;
    const effectiveTimestamp = msSinceSync < 3500 ? room.timestamp + (room.isPlaying ? msSinceSync/1000 : 0) : timestamp;
    room.timestamp = effectiveTimestamp; room.isPlaying = effectivePlaying; room.lastUpdate = Date.now();
    socket.to(socket.roomCode).emit('heartbeat', { timestamp: effectiveTimestamp, isPlaying: effectivePlaying });
  });

  socket.on('send-emoji', ({ emoji }) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit('receive-emoji', { emoji });
  });

  socket.on('mention', ({ targetName, fromName, channel }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    // Find the target's socket id by username
    for (const [id, name] of room.participants) {
      if (name === targetName && id !== socket.id) {
        io.to(id).emit('mention', { fromName: fromName || socket.username, channel: channel || 'watch' });
        break;
      }
    }
  });

  socket.on('change-video', ({ videoId }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    room.videoId = videoId; room.timestamp = 0; room.isPlaying = true; room.lastUpdate = Date.now();
    socket.to(socket.roomCode).emit('watch-sync', { videoId, timestamp: 0, isPlaying: true });
    // v23: Notify all users (including sender) via chat
    const msg = { text: `📺 ${socket.username || 'Someone'} loaded a new video`, username: '⚙️ System', channel: 'watch', fromSelf_id: null };
    io.to(socket.roomCode).emit('chat-message', msg);
    if (room.chatHistory) { room.chatHistory.push(msg); if (room.chatHistory.length > 80) room.chatHistory.shift(); }
  });

  socket.on('watch-accepted', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const elapsed = room.isPlaying ? (Date.now() - room.lastUpdate) / 1000 : 0;
    socket.emit('watch-sync', {
      videoId: room.videoId, timestamp: room.timestamp + elapsed, isPlaying: room.isPlaying
    });
  });

  /* ── CHAT ── */
  socket.on('chat-message', ({ text, username, channel }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    // Store in chat history for new-joiner sync (v22)
    if (room) {
      room.chatHistory.push({ text, username: username || socket.username, channel: channel || 'watch', fromSelf_id: socket.id });
      if (room.chatHistory.length > 80) room.chatHistory.shift();
    }
    // Broadcast to ALL in room including sender (io.to vs socket.to).
    // fromSelf_id lets the sender's client suppress the echo (already shown locally).
    io.to(socket.roomCode).emit('chat-message', {
      text, username: username || socket.username,
      channel: channel || 'watch',
      fromSelf_id: socket.id
    });
  });
  socket.on('typing-start', ({ channel }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    if (!room.typers) room.typers = {};
    const ch = channel || 'watch';
    if (!room.typers[ch]) room.typers[ch] = new Map();
    room.typers[ch].set(socket.id, socket.username);
    const names = Array.from(room.typers[ch].values());
    socket.to(socket.roomCode).emit('typing-update', { channel: ch, names });
  });
  socket.on('typing-stop', ({ channel }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const ch = channel || 'watch';
    if (room.typers && room.typers[ch]) {
      room.typers[ch].delete(socket.id);
      const names = Array.from(room.typers[ch].values());
      socket.to(socket.roomCode).emit('typing-update', { channel: ch, names });
    }
  });

  /* ══════ INKMIND ══════ */
  socket.on('scribble-start', ({ roundsPerPlayer = 1 } = {}) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || room.participants.size < 2) return;
    const sc = room.scribble;
    clearScribbleTimers(sc);

    sc.active = true;
    sc.paused = false;
    sc.roundsCompleted = 0;
    sc.roundsPerPlayer = Math.max(1, Math.min(10, roundsPerPlayer));
    // FIX 1: shuffle so host is NOT always first drawer
    sc.turnOrder = shuffle(Array.from(room.participants.keys()));
    sc.totalRounds = sc.turnOrder.length * sc.roundsPerPlayer;
    sc.scores = {};
    sc.usedWords = new Set();
    for (const [id] of room.participants) sc.scores[id] = 0;

    io.to(socket.roomCode).emit('scribble-started', {
      totalRounds: sc.totalRounds, roundsPerPlayer: sc.roundsPerPlayer
    });
    startRound(socket.roomCode);
  });

  function startRound(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.scribble.active || room.scribble.paused) return;
    const sc = room.scribble;

    sc.drawerId = sc.turnOrder[0];
    sc.drawerName = room.participants.get(sc.drawerId) || 'Someone';
    sc.wordChoices = pickFourWords(sc.usedWords);
    sc.word = null;
    sc.guessedThisRound = [];
    sc.revealedPositions = new Set();
    sc.hintsGiven = 0;
    clearScribbleTimers(sc);

    io.to(roomCode).emit('round-start', {
      drawerName: sc.drawerName, drawerId: sc.drawerId,
      roundNum: sc.roundsCompleted + 1, totalRounds: sc.totalRounds, choiceTime: 10
    });
    io.to(sc.drawerId).emit('word-choice', { words: sc.wordChoices });

    sc.wordChoiceTimer = setTimeout(() => {
      sc.wordChoiceTimer = null;
      if (!sc.word) {
        sc.word = sc.wordChoices[Math.floor(Math.random() * sc.wordChoices.length)];
        beginDrawing(roomCode);
      }
    }, 10000);
  }

  socket.on('word-chosen', ({ word }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const sc = room.scribble;
    if (socket.id !== sc.drawerId || sc.word || !sc.wordChoices.includes(word)) return;
    if (sc.wordChoiceTimer) { clearTimeout(sc.wordChoiceTimer); sc.wordChoiceTimer = null; }
    sc.word = word;
    beginDrawing(socket.roomCode);
  });

  function beginDrawing(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.scribble.active) return;
    const sc = room.scribble;
    sc.timeLeft = 60;
    if (sc.word) sc.usedWords.add(sc.word.toLowerCase());

    io.to(roomCode).emit('drawing-started', {
      drawerName: sc.drawerName, drawerId: sc.drawerId,
      wordLength: sc.word.length, timeLeft: 60
    });
    io.to(sc.drawerId).emit('your-word', { word: sc.word });
    const blanks = sc.word.split('').map(() => '_').join(' ');
    for (const [sid] of room.participants) {
      if (sid !== sc.drawerId) io.to(sid).emit('word-blanks', { blanks });
    }
    startDrawingTimer(roomCode);
  }

  // FIX 3: separate timer start so we can resume it
  function startDrawingTimer(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const sc = room.scribble;
    if (sc.roundTimer) { clearInterval(sc.roundTimer); sc.roundTimer = null; }

    sc.roundTimer = setInterval(() => {
      if (sc.paused) return; // FIX 3: don't tick while paused
      sc.timeLeft--;
      io.to(roomCode).emit('scribble-tick', { timeLeft: sc.timeLeft });
      if (sc.timeLeft === 45 || sc.timeLeft === 30 || sc.timeLeft === 15) revealHint(roomCode);
      if (sc.timeLeft <= 0) {
        clearInterval(sc.roundTimer); sc.roundTimer = null;
        endRound(roomCode, 'timeout');
      }
    }, 1000);
  }

  // FIX 3: resume drawing from current timeLeft
  function resumeDrawing(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.scribble.active) return;
    const sc = room.scribble;
    // Re-emit drawing state so clients know we resumed
    io.to(roomCode).emit('drawing-resumed', {
      drawerId: sc.drawerId, drawerName: sc.drawerName,
      timeLeft: sc.timeLeft, wordLength: sc.word ? sc.word.length : 0
    });
    startDrawingTimer(roomCode);
  }

  function revealHint(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const sc = room.scribble;
    if (!sc.word) return;
    const maxReveal = Math.max(1, Math.floor(sc.word.length * 0.5));
    if (sc.hintsGiven >= maxReveal) return;
    const unrevealed = [...sc.word].map((_, i) => i).filter(i => !sc.revealedPositions.has(i));
    if (!unrevealed.length) return;
    const pos = unrevealed[Math.floor(Math.random() * unrevealed.length)];
    sc.revealedPositions.add(pos);
    sc.hintsGiven++;
    const hint = [...sc.word].map((c, i) => sc.revealedPositions.has(i) ? c : '_').join(' ');
    for (const [sid] of room.participants) {
      if (sid !== sc.drawerId) io.to(sid).emit('hint-reveal', { hint, timeLeft: sc.timeLeft });
    }
  }

  socket.on('scribble-guess', ({ text }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room || !room.scribble.active) return;
    const sc = room.scribble;
    if (socket.id === sc.drawerId || sc.guessedThisRound.includes(socket.id)) return;

    const guess = text.trim().toLowerCase();
    const word  = (sc.word || '').toLowerCase();

    if (guess === word) {
      const points = Math.round((10 + (sc.timeLeft / 60) * 90) / 10) * 10;
      const drawerBonus = sc.timeLeft >= 45 ? Math.max(20, points - 10) : 20;
      sc.scores[socket.id]   = (sc.scores[socket.id]   || 0) + points;
      sc.scores[sc.drawerId] = (sc.scores[sc.drawerId] || 0) + drawerBonus;
      sc.guessedThisRound.push(socket.id);

      io.to(socket.id).emit('your-correct-word', { word: sc.word });
      io.to(socket.roomCode).emit('correct-guess', {
        guesser: socket.username, guesserId: socket.id,
        points, drawerBonus, rank: sc.guessedThisRound.length,
        scores: buildScoreList(room)
      });

      const nonDrawers = [...room.participants.keys()].filter(id => id !== sc.drawerId);
      if (sc.guessedThisRound.length >= nonDrawers.length) {
        if (sc.roundTimer) { clearInterval(sc.roundTimer); sc.roundTimer = null; }
        setTimeout(() => endRound(socket.roomCode, 'all-guessed'), 1200);
      }
    } else {
      io.to(socket.roomCode).emit('chat-message', {
        text, username: socket.username, channel: 'scribble', fromSelf_id: socket.id
      });
    }
  });

  function endRound(roomCode, reason) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const sc = room.scribble;
    clearScribbleTimers(sc);

    io.to(roomCode).emit('round-end', { word: sc.word, reason, scores: buildScoreList(room) });
    sc.roundsCompleted++;

    if (sc.roundsCompleted >= sc.totalRounds) {
      sc.active = false;
      setTimeout(() => io.to(roomCode).emit('game-over', {
        rounds: sc.roundsCompleted, scores: buildScoreList(room)
      }), 3500);
      return;
    }
    sc.turnOrder.push(sc.turnOrder.shift());
    setTimeout(() => {
      if (room.scribble.active && !room.scribble.paused) startRound(roomCode);
    }, 3500);
  }

  socket.on('draw-event',   d  => { if (socket.roomCode) socket.to(socket.roomCode).emit('draw-event', d); });
  socket.on('canvas-clear', () => { if (socket.roomCode) socket.to(socket.roomCode).emit('canvas-clear'); });
  socket.on('canvas-undo',  () => { if (socket.roomCode) socket.to(socket.roomCode).emit('canvas-undo'); });

  socket.on('scribble-stop', () => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const sc = room.scribble;
    sc.active = false; sc.paused = false;
    clearScribbleTimers(sc);
    io.to(socket.roomCode).emit('scribble-stopped');
  });

  /* ── Host migration on disconnect ── */
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    // Clean up typers for this socket
    if (room.typers) {
      for (const ch of Object.keys(room.typers)) {
        if (room.typers[ch].has(socket.id)) {
          room.typers[ch].delete(socket.id);
          const names = Array.from(room.typers[ch].values());
          socket.to(socket.roomCode).emit('typing-update', { channel: ch, names });
        }
      }
    }

    if (socket.isHost) {
      // Remove host from participants
      room.participants.delete(socket.id);
      room.peerIds.delete(socket.id);
      room.playerTabs.delete(socket.id);

      if (room.participants.size === 0) {
        // Room is now empty — clean up
        clearScribbleTimers(room.scribble);
        rooms.delete(socket.roomCode);
        return;
      }

      // FIX 2: Promote the first remaining participant as new host
      const [newHostId, newHostName] = room.participants.entries().next().value;
      room.hostId   = newHostId;
      room.hostName = newHostName;

      // Mark the new host's socket as host
      const newHostSocket = io.sockets.sockets.get(newHostId);
      if (newHostSocket) newHostSocket.isHost = true;

      const participantList = Array.from(room.participants.values());
      io.to(socket.roomCode).emit('host-migrated', {
        newHostId, newHostName, participants: participantList
      });

      // Handle ongoing game
      const sc = room.scribble;
      if (sc.active) {
        // Remove departed host from turn order
        sc.turnOrder = sc.turnOrder.filter(id => id !== socket.id);
        if (sc.turnOrder.length < 1 || room.participants.size < 2) {
          clearScribbleTimers(sc);
          sc.active = false;
          io.to(socket.roomCode).emit('game-over', {
            rounds: sc.roundsCompleted, scores: buildScoreList(room)
          });
        } else if (sc.drawerId === socket.id) {
          // Departed host was drawing — end the round
          endRound(socket.roomCode, 'drawer-left');
        }
      }

    } else {
      // Regular guest leaves
      room.participants.delete(socket.id);
      room.peerIds.delete(socket.id);
      room.playerTabs.delete(socket.id);

      const guestCount = Math.max(0, room.participants.size - 1);
      const participantList = Array.from(room.participants.values());

      socket.to(socket.roomCode).emit('user-presence', {
        username: socket.username || 'Guest', action: 'left',
        guestCount, participants: participantList
      });

      const sc = room.scribble;
      if (sc.active) {
        sc.turnOrder = sc.turnOrder.filter(id => id !== socket.id);
        if (room.participants.size <= 1) {
          clearScribbleTimers(sc);
          sc.active = false;
          setTimeout(() => io.to(socket.roomCode).emit('game-over', {
            rounds: sc.roundsCompleted, scores: buildScoreList(room),
            winner: participantList[0] || 'You', reason: 'opponent-left'
          }), 500);
        } else if (sc.drawerId === socket.id) {
          if (sc.roundTimer) clearInterval(sc.roundTimer);
          endRound(socket.roomCode, 'drawer-left');
        }
        // FIX 3: re-check game pause state after player leaves
        checkGamePauseState(socket.roomCode);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('\n  🎨  DYAD / InkMind is running!');
  console.log(`  👉  http://localhost:${PORT}\n`);
});
