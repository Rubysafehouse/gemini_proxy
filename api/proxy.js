// 声明使用 Vercel Edge 运行时，保证原生 SSE 流式输出和零拷贝传输
export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  // 1. 动态处理 CORS 预检（解决 Kelivo 跨域问题）
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

  // 2. 智能路径映射：兼容 /v1 和 /v1/ 两种情况，防止触发 308 重定向
  if (targetPath.startsWith('/v1/') || targetPath === '/v1') {
    targetPath = '/v1beta/openai' + targetPath.substring('/v1'.length);
  } else if (!targetPath.startsWith('/v1beta/')) {
    targetPath = '/v1beta/openai' + targetPath;
  }

  const targetUrl = new URL(`https://generativelanguage.googleapis.com${targetPath}${url.search}`);

  // 3. 构造请求 Header（透传所有请求头，只修改 Host）
  const reqHeaders = new Headers(request.headers);
  reqHeaders.set('host', 'generativelanguage.googleapis.com');

  try {
    // 4. 纯字节流转发（不破坏 JSON，完美支持 MCP 和流式打字机）
    const response = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body: request.body, 
      redirect: 'follow'
    });

    // 5. 注入 CORS 跨域响应头后返回给 Kelivo
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
