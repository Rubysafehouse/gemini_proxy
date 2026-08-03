export const config = {
  api: {
    bodyParser: false, // 禁用默认解析，保证 100% 原始字节流，绝不损坏 MCP 参数
  },
  maxDuration: 60, // 强制将超时提升至最高 60 秒，彻底解决 504 TIMEOUT
};

export default async function handler(req, res) {
  // 1. 设置跨域 Header
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // 2. 提取原始请求路径
  let targetPath = req.url || '/';

  // 防止内部路径冲突
  if (targetPath.startsWith('/api/proxy')) {
    targetPath = targetPath.replace('/api/proxy', '');
  }

  // 根目录探针
  if (targetPath === '/' || targetPath === '') {
    return res.status(200).json({ status: "ok", message: "Gemini 60s Proxy is active!" });
  }

  // 3. 智能路径兼容 (支持 OpenAI 模式 与 Gemini 原生模式)
  if (targetPath.startsWith('/v1/')) {
    targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
  } else if (targetPath === '/v1') {
    targetPath = '/v1beta/openai/';
  } else if (!targetPath.startsWith('/v1beta/')) {
    targetPath = '/v1beta/openai' + targetPath;
  }

  const targetUrl = `https://generativelanguage.googleapis.com${targetPath}`;

  try {
    // 4. 读取原始二进制 Request Body
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    // 5. 转发 Header 清理
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers['content-length'];

    // 6. 发送至 Google 官方 API
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
    });

    // 7. 透传 Response Headers
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'content-length') {
        res.setHeader(key, value);
      }
    });

    res.status(response.status);

    // 8. 原生 SSE 流式打字机响应输出
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
