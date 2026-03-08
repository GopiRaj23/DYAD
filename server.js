const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Room storage: roomCode → room state
const rooms = new Map();

// Generate a short, readable room code (e.g. "AB12CD")
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars like 0/O, 1/I
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] User connected: ${socket.id}`);

  // ─────────────────────────────────────────────
  // HOST: Creates a new room with a YouTube video
  // ─────────────────────────────────────────────
  socket.on('create-room', ({ videoId }) => {
    // Keep generating until we get a unique code
    let roomCode;
    do { roomCode = generateRoomCode(); } while (rooms.has(roomCode));

    rooms.set(roomCode, {
      hostId: socket.id,
      videoId,
      timestamp: 0,       // Current video position in seconds
      isPlaying: false,   // Is the video currently playing?
      lastUpdate: Date.now(), // When was the state last updated?
      guestCount: 0
    });

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.isHost = true;

    socket.emit('room-created', { roomCode, videoId });
    console.log(`[Room] Created: ${roomCode} | Video: ${videoId}`);
  });

  // ─────────────────────────────────────────────
  // GUEST: Joins an existing room
  // ─────────────────────────────────────────────
  socket.on('join-room', ({ roomCode }) => {
    const code = roomCode.trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
      socket.emit('join-error', { message: 'Room not found. Double-check the code and try again.' });
      return;
    }

    socket.join(code);
    socket.roomCode = code;
    socket.isHost = false;
    room.guestCount++;

    // Calculate the current estimated timestamp
    // If video was playing, add elapsed time since last update
    const elapsed = room.isPlaying ? (Date.now() - room.lastUpdate) / 1000 : 0;
    const currentTimestamp = room.timestamp + elapsed;

    // Send guest the current room state so they can jump to the right spot
    socket.emit('room-joined', {
      videoId: room.videoId,
      timestamp: currentTimestamp,
      isPlaying: room.isPlaying
    });

    // Tell the host someone joined + share host's peer ID with guest (if available)
    io.to(room.hostId).emit('guest-joined', {
      guestCount: room.guestCount,
      guestSocketId: socket.id
    });

    // If host already registered a peer ID, send it to the guest now
    if (room.hostPeerId) {
      socket.emit('host-peer-id', { peerId: room.hostPeerId });
    }

    console.log(`[Room] Guest joined: ${code} | Guests: ${room.guestCount}`);
  });

  // ─────────────────────────────────────────────
  // VOICE: Users register their PeerJS peer ID
  // Server relays IDs so they can call each other
  // ─────────────────────────────────────────────
  socket.on('register-peer', ({ peerId }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    if (socket.isHost) {
      // Store host peer ID; if a guest is already in the room, send it to them
      room.hostPeerId = peerId;
      socket.to(socket.roomCode).emit('host-peer-id', { peerId });
      console.log(`[Voice] Host peer registered: ${peerId}`);
    } else {
      // Guest peer ID → send to host so host can call back if needed
      io.to(room.hostId).emit('guest-peer-id', { peerId });
      console.log(`[Voice] Guest peer registered: ${peerId}`);
    }
  });

  // ─────────────────────────────────────────────
  // SYNC: Either user can play/pause/seek
  // "Last writer wins" — most recent event wins
  // ─────────────────────────────────────────────
  socket.on('sync-event', ({ type, timestamp }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    // Update canonical room state
    room.timestamp = timestamp;
    room.lastUpdate = Date.now();
    if (type === 'play')  room.isPlaying = true;
    if (type === 'pause') room.isPlaying = false;

    // Broadcast to everyone EXCEPT the sender
    socket.to(socket.roomCode).emit('sync-event', { type, timestamp });
    console.log(`[Sync] ${socket.roomCode} | ${type} @ ${timestamp.toFixed(1)}s`);
  });

  // ─────────────────────────────────────────────
  // EMOJI: Broadcast a reaction emoji to the room
  // ─────────────────────────────────────────────
  socket.on('send-emoji', ({ emoji }) => {
    if (!socket.roomCode) return;
    // Send ONLY to the other person (not back to sender)
    socket.to(socket.roomCode).emit('receive-emoji', { emoji });
    console.log(`[Emoji] ${socket.roomCode} | ${emoji}`);
  });

  // ─────────────────────────────────────────────
  // NEXT VIDEO: Either user can queue the next URL
  // ─────────────────────────────────────────────
  socket.on('change-video', ({ videoId }) => {
    if (!socket.roomCode) return;
    const room = rooms.get(socket.roomCode);
    if (!room) return;

    // Reset room state for the new video
    room.videoId = videoId;
    room.timestamp = 0;
    room.isPlaying = false;
    room.lastUpdate = Date.now();

    // Tell EVERYONE in the room (including sender) to switch
    io.to(socket.roomCode).emit('change-video', { videoId });
    console.log(`[Video] ${socket.roomCode} | New video: ${videoId}`);
  });

  // ─────────────────────────────────────────────
  // DISCONNECT: Clean up rooms when host leaves
  // ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] User disconnected: ${socket.id}`);

    if (socket.isHost && socket.roomCode) {
      socket.to(socket.roomCode).emit('host-disconnected');
      rooms.delete(socket.roomCode);
      console.log(`[Room] Closed: ${socket.roomCode}`);
    } else if (!socket.isHost && socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room && room.guestCount > 0) room.guestCount--;
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('  🎬  TogeWatch is running!');
  console.log(`  👉  Open: http://localhost:${PORT}`);
  console.log('');
});
