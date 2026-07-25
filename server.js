import express from "express";
import pg from "pg";
import { readFileSync, existsSync } from "fs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { Tracer, LogLevel } from "./sereno.js";

const { Pool } = pg;
const PG_USER = process.env.PG_USER || "studio";
const PG_PASSWORD = process.env.PG_PASSWORD || "stvd10@ges4#2026";
const PG_HOST = process.env.PG_HOST || "127.0.0.1";
const PG_PORT = parseInt(process.env.PG_PORT || "30432");
const PG_DB = process.env.PG_DB || "studio_agents";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const MASOVERA_URL = process.env.MASOVERA_URL || "http://masovera-api:7878";
const MASOVERA_KEY = process.env.MASOVERA_API_KEY || "";
const MASOVERA_TENANT = process.env.MASOVERA_TENANT || "makeyourcrew";
const MASOVERA_PROJECT_ID = process.env.MASOVERA_PROJECT_ID || "";

const pool = new Pool({
  user: PG_USER, password: PG_PASSWORD, host: PG_HOST, port: PG_PORT, database: PG_DB,
  max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
});

initializeApp();
const db = getFirestore();

// ─── Masovera API client ───────────────────────────────────
function masoveraHeaders() {
  const h = { "Content-Type": "application/json" };
  if (MASOVERA_KEY) h.Authorization = `Bearer ${MASOVERA_KEY}`;
  return h;
}

