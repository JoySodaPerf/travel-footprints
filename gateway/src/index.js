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
      return fetch('https://travel-footprints.pages.dev' + url.pathname + url.search, request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
