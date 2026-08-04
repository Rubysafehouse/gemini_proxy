export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

// 内存签名存储 (以 tool_call_id 或 index 为 key)
const signatureCache = new Map();

// 全局指针（在 Vercel 函数实例存活期间持续轮转）
let currentKeyIndex = 0;

// 从环境变量读取 API Key 列表 (支持逗号分隔多个 Key)
function getApiKeys() {
  const keysStr = process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return keysStr.split(',').map(k => k.trim()).filter(Boolean);
}

// 获取下一个 Key
function getNextApiKey(keys) {
  if (!keys || keys.length === 0) return null;
  const key = keys[currentKeyIndex % keys.length];
  currentKeyIndex = (currentKeyIndex + 1) % keys.length;
  return key;
}

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
    return res.status(200).json({ status: "ok", message: "Gemini Key-Rotating Proxy Active!" });
  }

  if (targetPath.startsWith('/v1/chat/') || targetPath.startsWith('/v1/embeddings')) {
    targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
  } else if (targetPath === '/v1/models') {
    targetPath = '/v1beta/openai/models';
  } else if (!targetPath.startsWith('/v1beta/')) {
    targetPath = '/v1beta/openai' + targetPath;
  }

  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    let bodyBuffer = Buffer.concat(chunks);

    // 🎯 入站拦截：检测历史记录，自动缝合 thought_signature
    if (req.method === 'POST' && bodyBuffer.length > 0) {
      try {
        let bodyJson = JSON.parse(bodyBuffer.toString('utf-8'));

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
        // 非 JSON 不处理
      }
    }

    // 🎯 解析可用的 API Key 列表
    const envKeys = getApiKeys();
    let clientKey = '';
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      clientKey = authHeader.substring(7).trim();
    } else if (url.searchParams.has('key')) {
      clientKey = url.searchParams.get('key');
    }

    const keysToTry = envKeys.length > 0 ? envKeys : (clientKey ? [clientKey] : []);

    if (keysToTry.length === 0) {
      return res.status(401).json({ error: "No Gemini API Key found in env or request." });
    }

    let response = null;
    let attempts = 0;
    const maxAttempts = keysToTry.length;

    // 🎯 轮转与限额重试循环 (Failover)
    while (attempts < maxAttempts) {
      attempts++;
      const activeKey = getNextApiKey(keysToTry);

      const targetUrlObj = new URL(`https://generativelanguage.googleapis.com${targetPath}`);
      url.searchParams.forEach((val, key) => {
        if (key !== 'key') targetUrlObj.searchParams.append(key, val);
      });

      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers['content-length'];

      // 🎯 核心修复：强制注入当前轮转 Key 到 Authorization Bearer，适配 Google OpenAI 兼容层
      headers['authorization'] = `Bearer ${activeKey}`;
      headers['Authorization'] = `Bearer ${activeKey}`;
      headers['x-goog-api-key'] = activeKey;

      response = await fetch(targetUrlObj.toString(), {
        method: req.method,
        headers: headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuffer : undefined,
      });

      // 若遇到 429 (频率受限) 或 403 (配额耗尽)，且还有备用 Key，则自动换下一个 Key 重试
      if ((response.status === 429 || response.status === 403) && attempts < maxAttempts) {
        continue;
      }

      break;
    }

    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
        res.setHeader(key, value);
      }
    });

    res.status(response.status);

    // 🎯 出站拦截：如果是流式输出，捕获 Google 返回的 thought_signature 并存入内存 Cache
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
              // 忽略解析失败的 chunk
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
