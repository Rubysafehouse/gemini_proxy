export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  // 1. 处理 CORS 预检 (OPTIONS)
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  const reqUrl = new URL(request.url);
  // 🎯 精准获取客户端原始请求路径 (解决 Vercel 路由转换导致的 404)
  let originalPath = reqUrl.searchParams.get('url') || reqUrl.pathname;
  reqUrl.searchParams.delete('url');

  // 2. 根目录保活探针
  if (originalPath === '/' || originalPath === '' || originalPath === '/api/proxy') {
    return new Response(JSON.stringify({ status: "ok", message: "Gemini Proxy is running!" }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 3. 智能路径映射：将 /v1/ 自动替换为 Google 官方 OpenAI 路径
  let targetPath = originalPath;
  if (targetPath.startsWith('/v1/')) {
    targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
  } else if (targetPath === '/v1') {
    targetPath = '/v1beta/openai/';
  } else if (!targetPath.startsWith('/v1beta/')) {
    targetPath = '/v1beta/openai' + targetPath;
  }

  const targetUrl = new URL(`https://generativelanguage.googleapis.com${targetPath}`);
  reqUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  // 4. Headers 转发
  const reqHeaders = new Headers(request.headers);
  reqHeaders.set('host', 'generativelanguage.googleapis.com');

  try {
    // 5. 纯字节流透明转发 (原生支持打字机 SSE 和 MCP 工具)
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow'
    });

    const resHeaders = new Headers(response.headers);
    resHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
