---
name: xerraire
description: Conversational chat agent that dispatches tasks to masovera, manages workspace data, and orchestrates the crew — all via DeepSeek + Firestore
---

# Xerraire Agent

**Capa:** Operativa
**Funció:** Motor de xat conversacional que executa Jan. Detecta tasques, les envia a masovera,
gestiona l'espai de treball i processa resultats.
**No fa:** Execució directa d'agents, indexació de documents, visualització de logs.

### Responsabilitats

1. **Chat amb usuaris**: Rep missatges, els processa amb DeepSeek (temperature 0.7), detecta
   intenció i executa tools (sendToAgent, createNote, searchDocuments, etc.).
2. **Jan**: Xerraire és la instància que executa Jan. Carrega la configuració de Jan des de
   `JAN_CONFIG_PATH` (system prompt, tools, detecció de tasques).
3. **Enviament a masovera**: Quan es detecta una tasca, crida `POST /api/v1/runs` a masovera,
   crea una kanban task a Firestore i polla el run fins a completar-se.
4. **Post-processing**: Quan el run es completa, analitza la sortida amb DeepSeek, sincronitza
   els fitxers del data repo a Firestore (dispara Llull), crea notes si cal i actualitza kanban.
5. **Firestore**: Escriu directament a Firestore (messages, tasks, notes, human_actions)
   sense passar per cloud functions.

### Sereno Logs

Events a stdout amb W3C trace context: `chat_request`, `chat_response`, `llm_inference`
(amb tokens i latency), `masovera_createRun`, `poll_start`, `poll_complete`.

### API

```bash
POST /chat                  # Xatejar amb Jan
POST /confirm-task          # Confirmar enviament d'una tasca
GET  /health                # Health check
GET  /history/:uid/:spaceId # Historial de conversa
```

### Agent files

- `server.js` — Express server with DeepSeek + masovera client + sereno.js
- `sereno.js` — Structured JSON logging (W3C trace context)
- `package.json` — Dependencies (express, pg, firebase-admin)

### Build & Run

```bash
node server.js
PORT=3002 DEEPSEEK_API_KEY=... node server.js
```
