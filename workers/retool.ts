/****************************************************************************************
 *  Retool OpenAI API Adapter – Cloudflare Workers edition
 *  -------------------------------------------------------------------------------------
 *  Part of **Rever by Shinplex**  → https://github.com/Shinplex/rever
 *  Licensed under the Affero Public License – APGL-3.0
 *
 *  End-points
 *    • GET  /v1/models                 (requires “Authorization: Bearer <client-key>”)
 *    • GET  /models                    (public)
 *    • POST /v1/chat/completions       (requires auth, supports stream=true|false)
 *    • GET  /debug?enable=true|false   (toggle verbose debug log)
 *
 *  Deploy with:
 *      npx wrangler deploy retool.ts
 *  (Wrangler v3+; this file is self-contained – no external packages required.)
 *****************************************************************************************/

/* ------------------------------------------------------------------------------------------------
 *  Hard-coded configuration – replace with your real keys and Retool credentials
 * ------------------------------------------------------------------------------------------------ */
const VALID_CLIENT_KEYS = new Set<string>([
  "sk-demo-1234567890abcdef",
  "sk-demo-fedcba0987654321",
]);

type RetoolAccount = {
  domain_name: string;
  x_xsrf_token: string;
  accessToken: string;
  is_valid: boolean;
  last_used: number;
  error_count: number;
  agents: any[];
  selected_agent_id?: string;
};

const RETOOL_ACCOUNTS: RetoolAccount[] = [
  {
    domain_name: "your-domain.retool.com",
    x_xsrf_token: "xxxx-xxxx-xxxx",
    accessToken: "yyyy-yyyy-yyyy",
    is_valid: true,
    last_used: 0,
    error_count: 0,
    agents: [],
  },
  // …add more accounts if needed
];

/* ------------------------------------------------------------------------------------------------
 *  Global runtime state (persists in warm Cloudflare worker instances)
 * ------------------------------------------------------------------------------------------------ */
type ModelRecord = {
  id: string;
  name: string;
  model_name: string;
  owned_by: string;
  agents: string[];
};
let AVAILABLE_MODELS: ModelRecord[] = [];
let DEBUG_MODE = false;

function logDebug(msg: unknown) {
  if (DEBUG_MODE) console.log("[DEBUG]", msg);
}

/* ------------------------------------------------------------------------------------------------
 *  Retool API helpers
 * ------------------------------------------------------------------------------------------------ */
