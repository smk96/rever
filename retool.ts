// retool_debug.ts - 调试版本
// 添加更多日志输出来诊断问题

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// 启用调试模式
let DEBUG_MODE = true;
function logDebug(msg: unknown) {
  if (DEBUG_MODE) console.log(`[DEBUG]`, msg);
}

// 配置（与原版相同）
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
    domain_name: "edubaa.retool.com",
    x_xsrf_token: "a7bafe53-5b28-4554-b9d8-8c37895a63d6",
    accessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ4c3JmVG9rZW4iOiJhN2JhZmU1My01YjI4LTQ1NTQtYjlkOC04YzM3ODk1YTYzZDYiLCJ2ZXJzaW9uIjoiMS4yIiwiaWF0IjoxNzUxMjg1MzM3fQ.UDh3aMd9z5n19AtHvvg0bfS9P9QLROBvzc1LFzOtROM",
    is_valid: true,
    last_used: 0,
    error_count: 0,
    agents: [],
  },
];

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
type ChatCompletionRequest = {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
};

type ModelRecord = {
  id: string;
  name: string;
  model_name: string;
  owned_by: string;
  agents: string[];
};

let AVAILABLE_MODELS: ModelRecord[] = [];

// Retool API 函数（添加更多日志）
async function retoolQueryAgents(acc: RetoolAccount) {
  logDebug(`查询代理: ${acc.domain_name}`);
  const url = `https://${acc.domain_name}/api/agents`;
  
  try {
    const resp = await fetch(url, {
      headers: {
        "x-xsrf-token": acc.x_xsrf_token,
        "Cookie": `accessToken=${acc.accessToken}`,
        "User-Agent": "Rever-Deno-Port/1.0",
        "Accept": "application/json",
      },
    });
    
    logDebug(`代理查询响应: ${resp.status}`);
    
    if (!resp.ok) {
      const errorText = await resp.text();
      logDebug(`代理查询失败: ${errorText}`);
      throw new Error(`Agent query failed ${resp.status}: ${errorText}`);
    }
    
    const data = await resp.json();
    logDebug(`找到 ${data.agents?.length || 0} 个代理`);
    return data.agents as any[];
  } catch (error) {
    logDebug(`代理查询异常: ${error}`);
    throw error;
  }
}

