// retool.ts
/****************************************************************************************
 *  Retool OpenAI API Adapter (Deno edition)
 *  -------------------------------------------------------------------------------------
 *  Part of **Rever by Shinplex**  → https://github.com/Shinplex/rever
 *  Licensed under the Affero Public License – APGL-3.0
 *
 *  ▸ End-points
 *      GET  /v1/models                 (requires “Bearer <client-key>”)
 *      GET  /models                    (no auth)
 *      POST /v1/chat/completions       (requires auth, supports stream=true|false)
 *      GET  /debug?enable=true|false   (toggle verbose debug log)
 *
 *  ▸ How to run
 *      deno run -A retool.ts
 *****************************************************************************************/

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// ----------------------------------------------------------------------------
// Hard-coded configuration  (replace with your own data)
// ----------------------------------------------------------------------------
const VALID_CLIENT_KEYS = new Set<string>([
  // Client API keys that callers must present in Authorization: Bearer <key>
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
  /** filled at runtime */ selected_agent_id?: string;
};

const RETOOL_ACCOUNTS: RetoolAccount[] = [
  {
    domain_name: "edubaa.retool.com",
    x_xsrf_token: "a7bafe53-5b28-4554-b9d8-8c37895a63d6",
    accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ4c3JmVG9rZW4iOiJhN2JhZmU1My01YjI4LTQ1NTQtYjlkOC04YzM3ODk1YTYzZDYiLCJ2ZXJzaW9uIjoiMS4yIiwiaWF0IjoxNzUxMjg1MzM3fQ.UDh3aMd9z5n19AtHvvg0bfS9P9QLROBvzc1LFzOtROM
a7bafe53-5b28-4554-b9d8-8c37895a63d6",
    is_valid: true,
    last_used: 0,
    error_count: 0,
    agents: [],
  },
  // add more accounts if you have them
];

// ----------------------------------------------------------------------------
// Types that mimic OpenAI-style payloads (only the fields we need).
// ----------------------------------------------------------------------------
type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
};

// Model registry – filled after we discover agents for each account
type ModelRecord = {
  id: string;            // e.g. "claude-sonnet-4"
  name: string;          // agent display name
  model_name: string;    // full underlying model id
  owned_by: string;      // "anthropic" | "openai"
  agents: string[];      // all agentIds supporting the model
};
let AVAILABLE_MODELS: ModelRecord[] = [];

// ----------------------------------------------------------------------------
// House-keeping
// ----------------------------------------------------------------------------
let DEBUG_MODE = false;
function logDebug(msg: unknown) {
  if (DEBUG_MODE) console.log(`[DEBUG]`, msg);
}

// ----------------------------------------------------------------------------
// Retool API helpers
// ----------------------------------------------------------------------------
async function retoolQueryAgents(acc: RetoolAccount) {
  const url = `https://${acc.domain_name}/api/agents`;
  const resp = await fetch(url, {
    headers: {
      "x-xsrf-token": acc.x_xsrf_token,
      "Cookie": `accessToken=${acc.accessToken}`,
      "User-Agent": "Rever-Deno-Port/1.0",
      "Accept": "application/json",
    },
  });
  if (!resp.ok) throw new Error(`Agent query failed ${resp.status}`);
  const data = await resp.json();
  return data.agents as any[];
}
async function retoolGetThreadId(acc: RetoolAccount, agentId: string) {
  const url = `https://${acc.domain_name}/api/agents/${agentId}/threads`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-xsrf-token": acc.x_xsrf_token,
      "Cookie": `accessToken=${acc.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "", timezone: "" }),
  });
  if (!resp.ok) throw new Error(`create thread failed ${resp.status}`);
  const data = await resp.json();
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
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-xsrf-token": acc.x_xsrf_token,
      "Cookie": `accessToken=${acc.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: "text", text, timezone: "Asia/Shanghai" }),
  });
  if (!resp.ok) throw new Error(`send message failed ${resp.status}`);
  const data = await resp.json();
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
    const resp = await fetch(url, {
      headers: {
        "x-xsrf-token": acc.x_xsrf_token,
        "Cookie": `accessToken=${acc.accessToken}`,
        "Accept": "application/json",
      },
    });
    if (!resp.ok) throw new Error(`get log failed ${resp.status}`);
    const data = await resp.json();
    if (data.status === "COMPLETED") {
      const trace = data.trace;
      const last = trace[trace.length - 1];
      // deep path: data.data.content
      return last.data.data.content as string;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("timeout waiting for completion");
}

