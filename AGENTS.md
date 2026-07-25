---
name: xerraire
description: Conversational chat agent (Jan) — dispatches tasks to masovera, creates notes/tasks in Firestore, searches documents in Llull
---

# Xerraire Agent

**Capa:** Operativa
**Rol:** Motor de xat conversacional que executa Jan. Detecta la intenció de l'usuari,
executa tools (enviar a masovera, crear notes, cercar documents) i gestiona l'espai
de treball directament a Firestore.

---

### Dades que gestiona

| Dada | On es guarda | Com s'escriu | Com es llegeix |
|------|-------------|-------------|----------------|
| **Messages** (chat) | Firestore `spaces/{spaceId}/messages/` | `POST /chat` crea missatges user i bot | Frontend llegeix via `watchMessages()` |
| **Conversations** (historial) | PostgreSQL `cf_conversations` | Cada interacció s'emmagatzema amb user_id + space_id | Es carrega al context del LLM |
| **Tasks** (kanban) | Firestore `spaces/{spaceId}/tasks/` | Quan `sendToAgent` cria una tasca abans de cridar masovera | Frontend mostra al tauler kanban |
| **Notes** | Firestore `spaces/{spaceId}/notes/` | Tool `createNote` | Frontend les mostra |
| **Human actions** | Firestore `spaces/{spaceId}/human_actions/` | Tool `createHumanAction` | Frontend mostra accions pendents |
| **Fitxers** (data repo) | Firestore `spaces/{spaceId}/files/` | `syncDataFilesToFirestore()` després d'un run completat | Frontend mostra l'arbre de fitxers |
| **Run analysis** | Firestore `masovera_runs/{runId}` | `pollRun()` desa summary + analysis | UI consumeix per mostrar resultats |
| **Espai** (config) | Firestore `spaces/{spaceId}` | Tool `updateSpace` | Configuració de l'espai |

---

### Processos que executa

**1. Chat normal**
```
Usuari envia missatge → POST /chat
  → Desa a Firestore (messages) + PostgreSQL (cf_conversations)
  → Carrega historial (últims 50 missatges)
  → Crida DeepSeek amb system prompt + tools
  → Si DeepSeek crida una tool → executeTool()
  → Retorna reply a l'usuari
  → Desa reply a Firestore + PostgreSQL
```

**2. Detecció i enviament de tasca (sendToAgent)**
```
Usuari demana "crea un document..."
  → DeepSeek classifica com a tasca (tool_choice: sendToAgent)
  → executeTool("sendToAgent", { prompt })
  → Crea Task a Firestore (status: queued)
  → Crida POST /api/v1/runs a masovera
  → Actualitza Task (runId, status: in_progress)
  → pollRun() en background
  → Torna reply "Tasca enviada!"
```

**3. Post-processing de run (pollRun)**
```
pollRun() cada 3s → GET /api/v1/runs/{id}
  → Quan status = "completed" | "failed":
    → Analitza sortida amb DeepSeek (summary, shouldCreateNote, etc.)
    → syncDataFilesToFirestore(): llegeix data repo via masovera API
    → Escriu fitxers a Firestore (→ trigger syncToLlull → Llull indexa)
    → Si shouldCreateNote → crea nota a Firestore
    → Actualitza Task (status: done, analysis, commit_sha)
    → Desa analysis a masovera_runs/{runId}
```

**4. Cerca de documents**
```
Tool searchDocuments(query)
  → GET /v1/space-{spaceId}/search?q=query via Llull
  → Torna resultats (name, content, path, type)
```

---

### Relacions amb altres components

| Component | Com es relaciona | Dades compartides |
|-----------|-----------------|-------------------|
| **Masovera** | Crida `POST /api/v1/runs` per executar tasques + `GET /api/v1/projects/{id}/data` per fitxers | instruction, run_id, project_id, files |
| **Firestore** | Accés directe via firebase-admin per llegir/escriure totes les dades de l'espai | Messages, tasks, notes, human_actions, files, config |
| **Llull** | `searchDocuments` crida l'API de Llull per cercar | Query + resultats |
| **Mycrew-api** | `searchMarketplace` crida cloud function | Query + resultats |

---

### Sereno Logs

Events a stdout en format JSON sereno:

| Event | action.type/name | Quan |
|-------|-----------------|------|
| Chat request | `lifecycle/chat_request` | POST /chat rebut |
| DeepSeek call | `llm_inference/deepseek-chat` | Trucada a DeepSeek (amb tokens, latency_ms) |
| Masovera createRun | `tool_execution/masovera.createRun` | Run creat (amb run_id) |
| Poll start | `lifecycle/poll_start` | Inici de polling (amb run_id) |
| Poll complete | `lifecycle/poll_complete` | Polling acabat (amb status, attempts) |
| Chat response | `lifecycle/chat_response` | Resposta enviada a l'usuari (amb latency_ms) |

---

### Configuració

```bash
# Conexió masovera
MASOVERA_URL=http://masovera-api:7878
MASOVERA_API_KEY=
MASOVERA_TENANT=makeyourcrew
MASOVERA_PROJECT_ID=uuid-del-projecte

# Jan config
JAN_CONFIG_PATH=/etc/xerraire/jan.json

# PostgreSQL
PG_HOST=postgres-xerraire
PG_PORT=5432
PG_USER=studio
PG_PASSWORD=...
PG_DB=studio_agents

# DeepSeek
DEEPSEEK_API_KEY=...

# Llull
LLULL_URL=http://llull:8080
LLULL_TOKEN=...
```

### Què NO fa xerraire

- ❌ No executa agents directament (ho fa masovera)
- ❌ No indexa documents (ho fa llull via Firestore triggers)
- ❌ No emmagatzema logs històrics (ho fa sereno)
- ❌ No gestiona el marketplace ni pagaments (ho fa mycrew-api + functions)
- ❌ No sincronitza fitxers de codi (els agents opencode ho fan al repo)