async function retoolGetThreadId(acc: RetoolAccount, agentId: string) {
  logDebug(`创建线程: agent=${agentId}`);
  const url = `https://${acc.domain_name}/api/agents/${agentId}/threads`;
  
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-xsrf-token": acc.x_xsrf_token,
        "Cookie": `accessToken=${acc.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "", timezone: "" }),
    });
    
    logDebug(`线程创建响应: ${resp.status}`);
    
    if (!resp.ok) {
      const errorText = await resp.text();
      logDebug(`线程创建失败: ${errorText}`);
      throw new Error(`create thread failed ${resp.status}: ${errorText}`);
    }
    
    const data = await resp.json();
    logDebug(`线程ID: ${data.id}`);
    return data.id as string;
  } catch (error) {
    logDebug(`线程创建异常: ${error}`);
    throw error;
  }
}

async function retoolSendMessage(
  acc: RetoolAccount,
  agentId: string,
  threadId: string,
  text: string,
) {
  logDebug(`发送消息: thread=${threadId}, length=${text.length}`);
  const url = `https://${acc.domain_name}/api/agents/${agentId}/threads/${threadId}/messages`;
  
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "x-xsrf-token": acc.x_xsrf_token,
        "Cookie": `accessToken=${acc.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "text", text, timezone: "Asia/Shanghai" }),
    });
    
    logDebug(`消息发送响应: ${resp.status}`);
    
    if (!resp.ok) {
      const errorText = await resp.text();
      logDebug(`消息发送失败: ${errorText}`);
      throw new Error(`send message failed ${resp.status}: ${errorText}`);
    }
    
    const data = await resp.json();
    logDebug(`运行ID: ${data.content?.runId}`);
    return data.content.runId as string;
  } catch (error) {
    logDebug(`消息发送异常: ${error}`);
    throw error;
  }
}

async function retoolGetMessage(
  acc: RetoolAccount,
  agentId: string,
  runId: string,
  timeoutMs = 300_000,
) {
  logDebug(`等待响应: runId=${runId}, timeout=${timeoutMs}ms`);
  const url = `https://${acc.domain_name}/api/agents/${agentId}/logs/${runId}`;
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  
  while (Date.now() < deadline) {
    attempts++;
    try {
      const resp = await fetch(url, {
        headers: {
          "x-xsrf-token": acc.x_xsrf_token,
          "Cookie": `accessToken=${acc.accessToken}`,
          "Accept": "application/json",
        },
      });
      
      if (!resp.ok) {
        const errorText = await resp.text();
        logDebug(`日志获取失败 (尝试 ${attempts}): ${resp.status} ${errorText}`);
        throw new Error(`get log failed ${resp.status}: ${errorText}`);
      }
      
      const data = await resp.json();
      logDebug(`日志状态 (尝试 ${attempts}): ${data.status}`);
      
      if (data.status === "COMPLETED") {
        const trace = data.trace;
        const last = trace[trace.length - 1];
        const content = last.data.data.content as string;
        logDebug(`响应完成: length=${content.length}`);
        return content;
      }
      
      if (data.status === "FAILED") {
        logDebug(`运行失败: ${JSON.stringify(data)}`);
        throw new Error(`Run failed: ${data.error || 'Unknown error'}`);
      }
      
    } catch (error) {
      logDebug(`日志获取异常 (尝试 ${attempts}): ${error}`);
      if (attempts >= 3) throw error;
    }
    
    await new Promise((r) => setTimeout(r, 1_000));
  }
  
  logDebug(`等待超时: ${attempts} 次尝试`);
  throw new Error(`timeout waiting for completion after ${attempts} attempts`);
}

// 其他函数保持不变...
function formatMessagesForRetool(messages: ChatMessage[]) {
  let out = "";
  for (const m of messages) {
    const role = m.role === "user" ? "Human" : "Assistant";
    out += `\n\n${role}: ${m.content}`;
  }
  if (messages.length && messages[messages.length - 1].role === "assistant") {
    out += "\n\nHuman: ";
  }
  return out;
}

function getBestRetoolAccount(modelId: string) {
  logDebug(`选择账户: model=${modelId}`);
  const now = Date.now();
  const record = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!record) {
    logDebug(`模型未找到: ${modelId}`);
    return undefined;
  }
  
  const { agents: allowed } = record;
  logDebug(`允许的代理: ${allowed.join(', ')}`);
  
  const candidates = RETOOL_ACCOUNTS.filter((acc) => {
    if (!acc.is_valid) {
      logDebug(`账户无效: ${acc.domain_name}`);
      return false;
    }
    if (acc.error_count >= 3 && now - acc.last_used < 300_000) {
      logDebug(`账户错误过多: ${acc.domain_name}`);
      return false;
    }
    const agent = acc.agents.find((a) => allowed.includes(a.id));
    if (!agent) {
      logDebug(`账户无匹配代理: ${acc.domain_name}`);
      return false;
    }
    acc.selected_agent_id = agent.id;
    logDebug(`选择代理: ${agent.id} for ${acc.domain_name}`);
    return true;
  });
  
  if (!candidates.length) {
    logDebug(`无可用账户`);
    return undefined;
  }
  
  candidates.sort((a, b) => (a.last_used - b.last_used) || (a.error_count - b.error_count));
  const chosen = candidates[0];
  chosen.last_used = now;
  logDebug(`选择账户: ${chosen.domain_name}`);
  return chosen;
}

