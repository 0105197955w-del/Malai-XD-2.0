# 🤖 Malai-XD-2.0 - Advanced WhatsApp Bot

> **Fast • Reliable • Feature-Rich WhatsApp Bot** powered by Baileys & Node.js

![Version](https://img.shields.io/badge/version-2.1.0-brightgreen)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## 📋 Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [Commands](#commands)
- [Toggles & Settings](#toggles--settings)
- [Advanced Features](#advanced-features)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

---

## ✨ Features

### ⚡ Performance
- **5-15x faster** than previous versions
- Parallel API calls (play/video downloads in 10-15 seconds)
- Optimized message handling (100-300ms response time)
- Background task processing (non-blocking)
- Debounced file writes (prevents KataBump warnings)

### 🎯 Command System
- **Prefix-based**: `.command arg1 arg2`
- **Prefix-free**: `bot command arg1 arg2`
- **Natural trigger**: "hey bot what's your name"
- **150+ commands** across 10+ categories

### 🛡️ Security & Moderation
- Antilink (delete/kick modes)
- Antitag (mass mention protection)
- Antidelete (logs deleted messages with media type)
- Antibadword (customizable per-group)
- Antistatus (prevent status view)
- Anticall (auto-reject incoming calls)
- PM Blocker (block non-owner DMs)

### 🎮 Entertainment
- YouTube Music/Video downloads (10-15 seconds)
- Anime GIFs (hug, kiss, slap, kick, punch, etc.)
- Text styling (bold, italic, reverse, binary, morse, etc.)
- Games & trivia
- Meme generation

### 👤 User Features
- Profile picture fetching (works for unsaved contacts)
- User info cards (number, country, status)
- Message warnings system
- Activity leaderboard (topmembers)
- Custom learned replies

### 🤖 AI & Automation
- Humanized autoread (blue ticks + typing indicators)
- Auto-react with emoji
- Autoreply (learned responses)
- View-once message auto-forward
- Auto status updates

### 📊 Admin Tools
- Group promotion/demotion announcements
- Welcome/goodbye messages
- Group status posting
- Bulk add members
- Message statistics

---

## 🚀 Installation

### Prerequisites
- **Node.js** 18.0.0 or higher
- **npm** or **yarn**
- **WhatsApp Account** (for pairing)

### Quick Start

#### 1. Clone Repository
```bash
git clone https://github.com/Brokensmile47/Malai-XD-2.0--.git
cd Malai-XD-2.0---main
```

#### 2. Install Dependencies
```bash
npm install --legacy-peer-deps
```

#### 3. Start Bot
```bash
npm start
```

#### 4. Scan QR Code
- Open WhatsApp on your phone
- Go to **Settings > Linked Devices > Link a Device**
- Scan the QR code shown in the terminal
- Bot will come online in ~30 seconds

---

## ⚙️ Configuration

### Environment Variables (.env)

```env
# Bot Settings
BOT_NAME=Malai-XD-2.0
OWNER_NUMBER=254700000000
PREFIX=.
PUBLIC_MODE=false
TIME_ZONE=Africa/Nairobi

# Database
DATA_DIR=./data
SESSION_DIR=./session

# Optional APIs
IMGFLIP_USERNAME=your_username
IMGFLIP_PASSWORD=your_password
ANTHROPIC_API_KEY=your_api_key

# Logging
LOG_LEVEL=info
```

### Session Setup

The bot stores session in `./session/` folder:
- `creds.json` - Encrypted credentials
- `pre-keys.json` - Signal protocol keys
- `sender-keys.json` - Group keys
- `app-state-sync-*.json` - State synchronization

⚠️ **Important:** Never delete `session/` folder or you'll need to pair again!

---

## 📚 Commands

### 🎵 Music & Downloads

| Command | Usage | Description |
|---------|-------|-------------|
| `.play` | `.play hello` | Download YouTube music (MP3) |
| `.video` | `.video hello` | Download YouTube video (MP4) |
| `.ytmp3` | Same as `.play` | Alias for play |
| `.ytmp4` | Same as `.video` | Alias for video |

**Speed:** ~10-15 seconds (parallel API calls)

---

### 👤 User Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `.getpp` | `.getpp` or `.getpp @user` | Get profile picture + country |
| `.dp` | `.dp @user` | Alias for getpp |
| `.whois` | `.whois +254700000000` | User info (works for unsaved contacts) |
| `.userinfo` | Same as `.whois` | Alias |
| `.about` | `.about @user` | Get user about/status |

**Speed:** ~3-5 seconds (optimized with 3s timeout)

---

### 💬 Text Styling

| Command | Usage | Output |
|---------|-------|--------|
| `.bold` | `.bold hello` | **hello** |
| `.italic` | `.italic hello` | *hello* |
| `.mono` | `.mono hello` | `hello` |
| `.reverse` | `.reverse hello` | olleh |
| `.upper` | `.upper hello` | HELLO |
| `.lower` | `.lower HELLO` | hello |
| `.binary` | `.binary hello` | 01101000... |
| `.morse` | `.morse hello` | .... . .-..  |
| `.base64` | `.base64 hello` | aGVsbG8= |
| `.clap` | `.clap hello world` | hello 👏 world |
| `.space` | `.space hello` | h e l l o |
| `.vapor` | `.vapor hello` | ｈｅｌｌｏ |

---

### 🎬 Anime & GIFs

| Command | Usage | Description |
|---------|-------|-------------|
| `.hug` | `.hug @user` | Random hug GIF |
| `.kiss` | `.kiss @user` | Random kiss GIF |
| `.slap` | `.slap @user` | Random slap GIF |
| `.kick` | `.kick @user` | Random kick GIF |
| `.punch` | `.punch @user` | Random punch GIF |
| `.bite` | `.bite @user` | Random bite GIF |
| `.dance` | `.dance` | Random dance GIF |
| `.pat` | `.pat @user` | Random pat GIF |

---

### 🛠️ Admin Commands

| Command | Usage | Description |
|---------|-------|-------------|
| `.add` | `.add +254700000000` | Add member to group |
| `.promote` | `.promote @user` | Make user admin |
| `.demote` | `.demote @user` | Remove admin status |
| `.kick` | `.kick @user` | Remove from group |
| `.warn` | `.warn @user [reason]` | Warn user (3 = kick) |
| `.warnings` | `.warnings @user` | Check warn count |
| `.resetwarn` | `.resetwarn @user` | Reset warnings |
| `.topmembers` | `.topmembers` | Top 10 active members |
| `.groupstatus` | `.groupstatus` (reply to media) | Post media to status |

---

### 🔧 Bot Management (Owner Only)

| Command | Usage | Description |
|---------|-------|-------------|
| `.repo` | `.repo` | Show bot repo link |
| `.update` | `.update` | Git pull + auto-restart |
| `.update force` | `.update force` | Hard reset + update |
| `.ping` | `.ping` | Bot latency test |
| `.menu` | `.menu` | Show all commands |
| `.cleartmp` | `.cleartmp` | Clear temp files |

---

## 🎛️ Toggles & Settings

### Global Toggles (Owner Only)

```
.antilink on|off|status        Prevent link sharing
.antitag on|off|status         Prevent mass mentions  
.antidelete on|off|status      Log deleted messages
.antibadword on|off|status     Bad word filter
.anticall on|off|status        Block incoming calls
.autoreact on|off|status       Auto-react to messages
.autoread on|off|status        Mark messages as read
.pmblocker on|off|status       Block non-owner DMs
.antistatus on|off|status      Prevent status views
```

### Per-Group Settings (Admin)

```
.antilink delete|kick|status   Set group link mode
.antitag on|off|status         Toggle mention protection
.antibadword on|off|setmsg     Manage bad words
```

### Humanized Autoread (Real Person Mode)

```
.autoread on                   Fast mode (instant blue ticks)
.autoread humanize            Human mode (typing + delays)
.autoread status              Show current settings
```

**Humanize Features:**
- Shows typing indicator (1.5-3 seconds)
- Random response delays (2-5 seconds)
- Blue ticks (✅✅) like reading message
- Acts like a real person

---

## 🚀 Advanced Features

### Command Triggers

#### 1. Prefix-Based (Traditional)
```
.ping                    Standard prefix
.play hello
.menu
```

#### 2. Prefix-Free (New!)
```
bot ping                 Works like .ping
bot play hello          Works like .play hello
```

#### 3. Natural Conversation
```
"hey bot what's your name"      → Bot responds
"can you bot help me"           → Bot responds
"bot are you online"            → Bot responds
```

### Antidelete Reports

When someone deletes a message, bot reports:
```
🚨 ANTIDELETE REPORT
🖼️ Deleted: PHOTO
👤 Deleted by: @user
🕐 Time: 2026-06-09 12:47:30
💬 Content: [caption or text]
```

**Media Types:**
- 🖼️ **PHOTO** - Images
- 🎬 **VIDEO** - Videos  
- 🎵 **AUDIO** - Audio messages
- 📄 **FILE** - Documents
- 🎨 **STICKER** - Stickers

### Welcome & Goodbye Messages

Enable in group:
```
.welcome on      → Greet new members
.goodbye on      → Say goodbye when members leave
```

### Learned Replies

```
.addreply hello world      → Remember "hello" = "world"
.delreply hello            → Remove "hello" reply
.listreplies              → Show all learned replies
```

---

## 📊 Performance

### Speed Improvements

| Feature | Before | After | Improvement |
|---------|--------|-------|-------------|
| Play/Video | 2-3 min | 10-15s | **~15x faster** |
| getpp command | 8-10s | 3-5s | **~2-3x faster** |
| Command response | 500-1000ms | 100-300ms | **~3-5x faster** |
| Overall bot latency | 1-2s | 100-300ms | **~5-10x faster** |

### Optimizations Applied

✅ **Parallel API Calls** - All download APIs launch simultaneously  
✅ **Fast Timeouts** - 30s → 10s for downloads, 8s → 3s for images  
✅ **Background Tasks** - Welcome/goodbye messages don't block  
✅ **Debounced Writes** - Credential saves batched (prevents file flooding)  
✅ **Non-blocking** - setImmediate() for heavy operations  

---

## ❌ Troubleshooting

### Bot Not Coming Online

```bash
# Check logs
npm start

# Rescan QR code
rm -rf session/
npm start
```

### Commands Not Working

```
Issue: Bot responds but command fails
Fix: Check .env for OWNER_NUMBER

Issue: Prefix-free "bot" not working
Fix: Make sure you're using exact format: "bot command"

Issue: Download speed slow
Fix: Check internet connection, try .update command
```

### High File Creation Rate (KataBump Warning)

```
Issue: "[WARNING] High file creation rate detected"
Fix: ✅ ALREADY FIXED with debounced creds.update
     This was the original issue - now resolved!
```

### Memory Usage High

```
Typical: 150-300 MiB
Too High (>500 MiB): 
  - Run: .cleartmp
  - Check for large media in data/antidelete_tmp/
  - Restart bot: npm start
```

---

## 📱 Pairing Site

**Default pairing endpoint:**
```
https://malai-pairing-site-0e06.onrender.com
```

**To setup custom pairing:**
1. Deploy your own pairing site
2. Update URL in README.md
3. Point session folder users there

---

## 🔐 Security Notes

1. **Keep credentials safe** - `session/creds.json` is encrypted
2. **Never share `.env`** - Contains sensitive data
3. **Use strong OWNER_NUMBER** - Protects owner-only commands
4. **Backup session folder** - In case of device loss
5. **Enable anticall** - Prevents unwanted calls

---

## 📦 Project Structure

```
Malai-XD-2.0---main/
├── src/
│   ├── index.js              Main bot logic (1026 lines)
│   ├── commands.js           All 150+ commands (2786 lines)
│   ├── settings.js           Toggle definitions
│   ├── utils.js              Helper functions
│   └── pairing.js            Pairing helpers
├── session/                  Baileys session (auto-created)
├── data/                     Bot data (state, learned replies)
├── package.json              Dependencies
├── .env.example              Configuration template
└── README.md                 This file
```

---

## 🔄 Version History

### v2.1.0 (Latest)
- ✅ 15x performance boost (parallel APIs)
- ✅ Bot prefix-free trigger support
- ✅ Humanized autoread (typing + delays)
- ✅ Enhanced antidelete (shows media type)
- ✅ Fixed textmaker errors
- ✅ Added anime GIF commands
- ✅ Speed optimizations across all commands

### v2.0.0
- Initial version with full feature set

---

## 🤝 Contributing

Found a bug? Have a feature request?

1. Fork the repo
2. Create feature branch: `git checkout -b feature/awesome`
3. Commit changes: `git commit -m "Add awesome feature"`
4. Push: `git push origin feature/awesome`
5. Open Pull Request

---

## 📄 License

MIT License - See LICENSE file for details

---

## 👨‍💻 Credits

**Made by:** Kimani Samuel (@Brokensmile47)

**Tech Stack:**
- [Baileys](https://github.com/WhiskeySockets/Baileys) - WhatsApp Web API
- [Node.js](https://nodejs.org) - JavaScript runtime
- [Axios](https://axios-http.com) - HTTP client
- [Express](https://expressjs.com) - Web framework

**Special Thanks:**
- WhatsApp Web for the protocol
- Baileys team for reverse engineering
- All contributors and testers

---

## 📞 Support

**Issues:** Open GitHub issue  
**Questions:** Check FAQ section below

### FAQ

**Q: How do I use the bot?**  
A: Start with `.menu` to see all commands, or use `bot menu`

**Q: Can I self-host?**  
A: Yes! Deploy on Railway, Render, or your own VPS

**Q: How do I backup my session?**  
A: Download the `session/` folder (it's encrypted)

**Q: Can I use multiple WhatsApp accounts?**  
A: Create separate instances with different SESSION_DIR values

**Q: Is this safe?**  
A: Yes, session is encrypted. Keep `.env` secret!

---

## 🎉 Thank You!

Thanks for using **Malai-XD-2.0**! Star this repo if it helps you ⭐

**Happy botting!** 🚀

---

*Last Updated: June 2026*  
*Maintained by: Kimani Samuel*
