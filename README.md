# Impostor Game

A real-time social deduction word game. Players join a game room, one is secretly the Impostor, and everyone else gets a secret word. Describe the word, vote on who you think is the Impostor, and reveal the truth!

## Prerequisites

- **Node.js** 18+ and npm (for source install)
- **Docker** (optional, for containerized run)

---

## Installation

### Option 1: Run from Source

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd imposter
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the server**
   ```bash
   npm start
   ```

4. **Open in browser**
   - Navigate to `http://localhost:3000`
   - Share the URL with friends (ensure they're on the same network, or use a tunnel like ngrok for remote play)

**Development mode** (with auto-reload):
```bash
npm run dev
```

---

### Option 2: Run with Docker

1. **Build the image**
   ```bash
   docker build -t impostor-game .
   ```

2. **Run the container**
   ```bash
   docker run -p 3000:3000 impostor-game
   ```

3. **Open in browser**
   - Navigate to `http://localhost:3000`

**Run in detached mode** (background):
```bash
docker run -d -p 3000:3000 --name impostor impostor-game
```

**Stop the container:**
```bash
docker stop impostor
```

---

### Option 3: Run with Docker Compose

1. **Start the game**
   ```bash
   docker compose up -d
   ```

2. **Open in browser**
   - Navigate to `http://localhost:3000`

**Stop:**
```bash
docker compose down
```

#### Custom Word List (Docker Compose)

The Docker Compose setup mounts `words.json` from your project directory. You can replace or edit this file to use your own word list.

**Format** — `words.json` must be a JSON array of strings:
```json
["Pizza", "Sushi", "Chocolate", "Banana", "Elephant", "Beach", ...]
```

**Steps:**
1. Copy the default list: `cp words.json my-words.json`
2. Edit `my-words.json` with your words
3. Update `docker-compose.yml` to mount your file:
   ```yaml
   volumes:
     - ./my-words.json:/app/words.json
   ```
4. Restart: `docker compose down && docker compose up -d`

**Source install** — Replace or edit `words.json` in the project root. The app loads it at startup and falls back to the built-in list if the file is missing or invalid.

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Port the server listens on |

**Example (source):**
```bash
PORT=8080 npm start
```

**Example (Docker):**
```bash
docker run -p 8080:8080 -e PORT=8080 impostor-game
```

**Example (Docker Compose):** Edit `docker-compose.yml` to change the port mapping and `PORT` environment variable.

---

## How to Play

1. **Create** or **Join** a game with a 6-character code
2. One player is secretly the **Impostor** — they don't know the word
3. Everyone else gets the same **secret word**
4. Each player **describes** the word (without saying it!)
5. **Discuss** and **vote** on who you think is the Impostor
6. **Reveal** — did you catch them?

---

## License

MIT
