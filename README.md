# 🎬 TogeWatch — Setup Guide

## What you have
A working web app that lets two people watch YouTube in perfect sync.
- **Host**: Pastes a YouTube URL, gets a room code
- **Guest**: Enters the room code, instantly jumps to the right timestamp
- **Sync**: Every play/pause the host does is mirrored on the guest's screen

---

## Step 1 — Install Node.js (one time only)

1. Go to: **https://nodejs.org**
2. Click the big green **"LTS"** button to download
3. Run the installer — click Next, Next, Next, Install
4. Done ✅

---

## Step 2 — Set up the project

1. Put the **togewatch** folder somewhere easy, like your Desktop
2. Open your **Terminal** (Mac) or **Command Prompt** (Windows)
   - Mac: Press `Cmd + Space`, type "Terminal", hit Enter
   - Windows: Press `Windows key`, type "cmd", hit Enter
3. Navigate to the folder by typing:
   ```
   cd Desktop/togewatch
   ```
4. Install the app's tools (run once):
   ```
   npm install
   ```
   You'll see some text scroll by — that's normal!

---

## Step 3 — Run the app

In the same terminal, type:
```
npm start
```

You'll see:
```
  🎬  TogeWatch is running!
  👉  Open: http://localhost:3000
```

---

## Step 4 — Use it!

**To host a watch session:**
1. Open **http://localhost:3000** in your browser
2. Paste any YouTube URL (e.g. `https://youtube.com/watch?v=dQw4w9WgXcQ`)
3. Click **Create Room & Invite**
4. Share the 6-letter room code with your friend

**Your friend joins:**
1. They need to access your app — for now, share your screen or run it locally too
2. They enter the room code and click **Join Room**
3. Their video instantly jumps to your position!

---

## Step 5 — Test it yourself (on one computer)

1. Open **http://localhost:3000** in Chrome — create a room, copy the code
2. Open **http://localhost:3000** in a new Incognito window — enter the code, join
3. Press Play in the first window — watch it play in both! 🎉

---

## To stop the app
Press `Ctrl + C` in the terminal.

## To restart it
Type `npm start` again.

---

## What's coming next (Phase 2)
- 🎙️ Voice chat while watching
- 🌐 Deploy online so your friend can join from anywhere
- 🎵 Music sync (Spotify/YouTube Music)
