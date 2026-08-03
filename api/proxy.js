export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

const signatureCache = new Map();

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
    return res.status(200).json({ status: "ok", message: "Gemini OpenAI-Transpiled Proxy with BLOCK_NONE Active!" });
  }

  // 🎯 判断是否为 OpenAI 聊天请求
  const isOpenAIChat = targetPath.startsWith('/v1/chat/completions');

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    let bodyBuffer = Buffer.concat(chunks);

    let targetUrl = '';

    if (isOpenAIChat && req.method === 'POST') {
      // 🚀 核心逻辑：将 OpenAI 请求桥接到 Gemini 原生 API 以注入 BLOCK_NONE
      const openaiJson = JSON.parse(bodyBuffer.toString('utf-8'));
      const model = openaiJson.model || 'gemini-2.5-flash';

      // 提取 API Key (优先从 Authorization Header 获取)
      let apiKey = '';
      const authHeader = req.headers['authorization'] || '';
      if (authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.substring(7);
      }

      targetUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

      // 1. 转换 Messages 为 Gemini contents & systemInstruction
      let systemInstruction = undefined;
      const contents = [];

      (openaiJson.messages || []).forEach(msg => {
        if (msg.role === 'system') {
          systemInstruction = { parts: [{ text: msg.content || '' }] };
        } else if (msg.role === 'user') {
          contents.push({ role: 'user', parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }] });
        } else if (msg.role === 'assistant') {
          const parts = [];
          if (msg.content) parts.push({ text: msg.content });
          if (msg.tool_calls) {
            msg.tool_calls.forEach(tc => {
              const cachedSig = signatureCache.get(tc.id);
              parts.push({
                functionCall: {
                  name: tc.function?.name,
                  args: JSON.parse(tc.function?.arguments || '{}'),
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

      // 2. 构建包含 BLOCK_NONE 的原生 Gemini Payload
      const nativePayload = {
        contents: contents,
        systemInstruction: systemInstruction,
        safetySettings: BLOCK_NONE_SAFETY_SETTINGS,
        generationConfig: {
          temperature: openaiJson.temperature,
          topP: openaiJson.top_p,
          maxOutputTokens: openaiJson.max_tokens
        }
      };

      bodyBuffer = Buffer.from(JSON.stringify(nativePayload), 'utf-8');

    } else {
      // 普通非 Chat 请求，正常走兼容映射
      if (targetPath.startsWith('/v1/')) {
        targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
      } else if (!targetPath.startsWith('/v1beta/')) {
        targetPath = '/v1beta/openai' + targetPath;
      }
      targetUrl = `https://generativelanguage.googleapis.com${targetPath}${url.search}`;
    }

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];
    headers['content-type'] = 'application/json';

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuffer : undefined,
    });

    res.status(response.status);

    // 3. 透传输出数据流
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
