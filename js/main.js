/* ============================================================
 * main.js —— 启动入口
 * ============================================================ */
window.addEventListener('DOMContentLoaded', () => {
  const engine = new EngineNS.AudioEngine();
  const viz = new Visualizer(
    {
      spectrum: document.getElementById('canvas-spectrum'),
      wave: document.getElementById('canvas-wave'),
      spectrogram: document.getElementById('canvas-spectrogram'),
      analysis: document.getElementById('canvas-analysis'),
    },
    engine
  );
  const app = { engine, viz };
  window.app = app;   // 控制台调试入口：app.engine / app.viz
  UI.init(app);

  const tick = () => { viz.frame(); UI.updateMeters(); };
  const loop = () => { if (!document.hidden) tick(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  // 页面切到后台时 rAF 会暂停，但音频还在跑 —— 降频兜底刷新读数
  setInterval(() => { if (document.hidden) tick(); }, 120);

  // 心跳仅用于本地 Python 服务器。静态托管版没有 /api 路由。
  if (location.origin === 'http://127.0.0.1:8765' || location.origin === 'http://localhost:8765') {
    const beat = () => fetch('/api/heartbeat', { method: 'POST', keepalive: true }).catch(() => {});
    beat();
    setInterval(beat, 2000);
    window.addEventListener('pagehide', () => {
      if (navigator.sendBeacon) navigator.sendBeacon('/api/bye');
    });
  }
});
