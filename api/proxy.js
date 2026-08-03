export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

const signatureCache = new Map();

// 🎯 全量关停安全过滤器 (Block None)
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
    return res.status(200).json({ status: "ok", message: "Gemini Safety-Disabled Proxy Active!" });
  }

  if (targetPath.startsWith('/v1/chat/') || targetPath.startsWith('/v1/embeddings')) {
    targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
  } else if (targetPath === '/v1/models') {
    targetPath = '/v1beta/openai/models';
  } else if (!targetPath.startsWith('/v1beta/')) {
    targetPath = '/v1beta/openai' + targetPath;
  }

  const targetUrl = `https://generativelanguage.googleapis.com${targetPath}${url.search}`;

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    let bodyBuffer = Buffer.concat(chunks);

    // 🎯 核心逻辑：拦截请求体，强行注入 BLOCK_NONE 与 签名缝合
    if (req.method === 'POST' && bodyBuffer.length > 0) {
      try {
        let bodyJson = JSON.parse(bodyBuffer.toString('utf-8'));

        // 1. 强行注入 Safety Settings 为 BLOCK_NONE
        bodyJson.safetySettings = BLOCK_NONE_SAFETY_SETTINGS;
        bodyJson.safety_settings = BLOCK_NONE_SAFETY_SETTINGS;

        // 2. 自动缝合 thought_signature (保证 MCP 顺畅)
        if (bodyJson.messages && Array.isArray(bodyJson.messages)) {
          bodyJson.messages.forEach((msg) => {
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
              msg.tool_calls.forEach((tc) => {
                const cachedSig = signatureCache.get(tc.id);
                if (!tc.extra_content) tc.extra_content = {};
                if (!tc.extra_content.google) tc.extra_content.google = {};

                if (cachedSig) {
                  tc.extra_content.google.thought_signature = cachedSig;
                } else if (!tc.extra_content.google.thought_signature) {
                  tc.extra_content.google.thought_signature = "skip_thought_signature_validator";
                }
              });
            }
          });
        }

        bodyBuffer = Buffer.from(JSON.stringify(bodyJson), 'utf-8');
      } catch (e) {
        // 非 JSON 请求跳过
      }
    }

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];

    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuffer : undefined,
    });

    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
        res.setHeader(key, value);
      }
    });

    res.status(response.status);

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bufferStr = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        res.write(value);

        bufferStr += decoder.decode(value, { stream: true });
        const lines = bufferStr.split('\n');
        bufferStr = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const json = JSON.parse(line.slice(6));
              const choices = json.choices || [];
              for (const choice of choices) {
                const delta = choice.delta || {};
                if (delta.tool_calls) {
                  delta.tool_calls.forEach((tc) => {
                    const sig = tc.extra_content?.google?.thought_signature;
                    if (tc.id && sig) {
                      signatureCache.set(tc.id, sig);
                    }
                  });
                }
              }
            } catch (e) {
              // 忽略
            }
          }
        }
      }
      res.end();
    } else {
      res.end();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
