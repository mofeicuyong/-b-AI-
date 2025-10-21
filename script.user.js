// ==UserScript==
// @name         B站AI字幕抓取
// @namespace    https://your.namespace.example
// @version      1.3.0
// @description  同时注入顶层与播放器iframe；拦截 ai_subtitle 的 fetch/XMLHttpRequest；子帧通过 postMessage 上报，面板只在顶层显示；导出 SRT/JSON/TXT。
// @author       you
// @match        *://www.bilibili.com/*
// @match        *://player.bilibili.com/*
// @match        *://www.bilibili.com/blackboard/html5player.html*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_download
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';
  const TAG = '[AI-Subtitle]';
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ====== 公用工具 ======
  const isTop = window.top === window;
  const isAISub = (url) => /ai_subtitle/i.test(url);
  const safe = (s) => (s || 'subtitle').replace(/[\/\\?%*:|"<> ]+/g, '_').slice(0, 120);
  const pad2 = (n) => String(Math.floor(n)).padStart(2, '0');
  const srtTime = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec - Math.floor(sec)) * 1000);
    return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`;
  };
  const toSRT = (j) => {
    if (!j || !Array.isArray(j.body)) return '';
    const out = [];
    j.body.forEach((seg, i) => {
      out.push(String(i + 1));
      out.push(`${srtTime(seg.from || 0)} --> ${srtTime(seg.to || 0)}`);
      out.push(String(seg.content ?? '').replace(/\r?\n/g, ' ').trim() || ' ');
      out.push('');
    });
    return out.join('\n');
  };
  // NEW: 导出纯文本（逐段合并为行，保留顺序，不含时间戳）
  const toTXT = (j) => {
    if (!j || !Array.isArray(j.body)) return '';
    return j.body
      .map(seg => String(seg.content ?? '').replace(/\r?\n/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  };

  const getTitle = () =>
    (document.title || 'bilibili_video').replace(/_?(_?哔哩哔哩.*)$/g, '').trim() || 'bilibili_video';
  const downloadBlob = (blob, filename) => {
    try {
      if (typeof GM_download === 'function') {
        const url = URL.createObjectURL(blob);
        GM_download({
          url, name: filename, saveAs: true,
          onload: () => URL.revokeObjectURL(url),
          onerror: () => URL.revokeObjectURL(url),
          ontimeout: () => URL.revokeObjectURL(url),
        });
      } else {
        const a = document.createElement('a');
        const url = URL.createObjectURL(blob);
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      }
    } catch (e) { warn('download error', e); }
  };

  // ====== 顶层：存储 + 面板 ======
  const store = isTop ? new Map() : null; // key -> {meta, data}
  const order = isTop ? [] : null;
  let lastKey = null;

  const makeKey = (url, data) => `${data?.lang || 'unk'} | ${data?.version || 'v?'} | ${String(url).slice(-24)}`;

  const receiveCaptureAtTop = (url, data, sourceHint) => {
    try {
      if (!isTop || !data || !Array.isArray(data.body)) return;
      const key = makeKey(url, data);
      if (!store.has(key)) order.push(key);
      store.set(key, { meta: { url, time: Date.now(), source: sourceHint || 'unknown' }, data });
      lastKey = key;
      log('captured@top', key, 'segments:', data.body.length, 'from:', sourceHint);
      refreshPanel();
    } catch (e) { warn('receiveCaptureAtTop error', e); }
  };

  // 顶层面板
  const PID = 'ai-subtitle-panel', LID = 'ai-subtitle-list';
  function ensurePanel() {
    if (!isTop) return;
    if (document.getElementById(PID)) return;
    GM_addStyle(`
      #${PID}{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:340px;background:rgba(20,20,20,.92);color:#fff;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.35);font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,sans-serif;overflow:hidden}
      #${PID} header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#2d2f33;font-weight:600}
      #${PID} header button{border:none;border-radius:8px;background:#00AEEC;color:#fff;padding:6px 10px;cursor:pointer;font-size:12px;margin-left:6px}
      #${PID} .content{max-height:360px;overflow:auto;padding:8px}
      #${LID}{display:grid;gap:8px}
      #${LID} .item{background:#1f2125;border:1px solid rgba(255,255,255,.06);border-radius:8px;padding:8px}
      #${LID} .meta{font-size:12px;color:#cbd5e1;word-break:break-all}
      #${LID} .actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
      #${LID} button{border:none;border-radius:8px;background:#00AEEC;color:#fff;padding:6px 10px;cursor:pointer;font-size:12px}
      #${LID} button.secondary{background:#4b5563}
      #${PID} .hint{color:#9ca3af;font-size:12px;padding:6px 8px 10px}
      #${PID} .foot{display:flex;justify-content:space-between;align-items:center;padding:8px;border-top:1px solid rgba(255,255,255,.06);color:#9ca3af}
    `);
    const el = document.createElement('div');
    el.id = PID;
    el.innerHTML = `
      <header>
        <div>AI字幕捕获</div>
        <div>
          <button id="as-copy-txt">复制最新TXT</button>
          <button id="as-copy">复制最新JSON</button>
          <button id="as-clear" style="background:#4b5563">清空</button>
        </div>
      </header>
      <div class="content">
        <div id="${LID}"></div>
        <div class="hint">提示：字幕请求通常在播放器 iframe 里发出；本面板聚合所有子帧的捕获。</div>
      </div>
      <div class="foot">已捕获：<b id="as-count">0</b> 条</div>
    `;
    (document.body || document.documentElement).appendChild(el);
    el.querySelector('#as-copy')?.addEventListener('click', () => {
      if (!lastKey || !store.has(lastKey)) return alert('暂未捕获字幕。');
      try { GM_setClipboard(JSON.stringify(store.get(lastKey).data, null, 2)); alert('已复制最新轨道 JSON'); }
      catch { alert('复制失败'); }
    });
    el.querySelector('#as-copy-txt')?.addEventListener('click', () => {
      if (!lastKey || !store.has(lastKey)) return alert('暂未捕获字幕。');
      try {
        const txt = toTXT(store.get(lastKey).data);
        GM_setClipboard(txt);
        alert('已复制最新轨道 TXT');
      } catch { alert('复制失败'); }
    });
    el.querySelector('#as-clear')?.addEventListener('click', () => {
      store.clear(); order.length = 0; lastKey = null; refreshPanel();
    });
    log('panel mounted (top)');
  }
  function refreshPanel() {
    if (!isTop) return;
    ensurePanel();
    const list = document.getElementById(LID);
    const cnt = document.getElementById('as-count');
    if (!list || !cnt) return;
    list.innerHTML = '';
    order.forEach((k, idx) => {
      const e = store.get(k); if (!e) return;
      const { meta, data } = e;
      const div = document.createElement('div');
      div.className = 'item';
      const segs = Array.isArray(data.body) ? data.body.length : 0;
      div.innerHTML = `
        <div class="meta">
          <div><b>#${idx + 1}</b> 语言: <b>${data.lang || 'unk'}</b>　版本: <b>${data.version || 'v?'}</b>　片段数: ${segs}</div>
          <div>源: ${meta.url}</div>
          <div>来自: ${meta.source}</div>
        </div>
        <div class="actions">
          <button data-k="${k}" data-act="srt">下载 SRT</button>
          <button data-k="${k}" data-act="json" class="secondary">下载 JSON</button>
          <button data-k="${k}" data-act="txt" class="secondary">下载 TXT</button>
          <button data-k="${k}" data-act="preview" class="secondary">预览5条</button>
          <button data-k="${k}" data-act="set" class="secondary">设为最新</button>
        </div>
      `;
      list.appendChild(div);
    });
    cnt.textContent = String(order.length);
    list.querySelectorAll('button').forEach(btn => {
      btn.onclick = () => {
        const k = btn.getAttribute('data-k');
        const act = btn.getAttribute('data-act');
        const e = store.get(k); if (!e) return;
        const title = safe(getTitle());
        if (act === 'srt') {
          const blob = new Blob([toSRT(e.data)], { type: 'text/plain;charset=utf-8' });
          downloadBlob(blob, `${title}.${(e.data.lang || 'unk')}.srt`);
        } else if (act === 'json') {
          const blob = new Blob([JSON.stringify(e.data, null, 2)], { type: 'application/json;charset=utf-8' });
          downloadBlob(blob, `${title}.${(e.data.lang || 'unk')}.json`);
        } else if (act === 'txt') { // NEW
          const blob = new Blob([toTXT(e.data)], { type: 'text/plain;charset=utf-8' });
          downloadBlob(blob, `${title}.${(e.data.lang || 'unk')}.txt`);
        } else if (act === 'preview') {
          const a = e.data.body || [];
          alert(a.slice(0, 5).map((s, i) => `#${i + 1} [${srtTime(s.from)}→${srtTime(s.to)}] ${s.content}`).join('\n') || '无');
        } else if (act === 'set') {
          lastKey = k; alert('已设为最新轨道');
        }
      };
    });
  }
  if (isTop) {
    // 顶层接收子帧上报
    window.addEventListener('message', (ev) => {
      try {
        const msg = ev.data;
        if (!msg || msg.__ai_sub__ !== true) return;
        receiveCaptureAtTop(msg.url, msg.payload, (ev.origin || 'frame'));
      } catch {}
    });
    // 面板兜底确保显示
    ensurePanel();
    document.addEventListener('DOMContentLoaded', ensurePanel);
    const iv = setInterval(() => {
      if (document.getElementById(PID)) return clearInterval(iv);
      ensurePanel();
    }, 600);
  }

  // ====== 所有 frame：拦截 fetch + XHR，顶层直接入库；子帧 postMessage 上报 ======
  function reportCapture(url, jsonObj) {
    if (isTop) {
      receiveCaptureAtTop(url, jsonObj, 'top');
    } else {
      try {
        window.top.postMessage({ __ai_sub__: true, url, payload: jsonObj }, '*');
      } catch (e) {
        // 某些情况下 top 被 CSP 限制，退化本帧自存（无面板）
        log('postMessage failed, frame-local only');
      }
    }
  }

  function tryParseAndReport(url, txt) {
    try {
      const j = JSON.parse(txt);
      if (j && j.body) reportCapture(url, j);
    } catch {
      const m = txt && txt.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          const j2 = JSON.parse(m[0]);
          if (j2 && j2.body) reportCapture(url, j2);
        } catch {}
      }
    }
  }

  // hook fetch
  const _fetch = window.fetch;
  if (typeof _fetch === 'function') {
    window.fetch = function (...args) {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req && req.url) || '';
      const watch = isAISub(url);
      const p = _fetch.apply(this, args);
      if (watch) {
        p.then((r) => {
          try { r.clone().text().then((txt) => tryParseAndReport(url, txt)).catch(() => {}); } catch {}
        }).catch(() => {});
      }
      return p;
    };
  }

  // hook XHR
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    try { this.__ai_url__ = url; } catch {}
    return _open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      this.addEventListener('readystatechange', function () {
        try {
          if (this.readyState === 4 && this.status >= 200 && this.status < 300) {
            const url = this.__ai_url__ || '';
            if (isAISub(url)) {
              const txt = this.responseText || '';
              tryParseAndReport(url, txt);
            }
          }
        } catch {}
      });
    } catch {}
    return _send.apply(this, args);
  };

  log('script loaded. top?', isTop, 'url:', location.href);
})();
