# Xerraire AgenticRust

Autonomous conversational agent for [MakeYourCrew](https://makeyourcrew.com) workspaces.

Powered by DeepSeek, it provides a chat interface that can:
- Dispatch tasks to agent crews
- Search documents via Llull
- Create notes, tasks, and human actions
- Manage workspace settings
- Search the agent marketplace

## Quick Start

```bash
cp .env.example .env
npm install
node server.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PG_USER` | `studio` | PostgreSQL user |
| `PG_PASSWORD` | `stvd10@ges4#2026` | PostgreSQL password |
| `PG_HOST` | `127.0.0.1` | PostgreSQL host |
| `PG_PORT` | `30432` | PostgreSQL port |
| `PG_DB` | `studio_agents` | PostgreSQL database |
| `DEEPSEEK_API_KEY` | — | DeepSeek API key |
| `LLULL_URL` | `http://155.133.27.1:30808` | Llull search engine URL |
| `LLULL_TOKEN` | — | Llull auth token |

## API

- `GET /health` — Health check
- `POST /chat` — Chat with the agent
- `POST /confirm-task` — Confirm and dispatch a task
- `GET /history/:uid/:spaceId` — Conversation history

## License

MIT
