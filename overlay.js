// 页面内的浮动侧栏（左/右 + 图标收起 / 完全隐藏）：
// - 'icon-rail'：常态是离边 8px 的 52px 图标胶囊，网页让出 68px；悬停展开成 300px 的浮动面板（不推开网页）
// - 'full-hide'：常态移出屏幕，鼠标到屏幕边缘时浮出
// 旧值 'always' / 'auto' 都按 icon-rail 处理
(function () {
  if (window.top !== window) return;
  if (window.__arcSidebarOverlayController) {
    window.__arcSidebarOverlayController.recheck();
    return;
  }

  const HOST_ID = 'arc-sidebar-overlay-host-v2';
  const PAGE_STYLE_ID = 'arc-sidebar-page-push-v2';
  const SESSION_EXPANDED_KEY = 'arcSidebarExpanded';
  const RAIL = 52; // 收起后的图标胶囊宽度
  const EXPANDED = 300; // 展开后的面板宽度
  const GAP = 8; // 浮动面板离窗口边缘的距离
  const COLLAPSE_DELAY = 130;
  const EXPAND_DELAY = 30;
  const MODE_KEY = 'ui.collapseMode';
  const SIDE_KEY = 'ui.sidebarSide';

  let dock = null;
  let edgeTrigger = null;
  let iframe = null;
  let hostEl = null;
  let collapseTimer = null;
  let expandTimer = null;
  let flashTimer = null;
  let menuOpen = false;
  let settingsOpen = false;
  let expanded = false;
  let enabled = false;
  let initialized = false;
  let currentMode = 'icon-rail';
  let currentSide = 'left';
  let skipAnimOnce = false;

  function extUrl(path) {
    return chrome.runtime.getURL(path);
  }

  function normalizeMode(m) {
    if (m === 'full-hide') return 'full-hide';
    // always / auto / icon-rail / 未知 → icon-rail 语义（auto 保留字符串以便 UI）
    if (m === 'auto') return 'auto';
    if (m === 'icon-rail') return 'icon-rail';
    return 'icon-rail';
  }

  function isFullHide(m) {
    return normalizeMode(m) === 'full-hide';
  }

  function isRailMode(m) {
    return !isFullHide(m);
  }

  function clearCollapseTimer() {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  }

  function clearExpandTimer() {
    if (expandTimer) {
      clearTimeout(expandTimer);
      expandTimer = null;
    }
  }

  function clearFlashTimer() {
    if (flashTimer) {
      clearTimeout(flashTimer);
      flashTimer = null;
    }
  }

  function reduceMotion() {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (_) {
      return false;
    }
  }

  function holdOpen() {
    return menuOpen || settingsOpen;
  }

  function persistExpanded(on) {
    // 内容脚本默认读不到 chrome.storage.session，这里用页面自己的 sessionStorage
    try {
      sessionStorage.setItem(SESSION_EXPANDED_KEY, on ? '1' : '0');
    } catch (_) {
      // 部分站点禁用 sessionStorage（沙箱 iframe 等），不记住展开状态即可
    }
  }

  async function readPersistedExpanded() {
    try {
      const v = sessionStorage.getItem(SESSION_EXPANDED_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (_) {}
    return null;
  }

  /** 图标栏常驻时给网页让出的宽度：胶囊 52px + 两侧各 8px 间距 */
  const PUSH = RAIL + GAP * 2;

  function ensurePagePushStyle() {
    if (document.getElementById(PAGE_STYLE_ID)) return;
    document.getElementById('arc-sidebar-page-push')?.remove(); // 0.4.0 及更早版本留下的样式
    const st = document.createElement('style');
    st.id = PAGE_STYLE_ID;
    st.textContent = `
      html[data-arc-sidebar-offset="left"] {
        margin-left: ${PUSH}px !important;
        margin-right: 0 !important;
        width: calc(100% - ${PUSH}px) !important;
        max-width: calc(100% - ${PUSH}px) !important;
        box-sizing: border-box !important;
      }
      html[data-arc-sidebar-offset="right"] {
        margin-right: ${PUSH}px !important;
        margin-left: 0 !important;
        width: calc(100% - ${PUSH}px) !important;
        max-width: calc(100% - ${PUSH}px) !important;
        box-sizing: border-box !important;
      }
    `;
    (document.head || document.documentElement).append(st);
  }

  function updatePageLayoutOffset() {
    ensurePagePushStyle();
    const root = document.documentElement;
    if (!root) return;
    if (!enabled || isFullHide(currentMode)) {
      // 仅在确实不需要让位时清掉；同文档内导航勿先置 0 再恢复
      if (root.hasAttribute('data-arc-sidebar-offset')) {
        root.removeAttribute('data-arc-sidebar-offset');
      }
      return;
    }
    const next = currentSide === 'right' ? 'right' : 'left';
    if (root.getAttribute('data-arc-sidebar-offset') !== next) {
      root.setAttribute('data-arc-sidebar-offset', next);
    }
  }

  function notifyIframeState() {
    if (!iframe || !iframe.contentWindow) return;
    const styleMode = isFullHide(currentMode) ? 'full-hide' : 'icon-rail';
    try {
      iframe.contentWindow.postMessage(
        {
          source: 'arc-sidebar-host',
          type: 'state',
          collapsed: !expanded,
          mode: styleMode,
          side: currentSide,
        },
        '*',
      );
    } catch (_) {}
  }

  function updateDockPosition() {
    if (!dock || !hostEl) return;
    const isRight = currentSide === 'right';
    const fullHide = isFullHide(currentMode);

    hostEl.style.left = isRight ? 'auto' : '0';
    hostEl.style.right = isRight ? '0' : 'auto';

    dock.dataset.side = currentSide;
    dock.dataset.mode = fullHide ? 'full-hide' : 'icon-rail';
    dock.classList.toggle('side-right', isRight);
    dock.classList.toggle('side-left', !isRight);
    dock.classList.toggle('mode-always', false);
    dock.classList.toggle('mode-full-hide', fullHide);
    dock.classList.toggle('mode-icon-rail', !fullHide);

    if (edgeTrigger) {
      edgeTrigger.classList.toggle('side-right', isRight);
      edgeTrigger.classList.toggle('side-left', !isRight);
      edgeTrigger.classList.toggle('visible', fullHide && !expanded);
    }

    updatePageLayoutOffset();
    notifyIframeState();
  }

  function setExpanded(on, { animate = true } = {}) {
    const next = !!on;
    expanded = next;
    if (!dock) return;
    const useAnim = animate && !skipAnimOnce && !reduceMotion();
    if (!useAnim) {
      dock.classList.add('no-anim');
    }
    dock.classList.toggle('expanded', expanded);
    dock.classList.toggle('collapsed', !expanded);
    if (edgeTrigger) {
      edgeTrigger.classList.toggle('visible', isFullHide(currentMode) && !expanded);
    }
    if (iframe) {
      iframe.style.pointerEvents = expanded || isRailMode(currentMode) ? 'auto' : 'none';
    }
    updatePageLayoutOffset();
    notifyIframeState();
    persistExpanded(expanded);
    if (!useAnim) {
      // 一帧后恢复过渡，避免后续展开/收起无动画
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (dock) dock.classList.remove('no-anim');
          skipAnimOnce = false;
        });
      });
    } else {
      skipAnimOnce = false;
    }
  }

  function scheduleExpand() {
    clearCollapseTimer();
    clearExpandTimer();
    clearFlashTimer();
    if (reduceMotion() || EXPAND_DELAY <= 0) {
      setExpanded(true);
      return;
    }
    expandTimer = setTimeout(() => {
      expandTimer = null;
      setExpanded(true);
    }, EXPAND_DELAY);
  }

  function scheduleCollapse(delay = COLLAPSE_DELAY) {
    clearExpandTimer();
    clearCollapseTimer();
    collapseTimer = setTimeout(() => {
      collapseTimer = null;
      if (holdOpen()) return;
      const hoveringDock = dock && dock.matches(':hover');
      const hoveringEdge = edgeTrigger && edgeTrigger.matches(':hover');
      if (!hoveringDock && !hoveringEdge) {
        setExpanded(false);
      }
    }, delay);
  }

  function flashPreview() {
    // 仅在用户主动切模式/侧时短暂预览；日常导航绝不调用
    if (!enabled || !dock) return;
    clearCollapseTimer();
    clearExpandTimer();
    clearFlashTimer();
    setExpanded(true);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      if (holdOpen()) return;
      const hoveringDock = dock && dock.matches(':hover');
      if (!hoveringDock) setExpanded(false);
    }, 520);
  }

  function wireHostEvents() {
    if (!dock || dock.__arcWired) return;
    dock.__arcWired = true;
    dock.addEventListener('mouseenter', () => {
      scheduleExpand();
    });
    dock.addEventListener('mouseleave', () => {
      if (!holdOpen()) scheduleCollapse();
    });
    if (edgeTrigger) {
      edgeTrigger.addEventListener('mouseenter', () => {
        scheduleExpand();
      });
      edgeTrigger.addEventListener('mouseleave', () => {
        if (!holdOpen()) scheduleCollapse();
      });
    }
    window.addEventListener('message', (ev) => {
      if (!iframe || ev.source !== iframe.contentWindow) return;
      const data = ev.data;
      if (!data || data.source !== 'arc-sidebar') return;
      if (data.type === 'menu') {
        menuOpen = !!data.open;
        if (menuOpen) {
          clearCollapseTimer();
          clearExpandTimer();
          clearFlashTimer();
          setExpanded(true);
        } else if (!holdOpen() && dock && !dock.matches(':hover')) {
          scheduleCollapse();
        }
      } else if (data.type === 'settings') {
        settingsOpen = !!data.open;
        if (settingsOpen) {
          clearCollapseTimer();
          clearExpandTimer();
          clearFlashTimer();
          setExpanded(true);
        } else if (!holdOpen() && dock && !dock.matches(':hover')) {
          scheduleCollapse();
        }
      } else if (data.type === 'request-expand') {
        scheduleExpand();
      } else if (data.type === 'request-collapse') {
        clearExpandTimer();
        clearCollapseTimer();
        clearFlashTimer();
        if (!holdOpen()) setExpanded(false);
      } else if (data.type === 'ready') {
        notifyIframeState();
      }
    });
  }

  function ensureHost() {
    document.getElementById('arc-sidebar-overlay-host')?.remove(); // 0.4.0 及更早版本的宿主
    const existing = document.getElementById(HOST_ID);
    if (existing) {
      // 软重注入：绝不全量拆掉重建，避免导航闪屏
      if (!hostEl) hostEl = existing;
      if (!dock && existing.shadowRoot) {
        dock = existing.shadowRoot.querySelector('.dock');
        edgeTrigger = existing.shadowRoot.querySelector('.edge-trigger');
        iframe = existing.shadowRoot.querySelector('iframe');
      }
      if (dock && hostEl === existing) {
        wireHostEvents();
        return existing;
      }
      // 残缺宿主才移除
      try {
        existing.remove();
      } catch (_) {}
      dock = null;
      edgeTrigger = null;
      iframe = null;
      hostEl = null;
    }

    const host = document.createElement('div');
    hostEl = host;
    host.id = HOST_ID;
    host.setAttribute('data-arc-sidebar', '1');
    Object.assign(host.style, {
      all: 'initial',
      position: 'fixed',
      top: '0',
      left: '0',
      bottom: '0',
      width: EXPANDED + GAP * 2 + 'px',
      zIndex: '2147483000',
      pointerEvents: 'none',
      overflow: 'visible',
    });
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    const hideOffset = EXPANDED + GAP * 2;

    // 浮动玻璃面板：离窗口边缘 GAP，收起时宽度缩成 RAIL 的胶囊，展开时宽度变成 EXPANDED。
    // 磨砂效果在这里（宿主页面里）做，才能模糊到后面的网页；iframe 本身是透明的。
    style.textContent = `
      :host { all: initial; }
      .dock {
        position: absolute;
        top: ${GAP}px; bottom: ${GAP}px;
        left: ${GAP}px; right: auto;
        width: ${RAIL}px;
        box-sizing: border-box;
        pointer-events: auto;
        border-radius: 18px;
        overflow: hidden;
        isolation: isolate;
        background: rgba(246, 246, 249, 0.62);
        -webkit-backdrop-filter: blur(28px) saturate(1.8);
        backdrop-filter: blur(28px) saturate(1.8);
        box-shadow: 0 10px 30px -12px rgba(15, 23, 42, 0.28), 0 0 0 0.5px rgba(15, 23, 42, 0.1);
        will-change: width, transform;
        transition:
          width 220ms cubic-bezier(0.22, 1, 0.36, 1),
          transform 220ms cubic-bezier(0.22, 1, 0.36, 1),
          opacity 160ms ease,
          box-shadow 220ms ease;
      }
      /* 玻璃的描边和顶部高光：盖在 iframe 上面，不占宽度 */
      .dock::after {
        content: "";
        position: absolute;
        inset: 0;
        z-index: 2;
        border-radius: inherit;
        pointer-events: none;
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.7);
      }
      .dock.side-right { left: auto; right: ${GAP}px; }
      .dock.expanded {
        width: ${EXPANDED}px;
        box-shadow: 0 18px 48px -14px rgba(15, 23, 42, 0.38), 0 0 0 0.5px rgba(15, 23, 42, 0.1);
      }
      .dock.mode-full-hide { width: ${EXPANDED}px; }
      .dock.mode-full-hide.collapsed {
        transform: translate3d(-${hideOffset}px, 0, 0);
        opacity: 0;
        pointer-events: none;
      }
      .dock.side-right.mode-full-hide.collapsed { transform: translate3d(${hideOffset}px, 0, 0); }
      .dock.no-anim { transition: none !important; }
      @media (prefers-color-scheme: dark) {
        .dock {
          background: rgba(30, 30, 34, 0.6);
          box-shadow: 0 10px 30px -12px rgba(0, 0, 0, 0.6), 0 0 0 0.5px rgba(0, 0, 0, 0.5);
        }
        .dock.expanded { box-shadow: 0 18px 48px -14px rgba(0, 0, 0, 0.7), 0 0 0 0.5px rgba(0, 0, 0, 0.5); }
        .dock::after { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.09), inset 0 1px 0 rgba(255, 255, 255, 0.08); }
      }
      @media (prefers-reduced-transparency: reduce) {
        .dock { background: rgb(246, 246, 249); -webkit-backdrop-filter: none; backdrop-filter: none; }
      }
      @media (prefers-reduced-transparency: reduce) and (prefers-color-scheme: dark) {
        .dock { background: rgb(30, 30, 34); }
      }
      iframe {
        position: absolute;
        top: 0; bottom: 0;
        left: 0; right: auto;
        z-index: 1;
        width: ${EXPANDED}px;
        height: 100%;
        border: 0;
        background: transparent;
        color-scheme: light dark; /* 与侧栏页面一致，否则 Chrome 会给 iframe 垫一层不透明底色 */
        pointer-events: auto;
      }
      .dock.side-right iframe { left: auto; right: 0; }
      .edge-trigger {
        position: absolute;
        top: 0; bottom: 0;
        left: 0; right: auto;
        width: 8px;
        z-index: 3;
        pointer-events: none;
        opacity: 0;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        transition: opacity 150ms ease;
      }
      .edge-trigger.side-right { left: auto; right: 0; justify-content: flex-end; }
      .edge-trigger.visible { pointer-events: auto; opacity: 1; }
      .edge-pill {
        width: 3px;
        height: 42px;
        border-radius: 0 4px 4px 0;
        background: rgba(110, 110, 120, 0.3);
        transition: width 150ms ease, background 150ms ease, height 150ms ease;
      }
      .edge-trigger.side-right .edge-pill { border-radius: 4px 0 0 4px; }
      .edge-trigger:hover .edge-pill { width: 5px; height: 56px; background: rgba(10, 122, 255, 0.6); }
      @media (prefers-reduced-motion: reduce) {
        .dock, .edge-pill { transition: none !important; }
      }
    `;

    dock = document.createElement('div');
    dock.className = 'dock collapsed side-left mode-icon-rail';

    edgeTrigger = document.createElement('div');
    edgeTrigger.className = 'edge-trigger side-left';
    const pill = document.createElement('div');
    pill.className = 'edge-pill';
    edgeTrigger.append(pill);

    iframe = document.createElement('iframe');
    iframe.src = extUrl('sidepanel.html?mode=overlay');
    iframe.title = 'Arc 侧边栏';
    iframe.allow = 'clipboard-write';
    iframe.setAttribute('loading', 'eager');
    iframe.addEventListener('load', () => {
      notifyIframeState();
    });

    dock.append(iframe);
    shadow.append(style, edgeTrigger, dock);
    const mountRoot = document.documentElement || document.body;
    if (mountRoot) mountRoot.append(host);
    else {
      // document_start 极早：等根节点
      const obs = new MutationObserver(() => {
        if (document.documentElement) {
          document.documentElement.append(host);
          obs.disconnect();
        }
      });
      obs.observe(document, { childList: true });
    }

    wireHostEvents();
    return host;
  }

  async function applyMode({ fromChange = false, modeChanged = false, sideChanged = false, userFlash = false } = {}) {
    try {
      const data = await chrome.storage.sync.get([MODE_KEY, SIDE_KEY]);
      const nextMode = normalizeMode(data[MODE_KEY]);
      const nextSide = data[SIDE_KEY] === 'right' ? 'right' : 'left';

      const wasExpanded = expanded;
      currentMode = nextMode;
      currentSide = nextSide;

      ensureHost();
      enabled = true;
      updateDockPosition();

      if (!initialized) {
        const pref = await readPersistedExpanded();
        skipAnimOnce = true;
        setExpanded(pref === true, { animate: false });
      } else if (sideChanged && !modeChanged) {
        if (wasExpanded) {
          setExpanded(true);
          if (!holdOpen() && dock && !dock.matches(':hover')) scheduleCollapse(400);
        } else {
          setExpanded(false);
        }
      } else if (modeChanged) {
        if (dock && dock.matches(':hover')) setExpanded(true);
        else if (!fromChange) setExpanded(false);
        else if (userFlash) flashPreview();
        else setExpanded(false);
      } else if (!fromChange) {
        setExpanded(false, { animate: false });
      }

      initialized = true;
    } catch (e) {
      // 扩展被重新加载后，旧内容脚本的 chrome.* 会失效，这里静默退出
      if (!String(e?.message || e).includes('context invalidated')) console.warn('[arc-sidebar]', e);
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes[MODE_KEY] || changes[SIDE_KEY]) {
      applyMode({
        fromChange: true,
        modeChanged: !!changes[MODE_KEY],
        sideChanged: !!changes[SIDE_KEY],
        userFlash: false,
      });
    }
  });

  if (chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return false;
      if (msg.type === 'arc-sidebar:ping') {
        sendResponse({ ok: true, enabled, expanded, mode: currentMode, side: currentSide });
        return false;
      }
      if (msg.type === 'arc-sidebar:flash') {
        applyMode({ fromChange: true, modeChanged: true, userFlash: true }).then(() => {
          if (enabled) flashPreview();
        });
        sendResponse({ ok: true, enabled: true });
        return false;
      }
      if (msg.type === 'arc-sidebar:toggle') {
        applyMode({ fromChange: true }).then(() => {
          if (!enabled) return;
          setExpanded(!expanded);
        });
        sendResponse({ ok: true, expanded });
        return false;
      }
      return false;
    });
  }

  window.__arcSidebarOverlayController = {
    recheck: () => applyMode({ fromChange: true }),
    expand: () => scheduleExpand(),
    collapse: () => {
      clearExpandTimer();
      clearCollapseTimer();
      clearFlashTimer();
      if (!holdOpen()) setExpanded(false);
    },
    flash: () => {
      applyMode({ fromChange: true, modeChanged: true, userFlash: true }).then(() => {
        if (enabled) flashPreview();
      });
    },
  };

  applyMode({ fromChange: false });
})();
