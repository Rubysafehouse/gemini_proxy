export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

const signatureCache = new Map();

// 核心：BLOCK_NONE 安全关停配置
const BLOCK_NONE_SAFETY_SETTINGS = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" }
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  let targetPath = url.pathname;

  if (targetPath.startsWith('/api/proxy')) {
    targetPath = targetPath.replace('/api/proxy', '');
  }

  if (targetPath === '/' || targetPath === '') {
    return res.status(200).json({ status: "ok", message: "Gemini Full-Feature Proxy Active!" });
  }

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    let bodyBuffer = Buffer.concat(chunks);

    // 提取 API Key (兼容 Header 和 URL)
    let apiKey = '';
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      apiKey = authHeader.substring(7).trim();
    } else if (url.searchParams.has('key')) {
      apiKey = url.searchParams.get('key');
    }

    // 🎯 检测如果是 Kelivo 发来的 OpenAI Chat 请求
    if ((targetPath.startsWith('/v1/chat/completions') || targetPath.includes('/chat/completions')) && req.method === 'POST') {
      const openaiJson = JSON.parse(bodyBuffer.toString('utf-8'));
      const model = openaiJson.model || 'gemini-2.5-flash';

      // 路由发往 Google 原生 API（原生 API 才合法允许 safetySettings）
      const targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

      let systemInstruction = undefined;
      const contents = [];

      // 1. 将 OpenAI messages 转化为 Google Native contents
      (openaiJson.messages || []).forEach(msg => {
        if (msg.role === 'system') {
          systemInstruction = { parts: [{ text: msg.content || '' }] };
        } else if (msg.role === 'user') {
          contents.push({
            role: 'user',
            parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
          });
        } else if (msg.role === 'assistant') {
          const parts = [];
          if (msg.content) parts.push({ text: msg.content });
          if (msg.tool_calls) {
            msg.tool_calls.forEach(tc => {
              const cachedSig = signatureCache.get(tc.id);
              parts.push({
                functionCall: {
                  name: tc.function?.name,
                  args: typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function?.arguments) : (tc.function?.arguments || {}),
                  thought_signature: cachedSig || "skip_thought_signature_validator"
                }
              });
            });
          }
          contents.push({ role: 'model', parts });
        } else if (msg.role === 'tool') {
          contents.push({
            role: 'function',
            parts: [{
              functionResponse: {
                name: msg.name || 'tool',
                response: { result: msg.content }
              }
            }]
          });
        }
      });

      // 2. 组装支持 BLOCK_NONE 的原生 Payload
      const nativePayload = {
        contents: contents,
        safetySettings: BLOCK_NONE_SAFETY_SETTINGS,
      };
      if (systemInstruction) nativePayload.systemInstruction = systemInstruction;
      if (openaiJson.temperature !== undefined) {
        nativePayload.generationConfig = { temperature: openaiJson.temperature };
      }

      bodyBuffer = Buffer.from(JSON.stringify(nativePayload), 'utf-8');

      // 3. 发送给 Google 原生接口（不传递 Bearer，防止 401）
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers['x-goog-api-key'] = apiKey;

      const response = await fetch(targetUrl, { method: 'POST', headers, body: bodyBuffer });
      res.status(response.status);

      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } else {
        res.end();
      }
      return;
    }

    // 普通非 Chat 请求退回标准透传
    if (targetPath.startsWith('/v1/')) {
      targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
    } else if (!targetPath.startsWith('/v1beta/')) {
      targetPath = '/v1beta/openai' + targetPath;
    }

    const targetUrl = `https://generativelanguage.googleapis.com${targetPath}${url.search}`;
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuffer : undefined,
    });

    res.status(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      res.end();
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
