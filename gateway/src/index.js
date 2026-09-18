/**
 * app.soda-perf.com 多应用网关：
 * /travel/mount-tai/* -> 泰山打卡 PWA（Cloudflare Pages: travel-footprints）
 * 其余路径由 Zone Routes 之外的默认目标处理（根路径不指向任何应用）
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 无尾斜杠入口 -> 301 规范化，避免相对路径解析错位
    if (url.pathname === '/travel/mount-tai') {
      return Response.redirect(new URL('/travel/mount-tai/', url.origin), 301);
    }

    // 子路径完整透传到 Pages 项目（应用物理部署于其 /travel/mount-tai/ 下）
    if (url.pathname.startsWith('/travel/mount-tai/')) {
      return proxyToPages(request, url);
    }

    return new Response('Not Found', { status: 404 });
  }
};

async function proxyToPages(request, url) {
  const target = 'https://travel-footprints.pages.dev' + url.pathname + url.search;
  // redirect: 'follow' —— 必须跟随源站 308（如 /index.html -> /），
  // 否则 Service Worker 预缓存 addAll 会因 308 非 2xx 而失败，导致 SW 永远无法更新
  const proxied = new Request(target, {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'follow'
  });
  return fetch(proxied);
}