async function masoveraCreateRun({ agentName, model, instruction, branch, sessionId }) {
  const res = await fetch(`${MASOVERA_URL}/api/v1/runs`, {
    method: "POST",
    headers: masoveraHeaders(),
    body: JSON.stringify({
      tenant_slug: MASOVERA_TENANT,
      project_id: MASOVERA_PROJECT_ID,
      agent_name: agentName || "build",
      model: model || "standard",
      instruction,
      branch: branch || "main",
      session_id: sessionId || null,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`masovera ${res.status}: ${err.slice(0, 200)}`);
  }
  return res.json();
}

async function masoveraGetRun(runId) {
  const res = await fetch(`${MASOVERA_URL}/api/v1/runs/${runId}`, {
    headers: masoveraHeaders(),
  });
  if (!res.ok) return null;
  return res.json();
}

async function masoveraListFiles(projectId) {
  const res = await fetch(`${MASOVERA_URL}/api/v1/projects/${projectId}/data`, {
    headers: masoveraHeaders(),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : (data.entries || data.files || []);
}

async function masoveraGetFile(projectId, path) {
  const res = await fetch(
    `${MASOVERA_URL}/api/v1/projects/${projectId}/data?path=${encodeURIComponent(path)}`,
    { headers: masoveraHeaders() }
  );
  if (!res.ok) return null;
  return res.json();
}

// ─── Sync files from masovera data repo to Firestore ──────
async function syncDataFilesToFirestore(spaceId, projectId) {
  const pid = projectId || MASOVERA_PROJECT_ID;
  if (!pid) return;

  const files = await masoveraListFiles(pid);
  const filesRef = db.collection("spaces").doc(spaceId).collection("files");
  const now = new Date().toISOString();
  let synced = 0;

  for (const file of files) {
    const filePath = file.path || file.name;
    if (!filePath) continue;
    const ext = filePath.split(".").pop()?.toLowerCase();
    if (["png", "jpg", "jpeg", "gif", "ico", "svg", "pdf", "zip", "tar", "gz"].includes(ext)) continue;

    const fileData = await masoveraGetFile(pid, filePath);
    if (!fileData) continue;

    let content = fileData.content || "";
    if (fileData.encoding === "base64") {
      try { content = Buffer.from(content, "base64").toString("utf8"); } catch {}
    }
    if (content.length > 900000) content = content.slice(0, 900000);
    const fileName = filePath.split("/").pop();

    const existing = await filesRef.where("path", "==", filePath).limit(1).get();
    if (!existing.empty) {
      await existing.docs[0].ref.update({
        name: fileName, content, path: filePath,
        dirPath: filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "",
        updated_at: now, type: "blob",
      });
    } else {
      await filesRef.add({
        name: fileName, content, path: filePath,
        dirPath: filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "",
        updated_at: now, type: "blob",
      });
    }
    synced++;
  }
  console.log(`[syncFiles] Synced ${synced} files to Firestore for ${spaceId}`);
}

// ─── Poll masovera run until completion ───────────────────
async function pollRun(runId, spaceId, uid, userName, taskRef) {
  const trace = Tracer.root("xerraire", "jan");
  const pollStart = Date.now();
  trace.emit(LogLevel.Info, "polling masovera run", {
    action_type: "lifecycle", action_name: "poll_start",
    tool_args: { run_id: runId, space_id: spaceId },
  });
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const run = await masoveraGetRun(runId);
      if (!run) continue;

      if (run.status === "completed" || run.status === "failed") {
        console.log(`[poll] Run ${runId} → ${run.status}`);

        // Analyze result with DeepSeek
        let summary = "";
        let analysis = {};
        const lastMsg = run.history?.messages?.slice(-1)?.[0]?.content || "";
        if (lastMsg) {
          try {
            const analysisRes = await fetch("https://api.deepseek.com/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
              body: JSON.stringify({
                model: "deepseek-v4-flash",
                messages: [
                  { role: "system", content: "Analyze the following agent output. Return JSON: { summary: string, needsUserInfo: boolean, shouldCreateNote: boolean, note: string, commit_sha: string }" },
                  { role: "user", content: lastMsg.slice(0, 4000) },
                ],
                response_format: { type: "json_object" },
                temperature: 0.3, max_tokens: 1000,
              }),
              signal: AbortSignal.timeout(15000),
            });
            if (analysisRes.ok) {
              const data = await analysisRes.json();
              analysis = JSON.parse(data.choices?.[0]?.message?.content || "{}");
              summary = analysis.summary || "";
            }
          } catch (e) {
            console.warn(`[poll] Analysis error: ${e.message}`);
          }
        }

        // Sync data repo files to Firestore (triggers Llull indexing)
        await syncDataFilesToFirestore(spaceId, run.project_id).catch(e =>
          console.warn(`[poll] File sync error: ${e.message}`)
        );

        // Update task in Firestore
        if (taskRef) {
          const update = {
            status: run.status === "completed" ? "done" : "error",
            completed_at: new Date().toISOString(),
            commit_sha: run.commit_sha || analysis.commit_sha || null,
            analysis,
          };
          await taskRef.update(update);
        }

        // Create note if analysis says so
        if (analysis.shouldCreateNote && analysis.note) {
          await db.collection("spaces").doc(spaceId).collection("notes").add({
            text: analysis.note,
            userId: uid,
            userName: userName,
            source: "run_analysis",
            runId,
            createdAt: new Date().toISOString(),
          }).catch(() => {});
        }

        // Store run analysis
        await db.collection("masovera_runs").doc(runId).set({
          status: run.status,
          summary,
          analysis,
          commit_sha: run.commit_sha || null,
          updated_at: new Date().toISOString(),
        }, { merge: true }).catch(() => {});

        const totalPollMs = Date.now() - pollStart;
        trace.emit(LogLevel.Info, "run polling complete", {
          action_type: "lifecycle", action_name: "poll_complete",
          latency_ms: totalPollMs,
          tool_args: { run_id: runId, status: run.status, attempts: i + 1 },
        });

        return;
      }
    } catch (e) {
      console.warn(`[poll] Attempt ${i}: ${e.message}`);
    }
  }
  console.warn(`[poll] Run ${runId} timed out after ${maxAttempts * 3}s`);
}

// ─── Load Jan configuration ──────────────────────────────────
const JAN_CONFIG_PATH = process.env.JAN_CONFIG_PATH || "/etc/xerraire/jan.json";
let janConfig = { tools: [], taskDetection: { keywords: [], urgencyPhrases: [] }, systemPrompt: "" };
if (existsSync(JAN_CONFIG_PATH)) {
  try {
    janConfig = JSON.parse(readFileSync(JAN_CONFIG_PATH, "utf8"));
    console.log(`[xerraire] Loaded Jan config from ${JAN_CONFIG_PATH}`);
  } catch (err) {
    console.error(`[xerraire] Failed to load Jan config: ${err.message}`);
  }
}

const XERRAIRE_TOOLS = (janConfig.tools || []).map(t => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

const taskKw = (janConfig.taskDetection?.keywords || []).join("|");
const urgencyKw = (janConfig.taskDetection?.urgencyPhrases || []).join("|");
const TASK_KEYWORDS = taskKw ? new RegExp(`\\b(${taskKw})\\b`, "i") : null;
const URGENCY_PATTERN = urgencyKw ? new RegExp(`\\b(${urgencyKw})\\b`, "i") : null;

// Fallback tools if config didn't load
if (XERRAIRE_TOOLS.length === 0) {
  XERRAIRE_TOOLS.push(
    { type: "function", function: { name: "sendToAgent", description: "Envia una tasca a l'equip d'agents.", parameters: { type: "object", properties: { prompt: { type: "string", description: "Instruccio completa" } }, required: ["prompt"] } } },
    { type: "function", function: { name: "searchDocuments", description: "Cerca informacio als documents.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "createNote", description: "Crea una nota.", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
    { type: "function", function: { name: "createScheduledTask", description: "Programa una tasca.", parameters: { type: "object", properties: { prompt: { type: "string" }, cron: { type: "string" } }, required: ["prompt", "cron"] } } },
    { type: "function", function: { name: "createHumanAction", description: "Crea una accio humana.", parameters: { type: "object", properties: { title: { type: "string" }, description: { type: "string" } }, required: ["title", "description"] } } },
    { type: "function", function: { name: "updateSpace", description: "Actualitza l'espai.", parameters: { type: "object", properties: { name: { type: "string" }, description: { type: "string" } }, required: ["name", "description"] } } },
    { type: "function", function: { name: "searchMarketplace", description: "Cerca al marketplace.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
    { type: "function", function: { name: "openSpaceSettings", description: "Obre configuracio.", parameters: { type: "object", properties: {}, required: [] } } },
    { type: "function", function: { name: "openMarketplace", description: "Obre marketplace.", parameters: { type: "object", properties: { url: { type: "string" } }, required: [] } } },
  );
}

function looksLikeTask(message) {
  if (TASK_KEYWORDS?.test(message)) return true;
  if (URGENCY_PATTERN?.test(message)) return true;
  if (/https?:\/\//i.test(message)) return true;
  return false;
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function ensureUser(uid, email, name) {
  try {
    await pool.query(`INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET email=$2, display_name=$3`, [uid, email || "", name || ""]);
  } catch (err) {
    console.error("[xerraire] ensureUser (non-fatal):", err.message);
  }
}

async function executeTool(name, args, spaceId, uid, userName, pendingActions, serenoTrace) {
  switch (name) {
    case "sendToAgent": {
      // Crida masovera directament i crea kanban task
      if (MASOVERA_PROJECT_ID) {
        const start = Date.now();
        try {
          // Crear task a Firestore
          const taskRef = db.collection("spaces").doc(spaceId).collection("tasks").doc();
          const taskData = {
            prompt: args.prompt,
            agent: "build",
            model: "standard",
            masoveraProjectId: MASOVERA_PROJECT_ID,
            userId: uid,
            userName: userName || "",
            title: (args.prompt || "").slice(0, 60),
            status: "queued",
            createdAt: new Date().toISOString(),
          };
          await taskRef.set(taskData);

          // Cridar masovera
          const run = await masoveraCreateRun({
            agentName: "build",
            model: "standard",
            instruction: args.prompt,
            branch: "main",
            sessionId: null,
          });

          // Actualitzar task amb run
          await taskRef.update({
            runId: run.run_id,
            masoveraRunId: run.run_id,
            masoveraSessionId: run.session_id || null,
            status: "in_progress",
          });

          // Poll completat en background
          pollRun(run.run_id, spaceId, uid, userName, taskRef).catch(e =>
            console.error(`[sendToAgent] Poll failed: ${e.message}`)
          );

          const elapsed = Date.now() - start;
          serenoTrace?.emit(LogLevel.Info, "masovera run created", {
            action_type: "tool_execution", action_name: "masovera.createRun",
            latency_ms: elapsed,
            tool_args: { run_id: run.run_id, session_id: run.session_id },
          });

          return {
            ok: true,
            runId: run.run_id,
            message: "Tasca enviada a l'equip. Et notificaré quan estigui feta.",
          };
        } catch (e) {
          serenoTrace?.emit(LogLevel.Error, "masovera run failed", {
            action_type: "tool_execution", action_name: "masovera.createRun",
            error: { type: "MasoveraError", message: e.message },
            latency_ms: Date.now() - start,
          });
          console.error(`[sendToAgent] Masovera error: ${e.message}`);
          return { error: `No s'ha pogut enviar la tasca: ${e.message}` };
        }
      }

      // Fallback: sense project ID, demanar confirmació
      pendingActions.push({
        type: "confirm_send_to_agent",
        prompt: args.prompt,
      });
      return { ok: true, pending: true };
    }
    case "searchDocuments": {
      const LLULL_URL = process.env.LLULL_URL || "http://155.133.27.1:30808";
      const LLULL_TOKEN = process.env.LLULL_TOKEN || "search-2mes4-secret-token-2026";
      try {
        const res = await fetch(`${LLULL_URL}/v1/space-${spaceId}/search?q=${encodeURIComponent(args.query)}&limit=10`, {
          headers: { Authorization: `Bearer ${LLULL_TOKEN}` },
        });
        if (!res.ok) return { results: [] };
        const data = await res.json();
        return { results: (data.hits || []).map((h) => ({ name: h.fields?.name || "", content: (h.fields?.content || "").slice(0, 2000), path: h.fields?.path || "", type: h.fields?.type || "" })) };
      } catch { return { results: [] }; }
    }
    case "createNote": {
      const ref = await db.collection("spaces").doc(spaceId).collection("notes").add({
        text: args.text, userId: uid, userName: userName, createdAt: new Date().toISOString(),
      });
      return { ok: true, noteId: ref.id };
    }
    case "createScheduledTask": {
      const ref = await db.collection("spaces").doc(spaceId).collection("tasks").add({
        prompt: args.prompt, cron: args.cron, status: "scheduled", userId: uid, userName: userName, createdAt: new Date().toISOString(),
      });
      return { ok: true, taskId: ref.id };
    }
    case "createHumanAction": {
      const ref = await db.collection("spaces").doc(spaceId).collection("human_actions").add({
        type: "user_request", status: "pending", title: args.title, description: args.description,
        userId: uid, userName: userName, response: "", created_at: new Date().toISOString(), resolved_at: null,
      });
      return { ok: true, actionId: ref.id };
    }
    case "updateSpace": {
      await db.collection("spaces").doc(spaceId).set({ name: args.name, description: args.description }, { merge: true });
      return { ok: true, name: args.name, description: args.description };
    }
    case "searchMarketplace": {
      try {
        const res = await fetch(`https://europe-west1-makeyourcrew.cloudfunctions.net/searchMarketplace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { query: args.query } }),
        });
        if (!res.ok) return { results: [], total: 0 };
        const data = await res.json();
        const hits = data.result?.hits || [];
        return { results: hits.map((h) => ({ id: h.id, name: h.name, description: h.short_desc_en || h.description_en || "", slug: h.slug, price: h.price, rating: h.avgRating, installs: h.installCount, tags: h.tags || [] })), total: data.result?.total || hits.length };
      } catch { return { results: [], total: 0 }; }
    }
    case "openSpaceSettings": {
      return { action: "open_settings" };
    }
    case "openMarketplace": {
      return { action: "open_marketplace", url: args.url || "https://marketplace.makeyourcrew.com/" };
    }
    default: return { error: `Unknown tool: ${name}` };
  }
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/confirm-task", async (req, res) => {
  const trace = Tracer.root("xerraire", "jan");
  trace.emit(LogLevel.Info, "confirm-task received", {
    action_type: "tool_execution", action_name: "sendToAgent",
    user_id: req.body?.uid, session_id: req.body?.spaceId,
  });

  try {
    const { prompt, uid, spaceId, email, name, language } = req.body;
    if (!prompt || !uid || !spaceId) {
      trace.emit(LogLevel.Warn, "confirm-task missing fields");
      return res.status(400).json({ error: "prompt, uid and spaceId required" });
    }

    await ensureUser(uid, email, name);

    const reply = language === "es" ? "✅ ¡Enviado! El equipo está trabajando en ello."
      : language === "en" ? "✅ Sent! The team is on it."
      : "✅ Enviat! L'equip hi està treballant.";

    await db.collection("spaces").doc(spaceId).collection("messages").add({
      role: "user", text: prompt,
      userId: uid, userName: name || "", status: "handled",
      createdAt: new Date().toISOString(),
    });

    // If masovera is configured, create run + poll
    if (MASOVERA_PROJECT_ID) {
      const taskRef = db.collection("spaces").doc(spaceId).collection("tasks").doc();
      const taskData = {
        prompt, agent: "build", model: "standard",
        masoveraProjectId: MASOVERA_PROJECT_ID,
        userId: uid, userName: name || "",
        title: prompt.slice(0, 60), status: "queued",
        createdAt: new Date().toISOString(),
      };
      await taskRef.set(taskData);

      const run = await masoveraCreateRun({
        agentName: "build", model: "standard",
        instruction: prompt, branch: "main", sessionId: null,
      });
      await taskRef.update({
        runId: run.run_id, masoveraRunId: run.run_id,
        masoveraSessionId: run.session_id || null, status: "in_progress",
      });
      pollRun(run.run_id, spaceId, uid, name, taskRef).catch(e =>
        console.error(`[confirm-task] Poll failed: ${e.message}`)
      );
    }

    await pool.query(
      `INSERT INTO cf_conversations (user_id, space_id, role, content) VALUES ($1, $2, 'user', $3), ($1, $2, 'assistant', $4)`,
      [uid, spaceId, prompt, reply]
    );

    res.json({ reply });
  } catch (err) {
    console.error("[xerraire] confirm-task error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/chat", async (req, res) => {
  const trace = Tracer.root("xerraire", "jan");
  const startTime = Date.now();
  trace.emit(LogLevel.Info, "chat request received", {
    action_type: "lifecycle", action_name: "chat_request",
    user_id: req.body?.uid, session_id: req.body?.spaceId,
  });

  try {
    const { message, uid, spaceId, agentRole, language, email, name, spaceName, description } = req.body;
    if (!message || !uid || !spaceId) {
      trace.emit(LogLevel.Warn, "missing required fields", { error: { type: "ValidationError" } });
      return res.status(400).json({ error: "message, uid and spaceId required" });
    }

    await ensureUser(uid, email, name);

    const isNewSpace = !spaceName || spaceName === "Mi espacio" || !description;
    const spaceDesc = description || "";
    const isTask = !isNewSpace && looksLikeTask(message);

    const basePrompt = janConfig.systemPrompt || `Ets el Jan, l'assistent personal d'aquest espai de treball.

Idioma: Respon sempre en ${language === "ca" ? "catala" : language === "es" ? "castella" : "angles"}.

Si l'usuari demana que l'equip faci qualsevol cosa, crida sendToAgent immediatament.`;

    const isNewSpaceNote = isNewSpace ? `\n\nATENCIO: Aquest espai es nou o esta buit. L'usuari acaba d'arribar.
La teva missio ara es:
1. DONAR LA BENVINGUDA i preguntar com vol anomenar l'espai i per a que el vol utilitzar.
2. Quan l'usuari respongui, crida updateSpace per desar el nom i la descripcio.
3. DESPRES pregunta: "Ja tens un equip d'agents o vols que t'ajudi a trobar-ne un?"` : `\n\nL'espai de treball es diu "${spaceName}" i la seva missio es: ${spaceDesc}`;

    const SYSTEM_PROMPT = `${basePrompt}${isNewSpaceNote}`;

    // Save user message to Firestore so frontend sees it
    await db.collection("spaces").doc(spaceId).collection("messages").add({
      role: "user",
      text: message,
      uid,
      userName: name || "",
      status: "handled",
      language: language || "ca",
      createdAt: new Date().toISOString(),
    }).catch(() => {});

    await pool.query(`INSERT INTO cf_conversations (user_id, space_id, role, content) VALUES ($1, $2, 'user', $3)`, [uid, spaceId, message]);

    const histRes = await pool.query(`SELECT role, content FROM cf_conversations WHERE user_id = $1 AND space_id = $2 ORDER BY created_at ASC LIMIT 50`, [uid, spaceId]);

    const apiMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...histRes.rows,
      { role: "user", content: message },
    ];

    const toolChoice = isTask ? { type: "function", function: { name: "sendToAgent" } } : "auto";

    let reply = "";
    let pendingActions = [];
    let iterations = 0;
    while (iterations < 5) {
      iterations++;
      const deepseekStart = Date.now();
    const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          messages: apiMessages,
          tools: XERRAIRE_TOOLS,
          tool_choice: iterations === 1 ? toolChoice : "auto",
          temperature: 0.7,
          max_tokens: 8000,
        }),
        signal: AbortSignal.timeout(55000),
      });
      const deepseekLatency = Date.now() - deepseekStart;
      trace.emit(LogLevel.Debug, "DeepSeek call completed", {
        action_type: "llm_inference", action_name: "deepseek-chat",
        latency_ms: deepseekLatency,
        model: "deepseek-chat",
      });
      if (!response.ok) return res.status(502).json({ error: `DeepSeek error: ${response.status}` });

      const data = await response.json();
      const choice = data.choices?.[0];
      const msg = choice?.message;

      if (msg?.content && (!msg.tool_calls || msg.tool_calls.length === 0)) reply += msg.content;
      if (choice?.finish_reason === "stop") break;

      if (choice?.finish_reason === "tool_calls" && msg?.tool_calls) {
        for (const tc of msg.tool_calls) {
          let result;
          try {
            const args = JSON.parse(tc.function.arguments);
            result = await executeTool(tc.function.name, args, spaceId, uid, name, pendingActions, trace);
          } catch (toolErr) {
            result = { error: toolErr.message };
          }
          if (result.action === "open_settings") pendingActions.push({ type: "open_settings" });
          if (result.action === "open_marketplace") pendingActions.push({ type: "open_marketplace", url: result.url });
          if (result.results !== undefined && tc.function.name === "searchMarketplace") {
            pendingActions.push({ type: "marketplace_results", results: result.results, total: result.total, query: JSON.parse(tc.function.arguments).query });
          }
          apiMessages.push(msg);
          apiMessages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
        }
        continue;
      }
      break;
    }

    await pool.query(`INSERT INTO cf_conversations (user_id, space_id, role, content) VALUES ($1, $2, 'assistant', $3)`, [uid, spaceId, reply]);

    // Save bot reply to Firestore
    await db.collection("spaces").doc(spaceId).collection("messages").add({
      role: "bot",
      text: reply || "Fet!",
      uid,
      language: language || "ca",
      createdAt: new Date().toISOString(),
    }).catch(() => {});
    
    const totalLatency = Date.now() - startTime;
    trace.emit(LogLevel.Info, "chat response sent", {
      action_type: "lifecycle", action_name: "chat_response",
      latency_ms: totalLatency,
    });

    res.json({ reply, actions: pendingActions.length > 0 ? pendingActions : undefined });
  } catch (err) {
    trace.emit(LogLevel.Error, "chat error", {
      action_type: "lifecycle",
      error: { type: "ChatError", message: err.message },
      latency_ms: Date.now() - startTime,
    });
    console.error("[xerraire] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/history/:uid/:spaceId", async (req, res) => {
  try {
    const { uid, spaceId } = req.params;
    const result = await pool.query(`SELECT role, content FROM cf_conversations WHERE user_id = $1 AND space_id = $2 ORDER BY created_at ASC LIMIT 100`, [uid, spaceId]);
    res.json({ messages: result.rows.map((r) => ({ role: r.role === "assistant" ? "bot" : r.role, text: r.content })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3002, async () => {
  console.log("[xerraire] listening on port 3002");
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, display_name TEXT, photo_url TEXT)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS cf_conversations (id SERIAL PRIMARY KEY, user_id TEXT, space_id TEXT, role TEXT, content TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_cf_conv ON cf_conversations (user_id, space_id, created_at)`);
    console.log("[xerraire] DB tables ready");
  } catch (err) {
    console.error("[xerraire] DB init error:", err.message);
  }
});
