export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

// 内存签名存储 (以 tool_call_id 或 index 为 key)
const signatureCache = new Map();

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
    return res.status(200).json({ status: "ok", message: "Gemini Memory-Bridged Proxy Active!" });
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

    // 🎯 入站拦截：检测客户端发来的历史记录，自动缝合之前被客户端吞掉的 thought_signature
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

                // 优先填入内存中保存的真实签名；如果内存过期则填入官方允许的跳过标识
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

    // 🎯 出站拦截：如果是流式输出，捕获 Google 返回的 thought_signature 并存入内存 Cache
    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let bufferStr = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        res.write(value);

        // 解析 SSE 字符串并记录签名
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
