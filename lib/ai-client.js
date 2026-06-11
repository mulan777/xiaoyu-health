/**
 * lib/ai-client.js
 * OpenAI 兼容协议客户端（DeepSeek / 通义 / 智谱 / Kimi / 豆包 等都兼容）
 *
 * 用法：
 *   const { chatCompletion, chatCompletionStream } = require('./ai-client');
 *   await chatCompletion({ messages, settings });
 *   for await (const piece of chatCompletionStream({ messages, settings })) { ... }
 */

const { getAiSettings } = require('./db');

class AiNotConfiguredError extends Error {
  constructor(message) {
    super(message || 'AI 服务未配置');
    this.code = 'AI_NOT_CONFIGURED';
  }
}

class AiRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.code = 'AI_REQUEST_FAILED';
    this.status = status || 0;
  }
}

function ensureBaseUrl(raw) {
  let base = String(raw || '').trim();
  if (!base) throw new AiNotConfiguredError('AI 接入地址未配置');
  base = base.replace(/\/+$/, '');
  // 自动补齐 chat completions 路径
  if (/\/chat\/completions$/i.test(base)) return base;
  return base + '/chat/completions';
}

async function loadCfg() {
  const raw = await getAiSettings(true);
  if (String(raw.aiEnabled) !== '1') {
    throw new AiNotConfiguredError('AI 智能分析功能尚未启用，请联系管理员到「AI 接入」面板开启');
  }
  if (!raw.aiApiKey) {
    throw new AiNotConfiguredError('AI 密钥尚未填写，请联系管理员到「AI 接入」面板配置');
  }
  return {
    url: ensureBaseUrl(raw.aiBaseUrl),
    apiKey: raw.aiApiKey,
    model: raw.aiModel || 'deepseek-chat',
    timeoutMs: Number(raw.aiTimeoutMs) || 600000,
    temperature: Number(raw.aiTemperature),
    maxTokens: Number(raw.aiMaxTokens) || 0,
    systemPrompt: raw.aiSystemPrompt || ''
  };
}

function buildMessages(systemPrompt, userPrompt, extraMessages) {
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
  if (Array.isArray(extraMessages) && extraMessages.length) {
    messages.push(...extraMessages);
  }
  if (userPrompt) messages.push({ role: 'user', content: String(userPrompt) });
  return messages;
}

async function chatCompletion({ userPrompt, systemPrompt, extraMessages, overrides } = {}) {
  const cfg = await loadCfg();
  const finalSystem = (systemPrompt != null) ? systemPrompt : cfg.systemPrompt;
  const messages = buildMessages(finalSystem, userPrompt, extraMessages);

  const body = {
    model: (overrides && overrides.model) || cfg.model,
    messages,
    stream: false
  };
  const effectiveMaxTokens = (overrides && overrides.maxTokens != null) ? Number(overrides.maxTokens) : cfg.maxTokens;
  if (effectiveMaxTokens && Number.isFinite(effectiveMaxTokens) && effectiveMaxTokens > 0) {
    body.max_tokens = effectiveMaxTokens;
  }
  if (Number.isFinite(cfg.temperature)) body.temperature = cfg.temperature;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  let resp;
  try {
    resp = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new AiRequestError('AI 请求超时（>' + cfg.timeoutMs + 'ms）', 0);
    throw new AiRequestError('AI 请求失败：' + (err.message || err), 0);
  }
  clearTimeout(timer);
  const text = await resp.text();
  if (!resp.ok) {
    throw new AiRequestError('AI 接口返回 ' + resp.status + '：' + text.slice(0, 500), resp.status);
  }
  let json;
  try { json = JSON.parse(text); } catch (e) {
    throw new AiRequestError('AI 接口返回非 JSON：' + text.slice(0, 200), resp.status);
  }
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  return {
    content: String(content || ''),
    raw: json,
    model: body.model
  };
}

/**
 * 流式 chat completion，返回 async iterator，每个 yield 出 delta 文本。
 * 在 SSE 路由里直接 for await (const piece of stream) { res.write(...) }
 */
async function* chatCompletionStream({ userPrompt, systemPrompt, extraMessages, overrides } = {}) {
  const cfg = await loadCfg();
  const finalSystem = (systemPrompt != null) ? systemPrompt : cfg.systemPrompt;
  const messages = buildMessages(finalSystem, userPrompt, extraMessages);

  const body = {
    model: (overrides && overrides.model) || cfg.model,
    messages,
    stream: true
  };
  const effectiveMaxTokens = (overrides && overrides.maxTokens != null) ? Number(overrides.maxTokens) : cfg.maxTokens;
  if (effectiveMaxTokens && Number.isFinite(effectiveMaxTokens) && effectiveMaxTokens > 0) {
    body.max_tokens = effectiveMaxTokens;
  }
  if (Number.isFinite(cfg.temperature)) body.temperature = cfg.temperature;

  const ctrl = new AbortController();
  // 初连超时：只限制 fetch 发起阶段；拿到响应后改用“空闲超时”
  let timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);

  let resp;
  try {
    resp = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new AiRequestError('AI 初连超时（>' + cfg.timeoutMs + 'ms）', 0);
    throw new AiRequestError('AI 请求失败：' + (err.message || err), 0);
  }

  if (!resp.ok || !resp.body) {
    clearTimeout(timer);
    const text = resp.body ? await resp.text().catch(() => '') : '';
    throw new AiRequestError('AI 接口返回 ' + resp.status + '：' + (text || '').slice(0, 500), resp.status);
  }

  // 拿到响应后，切换为“空闲超时”：每次收到数据则重置
  const idleMs = cfg.timeoutMs;
  function resetIdle() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), idleMs);
  }
  resetIdle();

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  // 调用者未提供心跳重置则使用 timeoutMs 作为整体上限
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      resetIdle();
      // SSE: 行以 \n\n 分割事件
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const eventChunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = eventChunk.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          if (payload === '[DONE]') return;
          try {
            const obj = JSON.parse(payload);
            const delta = obj && obj.choices && obj.choices[0] && obj.choices[0].delta;
            if (!delta) continue;
            // 思维链（DeepSeek reasoner、智谱 GLM-Zero 等）
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
              yield { type: 'reasoning', content: delta.reasoning_content };
            }
            if (typeof delta.content === 'string' && delta.content.length) {
              yield { type: 'content', content: delta.content };
            }
          } catch (e) {
            // 个别厂商会发心跳/keep-alive，忽略
          }
        }
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    try { reader.releaseLock(); } catch (e) {}
  }
}

/**
 * 用于"测试连通性"按钮：发一句最短 prompt 看能否拿回内容
 */
async function testConnection() {
  const result = await chatCompletion({
    userPrompt: '请回复"OK"两个字符。',
    systemPrompt: '你是一个测试用的助手，按要求精简回复。',
    overrides: { maxTokens: 0 }
  });
  return {
    ok: true,
    model: result.model,
    sample: (result.content || '').slice(0, 80)
  };
}

module.exports = {
  chatCompletion,
  chatCompletionStream,
  testConnection,
  AiNotConfiguredError,
  AiRequestError
};
