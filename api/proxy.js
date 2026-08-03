export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  // 1. 动态处理 CORS 预检 (OPTIONS)
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

  // 2. 根目录保活 (解决 Vercel 根目录 404 报错，让你访问域名时看到成功状态)
  if (targetPath === '/' || targetPath === '') {
    return new Response(JSON.stringify({ status: "ok", message: "Gemini Vercel Proxy is active!" }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 3. 智能路径映射：将 /v1/ 自动转为 Google 官方 OpenAI 路径
  if (targetPath.startsWith('/v1/')) {
    targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
  } else if (targetPath === '/v1') {
    targetPath = '/v1beta/openai/';
  } else if (!targetPath.startsWith('/v1beta/')) {
    targetPath = '/v1beta/openai' + targetPath;
  }

  const targetUrl = new URL(`https://generativelanguage.googleapis.com${targetPath}${url.search}`);

  // 4. 构造请求 Headers
  const reqHeaders = new Headers(request.headers);
  reqHeaders.set('host', 'generativelanguage.googleapis.com');

  try {
    // 5. 纯字节流透明转发给 Google
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
