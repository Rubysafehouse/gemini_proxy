export const config = {
  api: {
    bodyParser: false, // 禁用默认解析，保证 100% 原始字节流
  },
  maxDuration: 60, // 强制将超时提升至最高 60 秒
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

  if (targetPath.startsWith('/api/proxy')) {
    targetPath = targetPath.replace('/api/proxy', '');
  }

  // 根目录探针
  if (targetPath === '/' || targetPath === '') {
    return res.status(200).json({ status: "ok", message: "Gemini 60s Proxy is active!" });
  }

  // 3. 智能路径兼容
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
    let body = Buffer.concat(chunks);

    // ==========================================
    // 🔥 核心补丁：强行注入 thought_signature 屏蔽 Google 400 报错
    // ==========================================
    try {
      if (body.length > 0) {
        // 暂时解析成 JSON 对象
        const parsedBody = JSON.parse(body.toString('utf-8'));
        let modified = false;

        // 遍历历史消息，查找缺失签名的 assistant 工具调用
        if (parsedBody.messages && Array.isArray(parsedBody.messages)) {
          for (const msg of parsedBody.messages) {
            if (msg.role === 'assistant' && (msg.tool_calls || msg.function_call)) {
              if (!msg.thought_signature) {
                // 生成一个随机唯一的签名
                msg.thought_signature = `sig_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
                modified = true;
              }
            }
          }
        }

        // 如果发生了修改，重新序列化为二进制 Buffer，并更新 Content-Length
        if (modified) {
          body = Buffer.from(JSON.stringify(parsedBody), 'utf-8');
          // 因为内容长度变了，所以必须删除 Content-Length，交给底层自动计算
          delete req.headers['content-length'];
        }
      }
    } catch (parseError) {
      // 如果非 JSON 请求（极少数情况），直接忽略补丁，保持原样转发
      console.error("⚠️ thought_signature 补丁跳过 (非 JSON 体):", parseError.message);
    }
    // ==========================================

    // 5. 转发 Header 清理
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    // 注意：如果上面修改了 body，必须要删掉 content-length，否则会导致 Google 接收数据不全

    // 6. 发送至 Google 官方 API (这里发送修改后的 body)
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