async function retoolQueryAgents(acc: RetoolAccount) {
  const url = `https://${acc.domain_name}/api/agents`;
  const r = await fetch(url, {
    headers: {
      "x-xsrf-token": acc.x_xsrf_token,
      "Cookie": `accessToken=${acc.accessToken}`,
      "User-Agent": "Rever-Worker/1.0",
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error(`agent query ${r.status}`);
  const data = await r.json();
  return data.agents as any[];
}
async function retoolGetThreadId(acc: RetoolAccount, agentId: string) {
  const url = `https://${acc.domain_name}/api/agents/${agentId}/threads`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "x-xsrf-token": acc.x_xsrf_token,
      "Cookie": `accessToken=${acc.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "", timezone: "" }),
  });
  if (!r.ok) throw new Error(`thread ${r.status}`);
  const data = await r.json();
  return data.id as string;
}
async function retoolSendMessage(
  acc: RetoolAccount,
  agentId: string,
  threadId: string,
  text: string,
) {
  const url =
    `https://${acc.domain_name}/api/agents/${agentId}/threads/${threadId}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "x-xsrf-token": acc.x_xsrf_token,
      "Cookie": `accessToken=${acc.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "text", text, timezone: "Asia/Shanghai" }),
  });
  if (!r.ok) throw new Error(`send ${r.status}`);
  const data = await r.json();
  return data.content.runId as string;
}
async function retoolGetMessage(
  acc: RetoolAccount,
  agentId: string,
  runId: string,
  timeoutMs = 300_000,
) {
  const url = `https://${acc.domain_name}/api/agents/${agentId}/logs/${runId}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(url, {
      headers: {
        "x-xsrf-token": acc.x_xsrf_token,
        "Cookie": `accessToken=${acc.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!r.ok) throw new Error(`log ${r.status}`);
    const data = await r.json();
    if (data.status === "COMPLETED") {
      const trace = data.trace;
      const last = trace[trace.length - 1];
      return last.data.data.content as string;
    }
    await new Promise((res) => setTimeout(res, 1_000));
  }
  throw new Error("timeout");
}

/* ------------------------------------------------------------------------------------------------
 *  Misc helpers
 * ------------------------------------------------------------------------------------------------ */
type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
function formatMessagesForRetool(msgs: ChatMessage[]) {
  let out = "";
  for (const m of msgs) {
    const role = m.role === "user" ? "Human" : "Assistant";
    out += `\n\n${role}: ${m.content}`;
  }
  if (msgs.length && msgs[msgs.length - 1].role === "assistant") out += "\n\nHuman: ";
  return out;
}

function getBestAccount(modelId: string) {
  const rec = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!rec) return undefined;
  const now = Date.now();
  const cands = RETOOL_ACCOUNTS.filter((acc) => {
    if (!acc.is_valid) return false;
    if (acc.error_count >= 3 && now - acc.last_used < 300_000) return false;
    const ag = acc.agents.find((a) => rec.agents.includes(a.id));
    if (!ag) return false;
    acc.selected_agent_id = ag.id;
    return true;
  });
  if (!cands.length) return undefined;
  cands.sort((a, b) =>
    (a.last_used - b.last_used) || (a.error_count - b.error_count)
  );
  const chosen = cands[0];
  chosen.last_used = now;
  return chosen;
}

/* ------------------------------------------------------------------------------------------------
 *  One-time initialization (agent discovery)
 * ------------------------------------------------------------------------------------------------ */
async function initializeRetoolEnvironment() {
  for (const acc of RETOOL_ACCOUNTS) {
    try {
      acc.agents = await retoolQueryAgents(acc);
      logDebug(`${acc.domain_name}: ${acc.agents.length} agents`);
    } catch (e) {
      console.error("agent fetch", e);
      acc.agents = [];
    }
  }
  const map = new Map<string, ModelRecord>();
  for (const acc of RETOOL_ACCOUNTS) {
    for (const ag of acc.agents) {
      const full = ag.data?.model ?? "unknown";
      const series = full.split("-").slice(0, 3).join("-");
      let rec = map.get(series);
      if (!rec) {
        rec = {
          id: series,
          name: ag.name,
          model_name: full,
          owned_by: full.toLowerCase().includes("claude") ? "anthropic" : "openai",
          agents: [],
        };
        map.set(series, rec);
      }
      rec.agents.push(ag.id);
    }
  }
  AVAILABLE_MODELS = [...map.values()];
  console.log(`Loaded ${AVAILABLE_MODELS.length} model families (Workers boot)`);
}
const INIT_PROMISE = initializeRetoolEnvironment();

/* ------------------------------------------------------------------------------------------------
 *  Streaming (Server-Sent Events) helpers for Workers
 * ------------------------------------------------------------------------------------------------ */
async function* retoolStream(fullMsg: string, modelId: string) {
  const sid = crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  yield `data: ${JSON.stringify({
    id: sid,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ delta: { role: "assistant" }, index: 0 }],
  })}\n\n`;
  for (let i = 0; i < fullMsg.length; i += 5) {
    const delta = fullMsg.slice(i, i + 5);
    yield `data: ${JSON.stringify({
      id: sid,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ delta: { content: delta }, index: 0 }],
    })}\n\n`;
    await new Promise((r) => setTimeout(r, 10));
  }
  yield `data: ${JSON.stringify({
    id: sid,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
  })}\n\ndata: [DONE]\n\n`;
}
async function* errorStream(msg: string, code = 503) {
  yield `data: ${JSON.stringify({ error: { message: msg, code } })}\n\n`;
  yield "data: [DONE]\n\n";
}
function streamResponse(gen: AsyncGenerator<string>, status = 200) {
  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        for await (const chunk of gen) {
          ctrl.enqueue(new TextEncoder().encode(chunk));
        }
        ctrl.close();
      } catch (e) {
        ctrl.error(e);
      }
    },
  });
  return new Response(stream, {
    status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/* ------------------------------------------------------------------------------------------------
 *  Core request handler
 * ------------------------------------------------------------------------------------------------ */
export default {
  async fetch(req: Request): Promise<Response> {
    await INIT_PROMISE; // ensure agents loaded

    const url = new URL(req.url);
    const path = url.pathname;

    /* ---- /debug ------------------------------------------------------------------------- */
    if (path === "/debug" && req.method === "GET") {
      if (url.searchParams.has("enable")) {
        DEBUG_MODE = url.searchParams.get("enable") === "true";
      }
      return json({ debug_mode: DEBUG_MODE });
    }

    /* ---- /v1/models (auth) --------------------------------------------------------------- */
    if (path === "/v1/models" && req.method === "GET") {
      const authErr = checkAuth(req);
      if (authErr) return authErr;
      return json(modelsPayload());
    }

    /* ---- /models (public) ---------------------------------------------------------------- */
    if (path === "/models" && req.method === "GET") {
      return json(modelsPayload());
    }

    /* ---- /v1/chat/completions ------------------------------------------------------------ */
    if (path === "/v1/chat/completions" && req.method === "POST") {
      const authErr = checkAuth(req);
      if (authErr) return authErr;

      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid JSON" }, 400);
      }
      if (!body.messages?.length) return json({ error: "no messages" }, 400);
      if (!AVAILABLE_MODELS.find((m) => m.id === body.model)) {
        return json({ error: `model '${body.model}' not found` }, 404);
      }

      const formatted = formatMessagesForRetool(body.messages);
      logDebug(formatted.slice(0, 120) + "…");

      /* try each account --------------------------------------------------- */
      for (let i = 0; i < RETOOL_ACCOUNTS.length; ++i) {
        const acc = getBestAccount(body.model);
        if (!acc) break;
        const agentId = acc.selected_agent_id!;
        try {
          const thread = await retoolGetThreadId(acc, agentId);
          const runId = await retoolSendMessage(acc, agentId, thread, formatted);
          const txt = await retoolGetMessage(acc, agentId, runId);

          if (body.stream) {
            return streamResponse(retoolStream(txt, body.model));
          }
          return json({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{
              index: 0,
              message: { role: "assistant", content: txt },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        } catch (e) {
          logDebug(`acc ${acc.domain_name} err: ${e}`);
          acc.error_count++;
          if (/401|403/.test(String(e))) acc.is_valid = false;
        }
      }

      /* all accounts failed */
      if (body.stream) {
        return streamResponse(errorStream("all retool attempts failed"));
      }
      return json({ error: "all retool attempts failed" }, 503);
    }

    return json({ error: "not found" }, 404);
  },
};

/* ------------------------------------------------------------------------------------------------
 *  Small helpers
 * ------------------------------------------------------------------------------------------------ */
function modelsPayload() {
  return {
    object: "list",
    data: AVAILABLE_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: m.owned_by,
      name: `${m.name} (${m.model_name})`,
    })),
  };
}
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function checkAuth(req: Request): Response | void {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return json({ error: "unauthorized" }, 401);
  if (!VALID_CLIENT_KEYS.has(m[1].trim())) return json({ error: "forbidden" }, 403);
}
