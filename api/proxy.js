export const config = {
  api: {
    bodyParser: false, // 禁用默认解析，保证 100% 原始字节流，绝对不损坏数据
  },
  maxDuration: 60, // 强制将超时时间提升至免费版最高上限 60 秒，杜绝 504
};

export default async function handler(req, res) {
  // 1. 处理 CORS 预检跨域
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    return res.status(204).end();
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  let targetPath = url.pathname;

  // 根目录探针
  if (targetPath === '/' || targetPath === '') {
    return res.status(200).json({ status: "ok", message: "Gemini Node Proxy is running with 60s timeout!" });
  }

  // 智能路径映射 (同时兼容 Native 和 OpenAI)
  if (targetPath.startsWith('/v1/')) {
    targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
  } else if (targetPath === '/v1') {
    targetPath = '/v1beta/openai/';
  } else if (!targetPath.startsWith('/v1beta/')) {
    targetPath = '/v1beta/openai' + targetPath;
  }

  const targetUrl = `https://generativelanguage.googleapis.com${targetPath}${url.search}`;

  try {
    // 2. 提取最原始的二进制请求体
    let bodyBuffer = [];
    for await (const chunk of req) {
      bodyBuffer.push(chunk);
    }
    const rawBody = Buffer.concat(bodyBuffer);

    // 3. 发送请求至 Google (携带原生鉴权 Header)
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'Authorization': req.headers['authorization'] || '',
        'x-goog-api-key': req.headers['x-goog-api-key'] || '',
      },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? rawBody : undefined,
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // 过滤掉可能引起冲突的 Node.js 内部 Header
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== 'content-encoding' && key.toLowerCase() !== 'transfer-encoding') {
        res.setHeader(key, value);
      }
    });

    res.status(response.status);

    // 4. 完美兼容 SSE 打字机流式输出
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else {
      res.send(await response.text());
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