// ----------------------------------------------------------------------------
// Utility logic
// ----------------------------------------------------------------------------
function formatMessagesForRetool(messages: ChatMessage[]) {
  let out = "";
  for (const m of messages) {
    const role = m.role === "user" ? "Human" : "Assistant";
    out += `\n\n${role}: ${m.content}`;
  }
  if (messages.length && messages[messages.length - 1].role === "assistant") {
    out += "\n\nHuman: "; // prompt for next user msg
  }
  return out;
}

function getBestRetoolAccount(modelId: string) {
  const now = Date.now();
  // find agentIds for this model
  const record = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!record) return undefined;
  const { agents: allowed } = record;
  // filter accounts that have a valid agent match
  const candidates = RETOOL_ACCOUNTS.filter((acc) => {
    if (!acc.is_valid) return false;
    if (
      acc.error_count >= 3 && now - acc.last_used < 300_000 /*5 min*/
    ) return false;
    const agent = acc.agents.find((a) => allowed.includes(a.id));
    if (!agent) return false;
    acc.selected_agent_id = agent.id;
    return true;
  });
  if (!candidates.length) return undefined;
  candidates.sort((a, b) =>
    (a.last_used - b.last_used) || (a.error_count - b.error_count)
  );
  const chosen = candidates[0];
  chosen.last_used = now;
  return chosen;
}

// ----------------------------------------------------------------------------
// Model discovery – run once at startup
// ----------------------------------------------------------------------------
async function initializeRetoolEnvironment() {
  for (const acc of RETOOL_ACCOUNTS) {
    try {
      acc.agents = await retoolQueryAgents(acc);
      logDebug(`${acc.domain_name} → ${acc.agents.length} agents`);
    } catch (err) {
      console.error(`agent query for ${acc.domain_name} failed`, err);
      acc.agents = [];
    }
  }
  // aggregate into unique model series
  const map = new Map<string, ModelRecord>();
  for (const acc of RETOOL_ACCOUNTS) {
    for (const ag of acc.agents) {
      const fullName: string = ag.data?.model ?? "unknown";
      const series = fullName.split("-").slice(0, 3).join("-");
      let rec = map.get(series);
      if (!rec) {
        rec = {
          id: series,
          name: ag.name,
          model_name: fullName,
          owned_by: fullName.toLowerCase().includes("claude")
            ? "anthropic"
            : "openai",
          agents: [],
        };
        map.set(series, rec);
      }
      rec.agents.push(ag.id);
    }
  }
  AVAILABLE_MODELS = [...map.values()];
  console.log(
    `Loaded ${AVAILABLE_MODELS.length} unique model families from ${
      RETOOL_ACCOUNTS.length
    } Retool account(s)`,
  );
}

// ----------------------------------------------------------------------------
// HTTP Server
// ----------------------------------------------------------------------------
function requireAuth(req: Request): string {
  const header = req.headers.get("Authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("401");
  const token = m[1].trim();
  if (!VALID_CLIENT_KEYS.has(token)) throw new Error("403");
  return token;
}

function jsonResponse(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Streaming helpers
function sseStream(
  gen: AsyncGenerator<string>,
  status = 200,
): Response {
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
      "Connection": "keep-alive",
    },
  });
}

