export const config = {
  runtime: 'edge',
};

export default async function handler(request) {
  // 1. 处理 CORS 预检
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

  // 2. 提取真实 URL
  const url = new URL(request.url);
  let targetPath = url.pathname;

  // 3. 根目录探针
  if (targetPath === '/' || targetPath === '') {
    return new Response(JSON.stringify({ status: "ok", message: "Gemini Vercel Proxy is active!" }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // 4. 智能路径转换
  if (targetPath.startsWith('/v1/')) {
    targetPath = targetPath.replace('/v1/', '/v1beta/openai/');
  } else if (targetPath === '/v1') {
    targetPath = '/v1beta/openai/';
  } else if (!targetPath.startsWith('/v1beta/')) {
    targetPath = '/v1beta/openai' + targetPath;
  }

  const targetUrl = new URL(`https://generativelanguage.googleapis.com${targetPath}${url.search}`);
  const reqHeaders = new Headers(request.headers);
  reqHeaders.set('host', 'generativelanguage.googleapis.com');

  try {
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
