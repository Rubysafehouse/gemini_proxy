export const config = {
  api: {
    bodyParser: false, // 禁用默认解析，手动接管 Buffer
  },
  maxDuration: 60, // 60 秒超时上限
};

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
    return res.status(200).json({ status: "ok", message: "Gemini Auto-Bypass Proxy is Active!" });
  }

  // 映射 OpenAI 路径到 Google 官方 OpenAI 兼容入口
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

    // 🎯 核心黑科技：拦截并注入 Google 官方跳过签名的标记
    if (req.method === 'POST' && bodyBuffer.length > 0) {
      try {
        let bodyJson = JSON.parse(bodyBuffer.toString('utf-8'));

        // 递归扫描 JSON 数据包，给所有的 functionCall / tool_calls 自动补齐跳过校验标记
        const patchThoughtSignature = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            obj.forEach(patchThoughtSignature);
            return;
          }
          // 如果发现了函数调用/工具调用节点
          if (obj.functionCall || obj.function_call) {
            const targetObj = obj.functionCall || obj.function_call;
            if (!targetObj.thought_signature) {
              targetObj.thought_signature = "skip_thought_signature_validator";
            }
          }
          Object.values(obj).forEach(patchThoughtSignature);
        };

        patchThoughtSignature(bodyJson);
        bodyBuffer = Buffer.from(JSON.stringify(bodyJson), 'utf-8');
      } catch (e) {
        // 如果不是标准 JSON 请求则跳过修正
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
