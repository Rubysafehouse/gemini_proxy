// 🎯 声明使用 Vercel Edge 运行时（保证原生 SSE 流式输出与 zero-copy 传输）
export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  // 1. 动态处理 CORS 预检 (OPTIONS)，支持任意自定义 Header
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

  const url = new URL(request.url);
  let targetPath = url.pathname;

  // 2. 路径映射：/v1/ -> /v1beta/openai/
  if (targetPath.startsWith('/v1/')) {
    targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
  } else if (!targetPath.startsWith('/v1beta/')) {
    targetPath = '/v1beta/openai' + targetPath;
  }

  const targetUrl = new URL(`https://generativelanguage.googleapis.com${targetPath}${url.search}`);

  // 3. 构造请求 Header
  const reqHeaders = new Headers(request.headers);
  reqHeaders.set('host', 'generativelanguage.googleapis.com');

  try {
    // 4. 纯字节流转发 (request.body 原样传递，绝不动内容，支持流式和 MCP)
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body: request.body,
      redirect: 'follow'
    });

    // 5. 注入 CORS 响应头返回给 Kelivo
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