async function initializeRetoolEnvironment() {
  console.log("🔄 初始化 Retool 环境...");
  
  for (const acc of RETOOL_ACCOUNTS) {
    try {
      console.log(`📡 查询账户: ${acc.domain_name}`);
      acc.agents = await retoolQueryAgents(acc);
      console.log(`✅ ${acc.domain_name} → ${acc.agents.length} 个代理`);
      
      // 显示代理详情
      for (const agent of acc.agents) {
        console.log(`   - ${agent.name} (${agent.id}) - ${agent.data?.model || 'unknown'}`);
      }
    } catch (err) {
      console.error(`❌ ${acc.domain_name} 查询失败:`, err);
      acc.agents = [];
      acc.is_valid = false;
    }
  }
  
  // 聚合模型
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
          owned_by: fullName.toLowerCase().includes("claude") ? "anthropic" : "openai",
          agents: [],
        };
        map.set(series, rec);
      }
      rec.agents.push(ag.id);
    }
  }
  
  AVAILABLE_MODELS = [...map.values()];
  console.log(`🎯 加载了 ${AVAILABLE_MODELS.length} 个模型系列:`);
  for (const model of AVAILABLE_MODELS) {
    console.log(`   - ${model.id}: ${model.name} (${model.agents.length} 个代理)`);
  }
}

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

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  
  logDebug(`请求: ${req.method} ${pathname}`);

  if (pathname === "/debug" && req.method === "GET") {
    const enable = url.searchParams.get("enable");
    if (enable !== null) DEBUG_MODE = enable === "true";
    return jsonResponse({ debug_mode: DEBUG_MODE });
  }

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

  if (pathname === "/v1/chat/completions" && req.method === "POST") {
    logDebug("开始处理聊天完成请求");
    
    try {
      requireAuth(req);
      logDebug("认证通过");
    } catch (e) {
      logDebug(`认证失败: ${e.message}`);
      return jsonResponse({ error: "unauthorized" }, e.message === "403" ? 403 : 401);
    }

    let body: ChatCompletionRequest;
    try {
      body = await req.json();
      logDebug(`请求体: ${JSON.stringify(body)}`);
    } catch {
      logDebug("JSON 解析失败");
      return jsonResponse({ error: "invalid json" }, 400);
    }
    
    if (!body.messages?.length) {
      logDebug("没有消息");
      return jsonResponse({ error: "no messages supplied" }, 400);
    }
    
    if (!AVAILABLE_MODELS.find((m) => m.id === body.model)) {
      logDebug(`模型未找到: ${body.model}`);
      return jsonResponse({ error: `model '${body.model}' not found` }, 404);
    }

    const formatted = formatMessagesForRetool(body.messages);
    logDebug(`格式化消息: ${formatted.slice(0, 120)}...`);

    // 尝试处理请求
    for (let attempt = 0; attempt < RETOOL_ACCOUNTS.length; ++attempt) {
      logDebug(`尝试 ${attempt + 1}/${RETOOL_ACCOUNTS.length}`);
      
      const acc = getBestRetoolAccount(body.model);
      if (!acc) {
        logDebug("没有可用账户");
        break;
      }

      const agentId = acc.selected_agent_id!;
      try {
        logDebug(`使用账户: ${acc.domain_name}, 代理: ${agentId}`);
        
        const threadId = await retoolGetThreadId(acc, agentId);
        const runId = await retoolSendMessage(acc, agentId, threadId, formatted);
        const responseTxt = await retoolGetMessage(acc, agentId, runId);

        logDebug("请求成功完成");
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
      } catch (err) {
        logDebug(`账户 ${acc.domain_name} 失败: ${err}`);
        acc.error_count++;
        if (err instanceof Error && /401|403/.test(err.message)) {
          acc.is_valid = false;
          logDebug(`账户 ${acc.domain_name} 标记为无效`);
        }
      }
    }

    logDebug("所有尝试都失败了");
    return jsonResponse({ error: "all retool attempts failed" }, 503);
  }

  return jsonResponse({ error: "not found" }, 404);
}

// 启动服务器
await initializeRetoolEnvironment();
console.log("🚀 Retool OpenAI Adapter (调试版) 运行在 http://0.0.0.0:8000");
serve(handleRequest, { port: 8000 });
