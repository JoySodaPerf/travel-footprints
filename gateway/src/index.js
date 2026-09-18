/**
 * app.soda-perf.com 多应用网关：
 * /travel/mount-tai/* -> 泰山打卡 PWA（Cloudflare Pages: travel-footprints）
 * 其余路径由 Zone Routes 之外的默认目标处理（根路径不指向任何应用）
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/travel/mount-tai' || url.pathname.startsWith('/travel/mount-tai')) {
      return proxyToPages(request, url);
    }
    return new Response('Not Found', { status: 404 });
  }
};

async function proxyToPages(request, url) {
  const target = new URL('https://travel-footprints.pages.dev');
  target.pathname = url.pathname.replace(/^\/travel\/mount-tai/, '') || '/';
  target.search = url.search;
  return fetch(target, request);
}