// Stream generators
async function* retoolStreamGenerator(
  fullMessage: string,
  modelId: string,
) {
  const streamId = crypto.randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const header = JSON.stringify({
    id: streamId,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ delta: { role: "assistant" }, index: 0 }],
  });
  yield `data: ${header}\n\n`;

  const chunkSize = 5;
  for (let i = 0; i < fullMessage.length; i += chunkSize) {
    const part = fullMessage.slice(i, i + chunkSize);
    const body = JSON.stringify({
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ delta: { content: part }, index: 0 }],
    });
    yield `data: ${body}\n\n`;
    await new Promise((r) => setTimeout(r, 10));
  }
  const done = JSON.stringify({
    id: streamId,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ delta: {}, index: 0, finish_reason: "stop" }],
  });
  yield `data: ${done}\n\ndata: [DONE]\n\n`;
}
async function* errorStreamGenerator(msg: string, code = 503) {
  yield `data: ${JSON.stringify({ error: { message: msg, code } })}\n\n`;
  yield "data: [DONE]\n\n";
}

// ----------------------------------------------------------------------------
// Main request handler
// ----------------------------------------------------------------------------
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;

  // ------------------------------------------------ GET /debug
  if (pathname === "/debug" && req.method === "GET") {
    const enable = url.searchParams.get("enable");
    if (enable !== null) DEBUG_MODE = enable === "true";
    return jsonResponse({ debug_mode: DEBUG_MODE });
  }

  // ------------------------------------------------ GET /v1/models (requires auth)
  if (pathname === "/v1/models" && req.method === "GET") {
    try {
      requireAuth(req);
    } catch (e) {
      return jsonResponse({ error: "unauthorized" }, e.message === "403" ? 403 : 401);
    }
    return jsonResponse({
      object: "list",
      data: AVAILABLE_MODELS.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: m.owned_by,
        name: `${m.name} (${m.model_name})`,
      })),
    });
  }

  // ------------------------------------------------ GET /models (public)
  if (pathname === "/models" && req.method === "GET") {
    return jsonResponse({
      object: "list",
      data: AVAILABLE_MODELS.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: m.owned_by,
        name: `${m.name} (${m.model_name})`,
      })),
    });
  }

  // ------------------------------------------------ POST /v1/chat/completions
  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    // auth
    try {
      requireAuth(req);
    } catch (e) {
      return jsonResponse({ error: "unauthorized" }, e.message === "403" ? 403 : 401);
    }

    // parse body
    let body: ChatCompletionRequest;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "invalid json" }, 400);
    }
    if (!body.messages?.length) {
      return jsonResponse({ error: "no messages supplied" }, 400);
    }
    if (!AVAILABLE_MODELS.find((m) => m.id === body.model)) {
      return jsonResponse({ error: `model '${body.model}' not found` }, 404);
    }

    const formatted = formatMessagesForRetool(body.messages);
    logDebug(`formatted:\n${formatted.slice(0, 120)}…`);

    // try each account
    for (let attempt = 0; attempt < RETOOL_ACCOUNTS.length; ++attempt) {
      const acc = getBestRetoolAccount(body.model);
      if (!acc) break; // no more accounts

      const agentId = acc.selected_agent_id!;
      try {
        const threadId = await retoolGetThreadId(acc, agentId);
        const runId = await retoolSendMessage(acc, agentId, threadId, formatted);
        const responseTxt = await retoolGetMessage(acc, agentId, runId);

        if (body.stream) {
          return sseStream(retoolStreamGenerator(responseTxt, body.model));
        } else {
          return jsonResponse({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: responseTxt },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        }
      } catch (err) {
        logDebug(`account ${acc.domain_name} failed: ${err}`);
        acc.error_count++;
        if (err instanceof Error && /401|403/.test(err.message)) acc.is_valid =
          false;
      }
    }

    // all attempts failed
    if (body.stream) {
      return sseStream(errorStreamGenerator("all retool attempts failed"));
    }
    return jsonResponse({ error: "all retool attempts failed" }, 503);
  }

  return jsonResponse({ error: "not found" }, 404);
}

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
await initializeRetoolEnvironment();
console.log("Retool OpenAI Adapter running on http://0.0.0.0:8000");
serve(handleRequest, { port: 8000 });
