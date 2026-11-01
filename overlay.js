// 页面内的浮动侧栏（内容脚本）。
//
// 外形：离窗口边缘 GAP 的磨砂玻璃面板。
//   - 图标收起（icon-rail）：常态是 52px 的图标胶囊，网页让出 PUSH_RAIL。
//   - 完全隐藏（full-hide）：常态移出屏幕，鼠标停在屏幕边缘时浮出。
//
// 展开分两种：
//   - 预览（peek）：鼠标在胶囊上停留 / 停在屏幕边缘后浮出，盖在网页上；鼠标离开一小段时间后自动收起。
//   - 固定（pinned）：点展开按钮、工具栏图标或快捷键打开；不会自动收起，并把网页推开 PUSH_PINNED。
//     固定状态存在 storage.local，所有标签页一致。
//
// 侧栏 iframe 跑在单独的进程里，宿主页面收不到 iframe 里的鼠标事件，
// 所以 iframe 自己把「鼠标进出、菜单开关、输入框聚焦、拖拽」通过 postMessage 告诉这里。
(function () {
  if (window.top !== window) return;
  if (window.__arcSidebarOverlayController) {
    window.__arcSidebarOverlayController.recheck();
    return;
  }

  const HOST_ID = 'arc-sidebar-overlay-host-v3';
  const PAGE_STYLE_ID = 'arc-sidebar-page-push-v3';
  /** 旧版本留在页面里的元素（扩展重新加载后，旧内容脚本已失效，但它的 DOM 还在） */
  const LEGACY_IDS = ['arc-sidebar-overlay-host', 'arc-sidebar-overlay-host-v2', 'arc-sidebar-page-push', 'arc-sidebar-page-push-v2'];

  const RAIL = 52; // 图标胶囊宽度
  const EXPANDED = 300; // 展开面板宽度
  const GAP = 8; // 面板离窗口边缘的距离
  const PUSH_RAIL = RAIL + GAP * 2; // 胶囊常驻时网页让出的宽度
  const PUSH_PINNED = EXPANDED + GAP * 2; // 固定展开时网页让出的宽度

  const HOVER_DELAY_RAIL = 280; // 在胶囊上停留多久才展开：快速划过不触发
  const HOVER_DELAY_EDGE = 110; // 完全隐藏模式下停在屏幕边缘多久浮出
  const LEAVE_GRACE = 350; // 鼠标离开后的缓冲：短暂划出再回来不会收起

  const MODE_KEY = 'ui.collapseMode';
  const SIDE_KEY = 'ui.sidebarSide';
  const HOVER_KEY = 'ui.hoverExpand';
  const PIN_KEY = 'ui.pinned';

  const st = {
    enabled: false,
    mode: 'icon-rail',
    side: 'left',
    hoverExpand: true,
    pinned: false,
    peek: false,
    hoverDock: false, // 宿主页面看到的鼠标在面板上（同进程时才有）
    hoverFrame: false, // iframe 报告的鼠标在面板里
    hoverEdge: false,
    hold: { menu: false, settings: false, focus: false, drag: false },
    suppress: false, // 刚点过图标 / 刚手动收起：鼠标离开之前不再自动展开
    fullscreen: false,
  };

  let hostEl = null;
  let dock = null;
  let iframe = null;
  let edge = null;
  let openTimer = null;
  let closeTimer = null;
  let leftAt = 0; // 宿主最近一次判定「鼠标已离开面板」的时间

  const isFullHide = () => st.mode === 'full-hide';
  const isExpanded = () => st.pinned || st.peek;
  const isHovering = () => st.hoverDock || st.hoverFrame || st.hoverEdge;
  const isHolding = () => Object.values(st.hold).some(Boolean);
  const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function normalizeMode(m) {
    return m === 'full-hide' ? 'full-hide' : 'icon-rail'; // always / auto / 未知 → icon-rail
  }

  function clearOpen() {
    clearTimeout(openTimer);
    openTimer = null;
  }
  function clearClose() {
    clearTimeout(closeTimer);
    closeTimer = null;
  }

  /* ---------- 悬停意图 ---------- */

  function hoverIn({ fromEdge = false, buttons = 0 } = {}) {
    clearClose();
    if (isExpanded() || openTimer) return;
    if (buttons) return; // 按着鼠标划过（选文字、拖东西）不展开
    if (st.suppress && !fromEdge) return;
    if (!fromEdge && (isFullHide() || !st.hoverExpand)) return;
    openTimer = setTimeout(() => {
      openTimer = null;
      if (isHovering() && !isExpanded()) setPeek(true);
    }, fromEdge ? HOVER_DELAY_EDGE : HOVER_DELAY_RAIL);
  }

  function hoverOut() {
    if (isHovering()) return;
    st.suppress = false;
    clearOpen();
    scheduleClose();
  }

  function scheduleClose() {
    if (!st.peek || st.pinned || isHovering() || isHolding()) return;
    clearClose();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (!isHovering() && !isHolding()) setPeek(false);
    }, LEAVE_GRACE);
  }

  /* ---------- 状态 ---------- */

  function setPeek(on, { animate = true } = {}) {
    if (st.peek === !!on) return;
    st.peek = !!on;
    if (!on) clearClose();
    apply({ animate });
  }

  function setPinned(on) {
    st.pinned = !!on;
    if (!on) st.peek = false;
    clearOpen();
    clearClose();
    apply();
    chrome.storage.local.set({ [PIN_KEY]: st.pinned }).catch(() => {});
  }

  function collapse() {
    clearOpen();
    st.suppress = isHovering(); // 鼠标还停在面板上时，别马上又自动展开；用快捷键收起时鼠标不在这里，不用管
    if (st.pinned) setPinned(false);
    else setPeek(false);
  }

  function apply({ animate = true } = {}) {
    if (!dock) return;
    const expanded = isExpanded();
    const right = st.side === 'right';
    const noAnim = !animate || reduceMotion();
    if (noAnim) dock.classList.add('no-anim');
    hostEl.style.left = right ? 'auto' : '0';
    hostEl.style.right = right ? '0' : 'auto';
    hostEl.style.display = st.fullscreen ? 'none' : 'block';
    dock.classList.toggle('side-right', right);
    dock.classList.toggle('mode-full-hide', isFullHide());
    dock.classList.toggle('expanded', expanded);
    dock.classList.toggle('collapsed', !expanded);
    edge.classList.toggle('side-right', right);
    edge.classList.toggle('active', isFullHide());
    edge.classList.toggle('visible', isFullHide() && !expanded);
    iframe.style.pointerEvents = isFullHide() && !expanded ? 'none' : 'auto';
    updatePagePush();
    notifyFrame();
    if (noAnim) {
      requestAnimationFrame(() => requestAnimationFrame(() => dock?.classList.remove('no-anim')));
    }
  }

  function notifyFrame() {
    iframe?.contentWindow?.postMessage(
      { source: 'arc-sidebar-host', type: 'state', collapsed: !isExpanded(), pinned: st.pinned, mode: st.mode, side: st.side },
      '*',
    );
  }

  /* ---------- 网页让位 ---------- */

  function ensurePagePushStyle() {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    const rule = (side, px) => `
      html[data-arc-sidebar-offset="${side}-${px}"] {
        margin-${side}: ${px}px !important;
        margin-${side === 'left' ? 'right' : 'left'}: 0 !important;
        width: calc(100% - ${px}px) !important;
        max-width: calc(100% - ${px}px) !important;
        box-sizing: border-box !important;
      }`;
    const el = document.createElement('style');
    el.id = PAGE_STYLE_ID;
    el.textContent = [rule('left', PUSH_RAIL), rule('right', PUSH_RAIL), rule('left', PUSH_PINNED), rule('right', PUSH_PINNED)].join('\n');
    (document.head || document.documentElement).append(el);
  }

  function updatePagePush() {
    const root = document.documentElement;
    if (!root) return;
    let next = null;
    if (st.enabled && !st.fullscreen) {
      if (st.pinned) next = `${st.side}-${PUSH_PINNED}`;
      else if (!isFullHide()) next = `${st.side}-${PUSH_RAIL}`;
    }
    if (!next) {
      root.removeAttribute('data-arc-sidebar-offset');
      return;
    }
    ensurePagePushStyle();
    if (root.getAttribute('data-arc-sidebar-offset') !== next) root.setAttribute('data-arc-sidebar-offset', next);
  }

  /* ---------- DOM ---------- */

  const CSS = `
    :host { all: initial; }
    /* 玻璃外观（圆角、磨砂、阴影）画在 .dock 上，但 .dock 不裁剪内容；
       裁剪交给直角的 .clip —— 带圆角的裁剪会让 Chrome 在网页缩放后算错 iframe 的点击区域。 */
    .dock {
      position: absolute;
      top: ${GAP}px; bottom: ${GAP}px;
      left: ${GAP}px; right: auto;
      width: ${RAIL}px;
      box-sizing: border-box;
      pointer-events: auto;
      border-radius: 18px;
      background: rgba(246, 246, 249, 0.62);
      -webkit-backdrop-filter: blur(28px) saturate(1.8);
      backdrop-filter: blur(28px) saturate(1.8);
      box-shadow: 0 10px 30px -12px rgba(15, 23, 42, 0.28), 0 0 0 0.5px rgba(15, 23, 42, 0.1);
      /* 收起：标准缓动，略快 */
      transition:
        width 220ms cubic-bezier(0.4, 0, 0.2, 1),
        transform 220ms cubic-bezier(0.4, 0, 0.2, 1),
        opacity 180ms ease,
        box-shadow 220ms ease;
    }
    .dock.expanded {
      width: ${EXPANDED}px;
      box-shadow: 0 18px 48px -14px rgba(15, 23, 42, 0.38), 0 0 0 0.5px rgba(15, 23, 42, 0.1);
      /* 展开：先快后慢，落位轻 */
      transition:
        width 300ms cubic-bezier(0.16, 1, 0.3, 1),
        transform 300ms cubic-bezier(0.16, 1, 0.3, 1),
        opacity 160ms ease,
        box-shadow 300ms ease;
    }
    .dock.side-right { left: auto; right: ${GAP}px; }
    .dock.mode-full-hide { width: ${EXPANDED}px; }
    .dock.mode-full-hide.collapsed { transform: translate3d(-${PUSH_PINNED}px, 0, 0); opacity: 0; pointer-events: none; }
    .dock.side-right.mode-full-hide.collapsed { transform: translate3d(${PUSH_PINNED}px, 0, 0); }
    .dock.no-anim { transition: none !important; }
    .dock::after {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 2;
      border-radius: inherit;
      pointer-events: none;
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.7);
    }
    .clip { position: absolute; inset: 0; overflow: hidden; }
    iframe {
      position: absolute;
      top: 0; bottom: 0;
      left: 0; right: auto;
      width: ${EXPANDED}px;
      height: 100%;
      border: 0;
      background: transparent;
      color-scheme: light dark; /* 与侧栏页面一致，否则 Chrome 会给 iframe 垫一层不透明底色 */
    }
    .dock.side-right iframe { left: auto; right: 0; }
    @media (prefers-color-scheme: dark) {
      .dock { background: rgba(30, 30, 34, 0.6); box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.6), 0 0 0 0.5px rgba(0, 0, 0, 0.5); }
      .dock.expanded { box-shadow: 0 18px 48px -14px rgba(0, 0, 0, 0.7), 0 0 0 0.5px rgba(0, 0, 0, 0.5); }
      .dock::after { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.09), inset 0 1px 0 rgba(255, 255, 255, 0.08); }
    }
    @media (prefers-reduced-transparency: reduce) {
      .dock { background: rgb(246, 246, 249); -webkit-backdrop-filter: none; backdrop-filter: none; }
    }
    @media (prefers-reduced-transparency: reduce) and (prefers-color-scheme: dark) {
      .dock { background: rgb(30, 30, 34); }
    }

    /* 完全隐藏模式：屏幕边缘的感应条 */
    .edge {
      position: absolute;
      top: 0; bottom: 0;
      left: 0; right: auto;
      width: ${GAP}px;
      z-index: 3;
      display: none;
      align-items: center;
      justify-content: flex-start;
      pointer-events: auto;
    }
    .edge.active { display: flex; }
    .edge.side-right { left: auto; right: 0; justify-content: flex-end; }
    .pill {
      width: 3px;
      height: 42px;
      border-radius: 0 4px 4px 0;
      background: rgba(110, 110, 120, 0.3);
      opacity: 0;
      transition: opacity 150ms ease, width 150ms ease, height 150ms ease, background 150ms ease;
    }
    .edge.side-right .pill { border-radius: 4px 0 0 4px; }
    .edge.visible .pill { opacity: 1; }
    .edge.visible:hover .pill { width: 5px; height: 56px; background: rgba(10, 122, 255, 0.6); }
    @media (prefers-reduced-motion: reduce) {
      .dock, .dock.expanded, .pill { transition: none !important; }
    }
  `;

  function ensureHost() {
    if (hostEl?.isConnected) return;
    for (const id of LEGACY_IDS) document.getElementById(id)?.remove();
    document.documentElement?.removeAttribute('data-arc-sidebar-offset');
    document.getElementById(HOST_ID)?.remove();

    hostEl = document.createElement('div');
    hostEl.id = HOST_ID;
    Object.assign(hostEl.style, {
      all: 'initial',
      position: 'fixed',
      top: '0',
      bottom: '0',
      left: '0',
      width: PUSH_PINNED + 'px',
      zIndex: '2147483000',
      pointerEvents: 'none',
    });
    const shadow = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    dock = document.createElement('div');
    dock.className = 'dock collapsed no-anim';
    const clip = document.createElement('div');
    clip.className = 'clip';
    iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL('sidepanel.html?mode=overlay');
    iframe.title = 'Arc 侧边栏';
    iframe.allow = 'clipboard-write';
    iframe.addEventListener('load', notifyFrame);
    clip.append(iframe);
    dock.append(clip);

    edge = document.createElement('div');
    edge.className = 'edge';
    const pill = document.createElement('div');
    pill.className = 'pill';
    edge.append(pill);

    shadow.append(style, edge, dock);

    dock.addEventListener('mouseenter', (e) => {
      st.hoverDock = true;
      hoverIn({ buttons: e.buttons });
    });
    dock.addEventListener('mouseleave', () => {
      st.hoverDock = false;
      hoverOut();
    });
    edge.addEventListener('mouseenter', (e) => {
      st.hoverEdge = true;
      hoverIn({ fromEdge: true, buttons: e.buttons });
    });
    edge.addEventListener('mouseleave', () => {
      st.hoverEdge = false;
      hoverOut();
    });

    const mount = () => document.documentElement.append(hostEl);
    if (document.documentElement) mount();
    else {
      // document_start 极早：等根节点出现
      const obs = new MutationObserver(() => {
        if (document.documentElement) {
          obs.disconnect();
          mount();
        }
      });
      obs.observe(document, { childList: true });
    }
  }

  /* ---------- iframe 发来的消息 ---------- */

  window.addEventListener('message', (ev) => {
    if (!iframe || ev.source !== iframe.contentWindow) return;
    const d = ev.data;
    if (!d || d.source !== 'arc-sidebar') return;
    switch (d.type) {
      case 'ready':
        notifyFrame();
        break;
      case 'hover':
        // 跨进程消息会晚到：鼠标离开之前发出的「还在里面」不能把状态改回去
        if (d.on && d.t && d.t <= leftAt) break;
        st.hoverFrame = !!d.on;
        if (d.on) hoverIn({ buttons: d.buttons || 0 });
        else hoverOut();
        break;
      case 'activity': // 点了胶囊上的图标：鼠标离开之前不再自动展开
        clearOpen();
        st.suppress = true;
        break;
      case 'menu':
      case 'settings':
      case 'focus':
      case 'drag':
        st.hold[d.type] = !!d.on;
        if (!d.on) scheduleClose();
        break;
      case 'request-pin':
        setPinned(true);
        break;
      case 'request-collapse':
        collapse();
        break;
    }
  });

  /* ---------- 其他事件 ---------- */

  // iframe 在单独的进程里，鼠标快速划出时它有时收不到离开事件。
  // 宿主这边兜底：只要鼠标出现在面板以外的网页上，就算已经离开。
  function leftDock(e) {
    if (!st.hoverFrame && !st.hoverDock && !openTimer) return;
    if (e && dock) {
      const r = dock.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    }
    st.hoverFrame = st.hoverDock = false;
    leftAt = Date.now();
    iframe?.contentWindow?.postMessage({ source: 'arc-sidebar-host', type: 'left' }, '*');
    hoverOut();
  }
  document.addEventListener('mousemove', leftDock, { capture: true, passive: true });
  document.addEventListener('mouseout', (e) => !e.relatedTarget && leftDock(null), { capture: true, passive: true });

  // 切到别的标签页：预览收起，回来时是干净的状态
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    st.hoverDock = st.hoverFrame = st.hoverEdge = false;
    clearOpen();
    setPeek(false, { animate: false });
  });

  // 网页全屏（看视频等）时隐藏侧栏，也不再让位
  document.addEventListener('fullscreenchange', () => {
    st.fullscreen = !!document.fullscreenElement;
    apply({ animate: false });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && (changes[MODE_KEY] || changes[SIDE_KEY] || changes[HOVER_KEY])) loadSettings();
    if (area === 'local' && changes[PIN_KEY] && !!changes[PIN_KEY].newValue !== st.pinned) {
      st.pinned = !!changes[PIN_KEY].newValue;
      if (!st.pinned) st.peek = false;
      apply({ animate: !document.hidden });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'arc-sidebar:toggle') {
      // 工具栏图标 / 快捷键：开着就收起，收着就固定展开
      if (isExpanded()) collapse();
      else setPinned(true);
      sendResponse({ ok: true, expanded: isExpanded() });
    } else if (msg?.type === 'arc-sidebar:ping') {
      sendResponse({
        ok: true, enabled: st.enabled, expanded: isExpanded(), pinned: st.pinned, peek: st.peek, mode: st.mode, side: st.side,
        hover: { dock: st.hoverDock, frame: st.hoverFrame, edge: st.hoverEdge }, hold: st.hold, suppress: st.suppress,
      });
    }
    return false;
  });

  async function loadSettings({ first = false } = {}) {
    try {
      const [sync, local] = await Promise.all([
        chrome.storage.sync.get([MODE_KEY, SIDE_KEY, HOVER_KEY]),
        chrome.storage.local.get(PIN_KEY),
      ]);
      const sideChanged = !first && (sync[SIDE_KEY] === 'right' ? 'right' : 'left') !== st.side;
      st.mode = normalizeMode(sync[MODE_KEY]);
      st.side = sync[SIDE_KEY] === 'right' ? 'right' : 'left';
      st.hoverExpand = sync[HOVER_KEY] !== false;
      st.pinned = !!local[PIN_KEY];
      st.enabled = true;
      ensureHost();
      // 首次挂载、换边时不做动画，避免面板从另一侧飞过来
      apply({ animate: !first && !sideChanged });
    } catch (e) {
      // 扩展被重新加载后，旧内容脚本的 chrome.* 会失效，这里静默退出
      if (!String(e?.message || e).includes('context invalidated')) console.warn('[arc-sidebar]', e);
    }
  }

  window.__arcSidebarOverlayController = {
    recheck: () => loadSettings(),
  };

  loadSettings({ first: true });
})();
