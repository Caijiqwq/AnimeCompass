/**
 * 前端逻辑：路由、三种推荐入口、浏览与详情。
 * 所有用户数据（最近看过、偏好、收藏）都存在 localStorage，不上传。
 */
(function () {
  'use strict';

  const Rec = window.AnimeRec;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const app = $('#app');
  const modal = $('#modal');
  const toastEl = $('#toast');

  const STORE = {
    recent: 'rec.recent.v1',
    profile: 'rec.profile.v1',
    favorites: 'rec.favorites.v1',
    watched: 'rec.watched.v1',
    locale: 'rec.locale.v1',
    rating: 'rec.rating.v1',
  };

  /** 简介显示语言：zh（中文优先）/ en（英文）/ both（中英都显示）。 */
  const LOCALES = [
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
    { id: 'both', label: '中英对照' },
  ];

  const state = {
    catalog: [],
    catalogMap: new Map(),
    meta: null,
    recent: loadIds(STORE.recent),
    favorites: new Set(loadIds(STORE.favorites)),
    watched: new Set(loadIds(STORE.watched)),
    profile: loadObject(STORE.profile) || { tags: ['剧情', '奇幻'], moods: [], era: '', length: '', minScore: 7.3, format: 'any' },
    locale: localStorage.getItem(STORE.locale) || 'zh',
    /** 评分显示偏好：both（AniList + Bangumi）/ anilist / bangumi。 */
    rating: localStorage.getItem(STORE.rating) || 'both',
    pick: { seed: [], result: null, source: 'watched' },
    browse: { q: '', genre: '', era: '', sort: 'heat', minScore: 0, type: 'any', shown: 36 },
    randomResult: null,
    /** 静态版分片加载进度；单文件数据集时为 null。 */
    shards: null,
  };

  /* ---------------- 本地存储 ---------------- */

  function loadIds(key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(raw) ? raw.map(Number).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  function loadObject(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  }
  function saveIds(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch { /* 隐私模式下忽略 */ }
  }
  function saveObject(key, obj) {
    try {
      localStorage.setItem(key, JSON.stringify(obj));
    } catch { /* 忽略 */ }
  }

  function persist() {
    saveIds(STORE.recent, state.recent);
    saveIds(STORE.favorites, [...state.favorites]);
    saveIds(STORE.watched, [...state.watched]);
    saveObject(STORE.profile, state.profile);
  }

  /* ---------------- 目录与渐进加载 ---------------- */

  /** 把一批条目并进目录（静态版分片加载时反复用）。 */
  function mergeIntoCatalog(items) {
    let added = 0;
    for (const a of items || []) {
      if (!a || state.catalogMap.has(a.id)) continue;
      state.catalog.push(a);
      state.catalogMap.set(a.id, a);
      added++;
    }
    return added;
  }

  /** 分片加载完成后，把当前页面按新数据重画一遍（保留滚动位置）。 */
  function refreshAfterShard() {
    const y = window.scrollY;
    const path = currentPath();
    if (path === '/' || path === '') render.home();
    else if (path === '/pick') render.pick();
    else if (path === '/browse') render.browse();
    else if (path.startsWith('/detail/')) renderDetail(Number(path.split('/')[2]));
    window.scrollTo(0, y);
  }

  /** 静态版：先加载首页需要的核心数据，其余分片在后台依次加载。 */
  async function loadCatalogProgressive(seed) {
    const index = seed || (await (await fetch('data/index.json')).json());
    state.meta = { ...index, items: undefined };

    const coreRes = await fetch(index.core || 'data/core.json');
    const core = await coreRes.json();
    mergeIntoCatalog(core.items);

    const shards = index.shards || [];
    if (!shards.length) return;

    state.shards = { total: shards.length, loaded: 0 };
    // 不阻塞首屏：先让首页渲染出来，再去拉剩下的
    const schedule = window.requestIdleCallback || ((fn) => setTimeout(fn, 120));
    schedule(async () => {
      for (const shard of shards) {
        try {
          // 分片路径按 index.json 里给的来；没带目录时补上 data/
          const file = shard.file.includes('/') ? shard.file : 'data/' + shard.file;
          const r = await fetch(file);
          const payload = await r.json();
          const added = mergeIntoCatalog(payload.items);
          state.shards.loaded++;
          if (added) {
            state.recent = state.recent.filter((id) => byId(id));
            refreshAfterShard();
          }
        } catch {
          /* 单片失败不影响已经加载的部分 */
        }
      }
    });
  }

  /* ---------------- 小工具 ---------------- */

  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 1900);
  }

  const displayTitle = (a) => a.titleCn || a.title;
  const altTitle = (a) => (a.titleCn ? a.title : a.titleEn || '');
  const yearText = (a) => (a.year ? `${a.year} 年` : '年份不详');
  const scoreText = (a) => (a.score ? a.score.toFixed(2) : '暂无');
  const bgmScoreText = (a) => (a.bangumi?.score ? a.bangumi.score.toFixed(1) : null);
  const RATINGS = [
    { id: 'both', label: '两边都显示' },
    { id: 'anilist', label: '只看 AniList' },
    { id: 'bangumi', label: '只看 Bangumi' },
  ];
  const byId = (id) => state.catalogMap.get(Number(id));
  const posterUrl = (a, small) => (a ? (small ? a.imageSmall || a.image : a.image) : '');

  function seasonLabel(a) {
    const map = { winter: '冬', spring: '春', summer: '夏', fall: '秋' };
    if (a.season && map[a.season] && a.year) return `${a.year} 年${map[a.season]}季`;
    return yearText(a);
  }

  function tagsPreview(a, n = 3) {
    return (a.genres || []).slice(0, n);
  }

  function yearSpan() {
    const years = state.catalog.map((a) => a.year).filter(Boolean).sort((x, y) => x - y);
    if (!years.length) return '—';
    return `${years[0]} – ${years[years.length - 1]}`;
  }

  /* ---------------- 简介：中英切换 ---------------- */

  /** 该条目有没有可用的中文简介。 */
  const hasZh = (a) => !!a.synopsisZh;

  /**
   * 输出简介区块。
   * 中文优先是默认值：勾了中文但这条确实没有中文来源时，会照实说明并回落到英文，
   * 而不是硬凑一段机器翻译。
   */
  function synopsisHtml(a, { compact = false } = {}) {
    const zh = a.synopsisZh || '';
    const en = a.synopsis || '';
    const locale = state.locale;
    const fromSeries = a.synopsisZhFrom === 'series';
    const srcLabel = a.synopsisZhSource === 'bangumi' ? 'Bangumi 官方简介' : '萌娘百科简介';
    const note = fromSeries
      ? `<span class="muted small">（同系列作品的${srcLabel}）</span>`
      : `<span class="muted small">（${srcLabel}）</span>`;
    // 萌娘有些条目没有剧情章节，提取到的更偏「作品信息」，这里照实说明
    const metaHint =
      zh && a.synopsisZhMeta
        ? '<div class="muted small" style="margin-bottom:6px">这段中文更偏作品信息而不是剧情梗概，剧情可以切到 English 看原文。</div>'
        : '';

    const block = (lang, text) => {
      if (!text) return '';
      const head =
        locale === 'both'
          ? `<div class="syn-label">${lang === 'zh' ? `中文简介${note}` : 'English synopsis'}</div>`
          : '';
      return `<div class="syn-body" lang="${lang === 'zh' ? 'zh-CN' : 'en'}">${head}<p>${esc(text)}</p></div>`;
    };

    let body = '';
    let hint = '';
    if (locale === 'zh') {
      if (zh) {
        body = block('zh', zh);
        hint = metaHint;
      } else if (en) {
        body = block('en', en);
        hint = '<div class="muted small" style="margin-bottom:6px">这条暂时没有中文简介，下面是英文原文。</div>';
      }
    } else if (locale === 'en') {
      body = block('en', en);
      if (!en && zh) body = block('zh', zh);
    } else {
      body = [zh ? block('zh', zh) : '', en ? block('en', en) : ''].join('');
      if (zh && a.synopsisZhMeta) hint = metaHint;
      else if (!zh && en) hint = '<div class="muted small" style="margin-bottom:6px">这条没有中文简介，只有英文。</div>';
    }

    if (!body) body = '<div class="syn-body"><p>暂无简介。</p></div>';

    const switcher = compact
      ? ''
      : `<div class="syn-switch" data-locale-switch>
          ${LOCALES.map(
            (l) => `<button class="loc-btn ${state.locale === l.id ? 'on' : ''}" data-locale="${l.id}">${l.label}</button>`
          ).join('')}
        </div>`;

    return `<div class="synopsis" data-synopsis="${a.id}">
      ${switcher}
      ${hint}
      ${body}
    </div>`;
  }

  /** 原名那一行：英文名与原名重复时只显示一个。 */
  function altTitleLine(a) {
    const parts = [altTitle(a), a.title].filter(Boolean);
    const seen = new Set();
    const unique = parts.filter((t) => {
      const k = Rec.normalizeTitle(t);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return unique.join(' / ');
  }

  /* ---------------- DOM 片段 ---------------- */

  window.__posterFail = function (img, ch) {
    const div = document.createElement('div');
    div.className = 'fallback';
    div.textContent = ch;
    img.replaceWith(div);
  };

  /** 评分来源说明，鼠标悬停时显示，免得大家以为是我们自己打的分。 */
  function scoreTip(a) {
    const parts = [`AniList 均分 ${scoreText(a)}／10`];
    if (a.members) parts.push(`${a.members.toLocaleString('zh-CN')} 人标记`);
    if (a.favorites) parts.push(`${a.favorites.toLocaleString('zh-CN')} 人收藏`);
    if (a.bangumi?.score) {
      parts.push(`Bangumi ${a.bangumi.score.toFixed(1)} 分${a.bangumi.total ? `（${a.bangumi.total.toLocaleString('zh-CN')} 人评分）` : ''}`);
      if (a.bangumi.rank) parts.push(`bgm 排名 #${a.bangumi.rank}`);
    }
    return parts.join(' · ');
  }

  /** 封面左上角的分数角标：内容跟着评分来源偏好走。 */
  function scoreBadgeHtml(a) {
    const showAni = state.rating !== 'bangumi' && a.score;
    const showBgm = state.rating !== 'anilist' && a.bangumi?.score;
    if (!showAni && !showBgm) return '';
    const rows = [];
    if (showAni) rows.push(`<span class="score-row anilist" title="${esc(scoreTip(a))}"><i>A</i>${a.score.toFixed(1)}</span>`);
    if (showBgm)
      rows.push(
        `<span class="score-row bangumi" title="${esc(scoreTip(a))}"><i>B</i>${a.bangumi.score.toFixed(1)}</span>`
      );
    return `<span class="score ${rows.length > 1 ? 'multi' : ''}" title="${esc(scoreTip(a))}">${rows.join('')}</span>`;
  }

  function posterHtml(a, { small = false, showScore = true } = {}) {
    const url = posterUrl(a, small);
    const initial = esc((displayTitle(a) || '番')[0]);
    return `<div class="poster">
      ${url ? `<img src="${esc(url)}" alt="${esc(displayTitle(a))}" loading="lazy" onerror="window.__posterFail(this,'${initial}')" />` : `<div class="fallback">${initial}</div>`}
      ${showScore ? scoreBadgeHtml(a) : ''}
    </div>`;
  }

  function cardHtml(entry, opts = {}) {
    const a = entry.anime || entry;
    const why = entry.reason || '';
    const match = entry.match ? `<span class="match">契合 ${entry.match}%</span>` : '';
    return `<article class="anime-card" data-id="${a.id}">
      <a href="#/detail/${a.id}" data-link data-open="${a.id}">${posterHtml(a, opts)}</a>
      <a href="#/detail/${a.id}" data-link data-open="${a.id}" class="title">${esc(displayTitle(a))}</a>
      <div class="sub">${esc(yearText(a))} · ${esc(a.type || 'TV')}${a.episodes ? ` · ${a.episodes} 集` : ''}${a.supplemental ? ' · 仅目录收录' : ''}</div>
      ${why ? `<div class="why">${esc(why)}</div>` : ''}
      <div class="row">${match}${tagsPreview(a).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
      <div class="actions">
        <button class="btn plain sm" data-act="want" data-id="${a.id}" data-on="已看过" data-off="标记看过">${state.watched.has(a.id) ? '已看过' : '标记看过'}</button>
        <button class="btn plain sm" data-act="fav" data-id="${a.id}" data-on="已收藏" data-off="收藏">${state.favorites.has(a.id) ? '已收藏' : '收藏'}</button>
      </div>
    </article>`;
  }

  function gridHtml(entries) {
    if (!entries.length) return `<div class="empty">这里暂时没有符合条件的番剧，试试放宽一点条件。</div>`;
    return `<div class="grid">${entries.map((e) => cardHtml(e)).join('')}</div>`;
  }

  /* ---------------- 路由 ---------------- */

  const routes = [
    { re: /^\/?$/, view: 'home' },
    { re: /^\/pick$/, view: 'pick' },
    { re: /^\/browse$/, view: 'browse' },
    { re: /^\/about$/, view: 'about' },
  ];

  let lastHash = null;

  function currentPath() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const clean = hash.split('?')[0] || '/';
    return clean.startsWith('/') ? clean : '/' + clean;
  }

  function navigate() {
    const path = currentPath();
    const nav = path.split('/')[1] || 'home';
    $$('.site-nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (nav === '' ? 'home' : nav)));
    window.scrollTo(0, 0);

    // 只有地址栏真的换了（或带了新参数）才应用 ?mode=，
    // 否则组件内部的重新渲染会被地址栏里的旧参数覆盖。
    const fullHash = location.hash || '#/';
    if (fullHash !== lastHash) {
      lastHash = fullHash;
      const mode = new URLSearchParams(fullHash.split('?')[1] || '').get('mode');
      if (mode && ['watched', 'profile', 'random'].includes(mode)) state.pick.source = mode;
    }

    if (path.startsWith('/detail/')) return renderDetail(Number(path.split('/')[2]));
    for (const r of routes) if (r.re.test(path)) return render[r.view]();
    render.home();
  }

  document.addEventListener('click', (e) => {
    const ratingBtn = e.target.closest('[data-rating]');
    if (ratingBtn) {
      e.preventDefault();
      setRating(ratingBtn.dataset.rating);
      return;
    }
    const locBtn = e.target.closest('[data-locale]');
    if (locBtn) {
      e.preventDefault();
      setLocale(locBtn.dataset.locale);
      return;
    }
    const link = e.target.closest('a[data-link]');
    if (link && link.getAttribute('href')?.startsWith('#')) {
      // 交给 hashchange，但仍然阻止默认跳转造成的闪烁
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) {
      const id = Number(act.dataset.id);
      handleAction(act.dataset.act, id);
      e.preventDefault();
      return;
    }
    // 卡片封面与标题是普通的 #/detail/:id 链接，交给 hashchange 处理
  });

  window.addEventListener('hashchange', navigate);

  /** 切换简介语言：记住偏好，并把当前页面上（以及弹层里）的简介就地换掉。 */
  function setLocale(locale) {
    if (!LOCALES.some((l) => l.id === locale)) return;
    state.locale = locale;
    try {
      localStorage.setItem(STORE.locale, locale);
    } catch { /* 忽略隐私模式 */ }

    const targets = $$('[data-synopsis]');
    for (const node of targets) {
      const a = byId(node.dataset.synopsis);
      if (!a) continue;
      const compact = !node.querySelector('[data-locale-switch]');
      const wrap = document.createElement('div');
      wrap.innerHTML = synopsisHtml(a, { compact });
      node.replaceWith(wrap.firstElementChild);
    }
    syncLocaleButtons();
  }

  /** 让语言按钮的选中态与当前设置一致（详情页的切换器 + 关于页的偏好设置）。 */
  function syncLocaleButtons() {
    $$('[data-locale-switch] .loc-btn').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.locale === state.locale);
    });
    $$('[data-locale-pref]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.localePref === state.locale);
    });
  }

  /** 切换评分来源：记住偏好，就地更新角标、详情页评分行与按钮状态。 */
  function setRating(rating) {
    if (!RATINGS.some((r) => r.id === rating)) return;
    state.rating = rating;
    try {
      localStorage.setItem(STORE.rating, rating);
    } catch { /* 忽略隐私模式 */ }

    // 角标
    for (const poster of $$('.poster')) {
      const card = poster.closest('[data-id]');
      const id = Number(card?.dataset.id);
      const a = id ? byId(id) : null;
      if (!a) continue;
      const old = poster.querySelector('.score');
      const html = scoreBadgeHtml(a);
      if (old) {
        if (html) old.outerHTML = html;
        else old.remove();
      } else if (html) {
        poster.insertAdjacentHTML('beforeend', html);
      }
    }

    // 详情页与弹层里的评分行：只显示被选中的那一侧
    for (const span of $$('.meta [title]')) {
      const label = span.querySelector('.muted')?.textContent || '';
      if (label.includes('AniList')) span.classList.toggle('muted', state.rating === 'bangumi');
      if (label.includes('Bangumi')) span.classList.toggle('muted', state.rating === 'anilist');
    }
    syncRatingButtons();
  }

  function syncRatingButtons() {
    $$('[data-rating-pref]').forEach((btn) => {
      btn.classList.toggle('on', btn.dataset.ratingPref === state.rating);
    });
  }

  function handleAction(act, id) {
    const a = byId(id);
    if (!a) return;
    // 标记/收藏只改本地状态与按钮，不重绘页面
    if (act === 'want') {
      if (state.watched.has(id)) state.watched.delete(id);
      else {
        state.watched.add(id);
        if (!state.recent.includes(id)) state.recent.unshift(id);
        state.recent = state.recent.slice(0, 30);
      }
      persist();
      toast(state.watched.has(id) ? `已记下《${displayTitle(a)}》` : `已从看过列表移除《${displayTitle(a)}》`);
      refreshCurrentView();
    } else if (act === 'fav') {
      if (state.favorites.has(id)) state.favorites.delete(id);
      else state.favorites.add(id);
      persist();
      toast(state.favorites.has(id) ? '已收藏' : '已取消收藏');
      refreshCurrentView();
    } else if (act === 'similar') {
      state.pick.seed = [id];
      state.pick.source = 'watched';
      if (currentPath() === '/pick') {
        render.pick();
        setTimeout(runWatchedRecommend, 20);
      } else {
        location.hash = '#/pick?mode=watched';
        setTimeout(runWatchedRecommend, 80);
      }
    }
  }

  function refreshCurrentView() {
    syncActionButtons();
  }

  /** 只更新按钮文案，避免整页重绘导致滚动位置丢失。 */
  function syncActionButtons() {
    $$('[data-act="want"]').forEach((btn) => {
      const id = Number(btn.dataset.id);
      const on = state.watched.has(id);
      btn.textContent = on ? btn.dataset.on : btn.dataset.off;
      btn.classList.toggle('on', on);
    });
    $$('[data-act="fav"]').forEach((btn) => {
      const id = Number(btn.dataset.id);
      const on = state.favorites.has(id);
      btn.textContent = on ? btn.dataset.on : btn.dataset.off;
      btn.classList.toggle('on', on);
    });
  }

  /* ---------------- 首页 ---------------- */

  /** 各路由的渲染函数，在下面逐个挂上来。 */
  const render = {};

  render.boot = function () {
    app.innerHTML = `<div class="empty"><span class="spinner"></span>正在载入番剧数据…</div>`;
  };

  render.home = function () {
    const today = state.randomResult?.anime || pickFeatured();
    app.innerHTML = `
      <section class="hero">
        <span class="hero-mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
            <path d="M32 20c0-6 3-11 0-14-3 3 0 8 0 14Z" />
            <path d="M32 20c4-4 10-5 12-9-5-1-10 3-12 9Z" />
            <path d="M32 20c-4-4-10-5-12-9 5-1 10 3 12 9Z" />
            <path d="M32 20c6-1 11 2 15-1-4-4-11-3-15 1Z" />
            <path d="M32 20c-6-1-11 2-15-1 4-4 11-3 15 1Z" />
            <path d="M32 22v26" />
            <path d="M32 34c-4-3-8-3-11-6 4-2 9 0 11 6Z" />
            <path d="M32 42c4-3 8-3 11-6-4-2-9 0-11 6Z" />
          </svg>
        </span>
        <h1>今晚看点<em>什么</em>？</h1>
        <p>把最近在看、或者干脆把口味写下来，这里会从 ${state.catalog.length} 部收录作品里挑几部适合你的。
        老番新番都有，实在没主意就抽一张。${
          state.shards && state.shards.loaded < state.shards.total
            ? '（完整目录 ' + (state.meta?.count ?? '') + ' 部，正在后台加载）'
            : ''
        }</p>
      </section>

      <div class="modes">
        <a class="mode" href="#/pick?mode=watched" data-link data-goto="watched">
          <span class="tag">路线一</span>
          <h3>照着最近看的推</h3>
          <p>输入三到五部刚看完或正在追的番，按口味相似度往下接。</p>
          <span class="go">开始挑选 →</span>
        </a>
        <a class="mode" href="#/pick?mode=profile" data-link data-goto="profile">
          <span class="tag">路线二</span>
          <h3>填一份口味问卷</h3>
          <p>选喜欢的类型、今晚的心情、能接受的集数长度，直接出结果。</p>
          <span class="go">去填偏好 →</span>
        </a>
        <a class="mode" href="#/pick?mode=random" data-link data-goto="random">
          <span class="tag">路线三</span>
          <h3>随机一部优质番</h3>
          <p>从评分靠前的作品里按权重抽一部，冷门佳作也有机会。</p>
          <span class="go">抽一部 →</span>
        </a>
      </div>

      <div class="section-title">
        <h2>今天先看这部</h2>
        <span>每天点开都是新的一张</span>
      </div>
      <div class="card today" id="today-card">
        <a href="#/detail/${today.id}" data-open="${today.id}">${posterHtml(today)}</a>
        <div class="today-body">
          <h3><a href="#/detail/${today.id}" data-open="${today.id}" style="color:inherit">${esc(displayTitle(today))}</a></h3>
          <div class="chips" style="margin-top:6px">${tagsPreview(today, 4).map((t) => `<span class="chip pink">${esc(t)}</span>`).join('')}</div>
          <div class="today-body meta small muted" style="margin-top:8px">
            评分 ${scoreText(today)} · ${esc(seasonLabel(today))} · ${esc(today.type || 'TV')}${today.episodes ? ` · ${today.episodes} 集` : ''} · ${esc(today.studios?.[0] || '制作公司未知')}
          </div>
          <p class="small" style="color:var(--ink-2)">${esc(today.lead || '')}</p>
          <div class="actions">
            <button class="btn sm" data-act="want" data-id="${today.id}" data-on="已看过" data-off="标记看过">${state.watched.has(today.id) ? '已看过' : '标记看过'}</button>
            <button class="btn ghost sm" data-act="fav" data-id="${today.id}" data-on="已收藏" data-off="收藏">${state.favorites.has(today.id) ? '已收藏' : '收藏'}</button>
            <button class="btn plain sm" id="reroll">换一部</button>
          </div>
        </div>
      </div>

      ${state.recent.length ? recentSectionHtml() : ''}

      <div class="section-title">
        <h2>入门保险牌</h2>
        <span>评分高、观众多、评价稳，实在不知道看什么就从这里挑</span>
      </div>
      <div class="grid">${safePicks().map((a) => cardHtml(a)).join('')}</div>

      <div class="section-title">
        <h2>最近的优秀新番</h2>
        <span>近两年播出，评分 7.8 以上</span>
      </div>
      <div class="grid">${recentPicks().map((a) => cardHtml(a)).join('')}</div>
    `;

    const reroll = $('#reroll');
    if (reroll) reroll.addEventListener('click', () => {
      state.randomResult = Rec.randomPick(state.catalog, { minScore: 7.6, excludeIds: [today.id] })[0];
      render.home();
    });

    bindGoto();
  };

  /** 三条路线的入口卡片：模式直接写在链接的 ?mode= 里，由路由解析，避免状态与地址栏不一致。 */
  function bindGoto() {
    // 模式由链接里的 ?mode= 决定，这里不需要额外监听
  }

  function pickFeatured() {
    if (!state.randomResult) {
      const day = new Date().toISOString().slice(0, 10);
      // 用日期做种子，保证同一天打开看到同一部
      let seed = 0;
      for (const ch of day) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
      const pool = state.catalog.filter((a) => (a.score || 0) >= 7.8 && a.franchiseRank !== 1 && a.image && !a.supplemental);
      const idx = Math.floor((seed / 100000) * pool.length) % pool.length;
      state.randomResult = { anime: pool[idx] || state.catalog[0] };
    }
    return state.randomResult.anime;
  }

  function recentSectionHtml() {
    const items = state.recent.map(byId).filter(Boolean).slice(0, 6);
    return `<div class="section-title"><h2>最近标记过的</h2><span>点一下就能从这里接着推</span></div>
      <div class="grid">${items.map((a) => cardHtml(a, { showScore: true })).join('')}</div>`;
  }

  /** 入门保险牌：评分与收藏数都靠前，且尽量是系列第一部。 */
  function safePicks(limit = 6) {
    const seen = new Set();
    return state.catalog
      .filter((a) => (a.score || 0) >= 8.2 && (a.members || 0) > 400000 && a.franchiseRank !== 1 && a.image)
      .filter((a) => {
        const key = (a.rawType || '') + (a.studios?.[0] || '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }

  /** 近期新番里评分够高的。 */
  function recentPicks(limit = 6) {
    const since = new Date().getFullYear() - 2;
    return state.catalog
      .filter((a) => (a.year || 0) >= since && (a.score || 0) >= 7.8 && a.franchiseRank !== 1)
      .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.members || 0) - (a.members || 0))
      .slice(0, limit);
  }

  /* ---------------- 推荐页 ---------------- */

  render.pick = function () {
    const mode = state.pick.source;
    app.innerHTML = `
      <div class="page-head">
        <h1>开始推荐</h1>
        <p>三条路随便挑一条，结果不满意可以随时换条件重来。</p>
      </div>
      <div class="radios" id="mode-switch" style="margin-bottom:22px">
        <label class="${mode === 'watched' ? 'on' : ''}"><input type="radio" name="mode" value="watched" ${mode === 'watched' ? 'checked' : ''} /> 按最近看过的番</label>
        <label class="${mode === 'profile' ? 'on' : ''}"><input type="radio" name="mode" value="profile" ${mode === 'profile' ? 'checked' : ''} /> 按口味问卷</label>
        <label class="${mode === 'random' ? 'on' : ''}"><input type="radio" name="mode" value="random" ${mode === 'random' ? 'checked' : ''} /> 随机一部</label>
      </div>
      <div id="pick-body"></div>
    `;

    $('#mode-switch').addEventListener('change', (e) => {
      // 不依赖 event.target：直接读当前被选中的那一个 radio 更稳。
      const fromTarget = e.target && e.target.value;
      const checked = $('#mode-switch input:checked');
      const value = (e.target && e.target.type === 'radio' ? fromTarget : null) || (checked && checked.value);
      if (!['watched', 'profile', 'random'].includes(value)) return;
      state.pick.source = value;
      syncModeHash();
      render.pick();
    });

    const body = $('#pick-body');
    if (mode === 'watched') renderWatchedForm(body);
    else if (mode === 'profile') renderProfileForm(body);
    else renderRandomForm(body);
  };

  /** 让地址栏里的 ?mode= 与当前选择保持一致，刷新/分享链接后还能落回同一条路线。 */
  function syncModeHash() {
    const next = `#/pick?mode=${state.pick.source}`;
    if (location.hash !== next) {
      if (typeof history !== 'undefined' && history.replaceState) history.replaceState(null, '', next);
      else location.hash = next;
    }
    lastHash = next;
  }

  /* --- 路线一：最近看过 --- */

  function renderWatchedForm(body) {
    body.innerHTML = `
      <div class="card">
        <div class="field">
          <label class="title">你看过 / 正在看的番</label>
          <div class="desc">输入中文名、日文名或英文名都行，从下拉里点选。建议 3–6 部，类型杂一点效果更好。</div>
          <div class="search-box">
            <input type="text" id="seed-input" placeholder="例如：葬送的芙莉莲 / 进击的巨人 / Frieren" autocomplete="off" />
            <div class="suggest" id="suggest" hidden></div>
          </div>
          <div class="selected-list" id="seed-list"></div>
        </div>
        <div class="field" style="margin-bottom:14px">
          <label class="title">推荐数量</label>
          <div class="radios" id="count-picker">
            ${[6, 12, 18].map((n) => `<label class="${n === 12 ? 'on' : ''}"><input type="radio" name="count" value="${n}" ${n === 12 ? 'checked' : ''} />${n} 部</label>`).join('')}
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button class="btn" id="run-watched" ${state.pick.seed.length ? '' : 'disabled'}>给我推荐</button>
          <button class="btn plain sm" id="fill-example">填入示例</button>
          ${state.recent.length ? `<button class="btn plain sm" id="use-recent">用最近标记的 ${state.recent.length} 部</button>` : ''}
        </div>
      </div>
      <div id="watched-result"></div>
    `;

    const input = $('#seed-input');
    const suggest = $('#suggest');
    let activeIndex = -1;

    const renderSelected = () => {
      const list = $('#seed-list');
      if (!state.pick.seed.length) {
        list.innerHTML = `<div class="muted small">还没选任何作品。</div>`;
      } else {
        list.innerHTML = state.pick.seed
          .map((id) => {
            const a = byId(id);
            if (!a) return '';
            return `<div class="selected-item">
              <a href="#/detail/${a.id}" data-open="${a.id}">${posterUrl(a, true) ? `<img src="${esc(posterUrl(a, true))}" alt="" />` : ''}</a>
              <span class="name">${esc(displayTitle(a))}<br /><span class="meta">${esc(yearText(a))} · ${esc(tagsPreview(a, 2).join(' / '))}</span></span>
              <button class="icon-btn" data-remove="${a.id}" title="移除">×</button>
            </div>`;
          })
          .join('');
      }
      $('#run-watched').disabled = !state.pick.seed.length;
    };

    renderSelected();

    input.addEventListener('input', () => {
      const q = input.value.trim();
      activeIndex = -1;
      if (q.length < 1) {
        suggest.hidden = true;
        return;
      }
      const hits = Rec.findAnime(state.catalog, q, 8);
      if (!hits.length) {
        suggest.innerHTML = `<button disabled style="cursor:default" class="muted">没有找到匹配的条目，换个写法试试</button>`;
      } else {
        suggest.innerHTML = hits
          .map(
            (a) => `<button data-pick="${a.id}">
              ${posterUrl(a, true) ? `<img src="${esc(posterUrl(a, true))}" alt="" />` : '<span style="width:34px;height:48px;background:var(--pink-soft);border-radius:4px"></span>'}
              <span><span class="s-title">${esc(displayTitle(a))}</span><br /><span class="s-sub">${esc(yearText(a))} · 评分 ${scoreText(a)} · ${esc(tagsPreview(a, 3).join(' / '))}</span></span>
            </button>`
          )
          .join('');
      }
      suggest.hidden = false;
    });

    input.addEventListener('keydown', (e) => {
      const buttons = $$('button[data-pick]', suggest);
      if (!buttons.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons.forEach((b, i) => b.classList.toggle('active', i === activeIndex));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const btn = buttons[Math.max(0, activeIndex)];
        if (btn) addSeed(Number(btn.dataset.pick));
      } else if (e.key === 'Escape') {
        suggest.hidden = true;
      }
    });

    suggest.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-pick]');
      if (btn) addSeed(Number(btn.dataset.pick));
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-box')) suggest.hidden = true;
    });

    function addSeed(id) {
      if (!state.pick.seed.includes(id)) state.pick.seed.push(id);
      input.value = '';
      suggest.hidden = true;
      renderSelected();
    }

    $('#seed-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      state.pick.seed = state.pick.seed.filter((id) => id !== Number(btn.dataset.remove));
      renderSelected();
    });

    $('#count-picker').addEventListener('change', (e) => {
      $$('#count-picker label').forEach((l) => l.classList.toggle('on', l.contains(e.target)));
    });

    $('#fill-example').addEventListener('click', () => {
      const names = ['葬送的芙莉莲', '孤独摇滚', '命运石之门', '来自深渊', '冰海战记', '莉可丽丝'];
      const ids = [];
      for (const n of names) {
        const hit = Rec.findAnime(state.catalog, n, 1)[0];
        if (hit) ids.push(hit.id);
      }
      state.pick.seed = [...new Set([...state.pick.seed, ...ids])];
      renderSelected();
      toast('已填入一组示例');
    });

    const useRecent = $('#use-recent');
    if (useRecent)
      useRecent.addEventListener('click', () => {
        state.pick.seed = [...new Set([...state.pick.seed, ...state.recent])];
        renderSelected();
      });

    $('#run-watched').addEventListener('click', runWatchedRecommend);
  }

  function runWatchedRecommend() {
    const target = $('#watched-result');
    if (!target) return;
    const limit = Number($('input[name="count"]:checked')?.value || 12);
    target.innerHTML = `<div class="section-title"><h2>按口味给你的推荐</h2><span><span class="spinner"></span>正在比对 ${state.pick.seed.length} 部作品</span></div>`;
    setTimeout(() => {
      const results = Rec.recommendFromWatched(state.catalog, state.pick.seed, { limit });
      const seedNames = state.pick.seed.map(byId).filter(Boolean).map(displayTitle);
      target.innerHTML = `
        <div class="section-title">
          <h2>按口味给你的推荐</h2>
          <span>依据：${esc(seedNames.join('、'))}</span>
        </div>
        <div class="radios" style="margin-bottom:14px">
          <button class="btn plain sm" id="again-watched">换一批</button>
        </div>
        ${gridHtml(results)}
      `;
      const again = $('#again-watched');
      if (again)
        again.addEventListener('click', () => {
          // 打乱同分区间，换一批观感上不同的结果
          const shuffled = Rec.recommendFromWatched(state.catalog, state.pick.seed, { limit: limit * 3 });
          const picked = shuffled.filter((_, i) => i % 3 === Math.floor(Math.random() * 3)).slice(0, limit);
          const grid = target.querySelector('.grid');
          const next = gridHtml(picked.length ? picked : results);
          if (grid) grid.outerHTML = next;
          else target.insertAdjacentHTML('beforeend', next);
        });
    }, 20);
  }

  /* --- 路线二：口味问卷 --- */

  const NOTICE_TAGS = [
    '治愈', '日常', '搞笑', '悬疑', '剧情', '恋爱', '动作', '奇幻', '科幻', '运动',
    '音乐', '校园', '异世界', '历史', '机甲', '心理', '美食', '冒险', '偶像', '职场',
    '催泪', '治愈系少女', '超能力', '军事', '侦探', '生存', '青春', '百合', '后宫', '惊悚',
  ];

  function renderProfileForm(body) {
    const p = state.profile;
    const tagCount = new Map(Rec.allTags(state.catalog).map((t) => [t.tag, t.count]));
    const extra = Rec.allTags(state.catalog)
      .map((t) => t.tag)
      .filter((t) => !NOTICE_TAGS.includes(t))
      .slice(0, 12);
    const tags = [...NOTICE_TAGS.filter((t) => tagCount.has(t)), ...extra];

    body.innerHTML = `
      <div class="card">
        <div class="field">
          <label class="title">喜欢 / 常看的类型（可多选，选 3–6 个最准）</label>
          <div class="desc">括号里是库里这一类作品的数量。</div>
          <div class="tag-picker" id="tag-picker">
            ${tags
              .map(
                (t) => `<button data-tag="${esc(t)}" class="${p.tags.includes(t) ? 'on' : ''}">${esc(t)}<span class="n">${tagCount.get(t) || 0}</span></button>`
              )
              .join('')}
          </div>
        </div>

        <div class="field">
          <label class="title">今晚想要的感觉（可选，最多两个）</label>
          <div class="desc">心情权重比类型更高，会直接压过部分类型偏好。</div>
          <div class="tag-picker" id="mood-picker">
            ${Rec.MOODS.map(
              (m) => `<button data-mood="${m.id}" class="${p.moods.includes(m.id) ? 'on' : ''}">${esc(m.label)}<span class="n">${esc(m.hint)}</span></button>`
            ).join('')}
          </div>
        </div>

        <div class="field">
          <label class="title">年代</label>
          <div class="radios" id="era-picker">
            <label class="${!p.era ? 'on' : ''}"><input type="radio" name="era" value="" ${!p.era ? 'checked' : ''} />不限</label>
            ${Rec.ERAS.map((e) => `<label class="${p.era === e.id ? 'on' : ''}"><input type="radio" name="era" value="${e.id}" ${p.era === e.id ? 'checked' : ''} />${esc(e.label)}</label>`).join('')}
          </div>
        </div>

        <div class="field">
          <label class="title">打算投入多少时间</label>
          <div class="radios" id="length-picker">
            <label class="${!p.length ? 'on' : ''}"><input type="radio" name="length" value="" ${!p.length ? 'checked' : ''} />都行</label>
            ${Rec.LENGTHS.map((l) => `<label class="${p.length === l.id ? 'on' : ''}"><input type="radio" name="length" value="${l.id}" ${p.length === l.id ? 'checked' : ''} />${esc(l.label)}</label>`).join('')}
          </div>
        </div>

        <div class="field">
          <label class="title">形式与最低评分</label>
          <div class="radios" id="format-picker" style="margin-bottom:10px">
            <label class="${p.format === 'any' ? 'on' : ''}"><input type="radio" name="format" value="any" ${p.format === 'any' ? 'checked' : ''} />不限</label>
            <label class="${p.format === 'tv' ? 'on' : ''}"><input type="radio" name="format" value="tv" ${p.format === 'tv' ? 'checked' : ''} />只推 TV 动画</label>
            <label class="${p.format === 'movie' ? 'on' : ''}"><input type="radio" name="format" value="movie" ${p.format === 'movie' ? 'checked' : ''} />只推剧场版</label>
          </div>
          <div class="radios" id="score-picker">
            ${[
              [7.0, '7.0 以上'],
              [7.3, '7.3 以上'],
              [7.8, '7.8 以上'],
              [8.2, '8.2 以上（只挑神作）'],
            ]
              .map(([v, label]) => `<label class="${Number(p.minScore) === v ? 'on' : ''}"><input type="radio" name="minScore" value="${v}" ${Number(p.minScore) === v ? 'checked' : ''} />${label}</label>`)
              .join('')}
          </div>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button class="btn" id="run-profile">按这个口味推荐</button>
          <button class="btn plain sm" id="reset-profile">重置偏好</button>
          <span class="muted small">偏好会记在本地，下次打开还在</span>
        </div>
      </div>
      <div id="profile-result"></div>
    `;

    /** 单选项组：选中态直接跟着 input.checked 走，不依赖事件目标。 */
    const syncRadios = (container) => {
      container.addEventListener('change', () => {
        $$('label', container).forEach((l) => l.classList.toggle('on', !!l.querySelector('input')?.checked));
      });
    };
    $$('.radios').forEach(syncRadios);

    $('#tag-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tag]');
      if (!btn) return;
      const t = btn.dataset.tag;
      if (p.tags.includes(t)) p.tags = p.tags.filter((x) => x !== t);
      else p.tags.push(t);
      btn.classList.toggle('on');
      persist();
    });

    $('#mood-picker').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mood]');
      if (!btn) return;
      const id = btn.dataset.mood;
      if (p.moods.includes(id)) p.moods = p.moods.filter((x) => x !== id);
      else if (p.moods.length < 2) p.moods.push(id);
      else {
        toast('心情最多选两个');
        return;
      }
      btn.classList.toggle('on');
      persist();
    });

    body.addEventListener('change', (e) => {
      const name = e.target.name;
      if (!name) return;
      if (name === 'era') p.era = e.target.value;
      else if (name === 'length') p.length = e.target.value;
      else if (name === 'format') p.format = e.target.value;
      else if (name === 'minScore') p.minScore = Number(e.target.value);
      persist();
    });

    $('#run-profile').addEventListener('click', () => {
      const target = $('#profile-result');
      target.innerHTML = `<div class="section-title"><h2>按口味挑的番</h2><span><span class="spinner"></span>筛选中</span></div>`;
      setTimeout(() => {
        if (!p.tags.length && !p.moods.length) toast('没选类型也没选心情，那就按高分推荐了');
        const base = { ...p, excludeIds: [...state.watched] };
        let results = Rec.recommendFromProfile(state.catalog, base, { limit: 12 });
        let relaxed = '';
        // 条件太紧就按顺序放宽：形式 → 年代 → 集数，保证总有东西可看
        if (!results.length && base.format !== 'any') {
          results = Rec.recommendFromProfile(state.catalog, { ...base, format: 'any' }, { limit: 12 });
          relaxed = '这个组合下没有剧场版，已把「形式」放宽';
        }
        if (!results.length && base.era) {
          results = Rec.recommendFromProfile(state.catalog, { ...base, format: 'any', era: '' }, { limit: 12 });
          relaxed = '这个年代里没有合适的，已把「年代」放宽';
        }
        if (!results.length && base.length) {
          results = Rec.recommendFromProfile(state.catalog, { ...base, format: 'any', era: '', length: '' }, { limit: 12 });
          relaxed = '这个集数区间太窄，已把「时长」放宽';
        }
        if (!results.length && Number(base.minScore) > 7) {
          results = Rec.recommendFromProfile(state.catalog, { ...base, format: 'any', era: '', length: '', minScore: 7 }, { limit: 12 });
          relaxed = '高分作品不够，已把最低评分降到 7.0';
        }
        if (relaxed) toast(relaxed);
        const desc = [
          p.tags.length ? `类型：${p.tags.join('、')}` : null,
          p.moods.length ? `心情：${p.moods.map((m) => Rec.MOODS.find((x) => x.id === m)?.label).join('、')}` : null,
          p.era ? `年代：${Rec.ERAS.find((e) => e.id === p.era)?.label}` : null,
          p.length ? `长度：${Rec.LENGTHS.find((l) => l.id === p.length)?.label}` : null,
          `最低评分 ${Number(p.minScore).toFixed(1)}`,
        ].filter(Boolean);
        target.innerHTML = `
          <div class="section-title"><h2>按口味挑的番</h2><span>${esc(desc.join(' · '))}</span></div>
          ${relaxed ? `<div class="note" style="margin-bottom:14px">${esc(relaxed)}</div>` : ''}
          <div style="margin-bottom:14px"><button class="btn plain sm" id="again-profile">换一批</button></div>
          ${gridHtml(results)}
        `;
        $('#again-profile')?.addEventListener('click', () => {
          const wide = Rec.recommendFromProfile(state.catalog, { ...p, excludeIds: [...state.watched] }, { limit: 60 });
          const shifted = wide.slice(Math.floor(Math.random() * Math.min(12, wide.length))).slice(0, 12);
          const grid = $('#profile-result').querySelector('.grid');
          const next = gridHtml(shifted.length ? shifted : results);
          if (grid) grid.outerHTML = next;
          else $('#profile-result').insertAdjacentHTML('beforeend', next);
        });
      }, 20);
    });

    $('#reset-profile').addEventListener('click', () => {
      state.profile = { tags: [], moods: [], era: '', length: '', minScore: 7.3, format: 'any' };
      persist();
      render.pick();
      toast('偏好已重置');
    });
  }

  /* --- 路线三：随机 --- */

  function renderRandomForm(body) {
    body.innerHTML = `
      <div class="card">
        <div class="field">
          <label class="title">随机范围</label>
          <div class="desc">默认只从评分 7.6 以上、且是系列第一部的作品里抽，避免一上来抽到第 4 季。</div>
          <div class="radios" id="random-mood" style="margin-bottom:10px">
            <label class="on"><input type="radio" name="rmood" value="" checked />不限类型</label>
            ${Rec.MOODS.map((m) => `<label><input type="radio" name="rmood" value="${m.id}" />${esc(m.label)}</label>`).join('')}
          </div>
          <div class="radios" id="random-min">
            ${[
              [7.0, '7.0 以上'],
              [7.6, '7.6 以上'],
              [8.0, '8.0 以上'],
              [8.5, '8.5 以上'],
            ]
              .map(([v, l]) => `<label class="${v === 7.6 ? 'on' : ''}"><input type="radio" name="rmin" value="${v}" ${v === 7.6 ? 'checked' : ''} />${l}</label>`)
              .join('')}
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <button class="btn" id="run-random">抽一部</button>
          <span class="muted small">不满意就再抽，反正不要钱</span>
        </div>
      </div>
      <div id="random-result"></div>
    `;

    $$('.radios').forEach((container) =>
      container.addEventListener('change', () => {
        $$('label', container).forEach((l) => l.classList.toggle('on', !!l.querySelector('input')?.checked));
      })
    );

    const draw = () => {
      const mood = $('input[name="rmood"]:checked')?.value || '';
      const minScore = Number($('input[name="rmin"]:checked')?.value || 7.6);
      const exclude = state.randomResult ? [state.randomResult.anime.id] : [];
      const picked = Rec.randomPick(state.catalog, { minScore, mood, excludeIds: exclude })[0];
      if (!picked) {
        $('#random-result').innerHTML = `<div class="empty">这个范围里没有可选的作品，放宽一点试试。</div>`;
        return;
      }
      state.randomResult = picked;
      renderRandomResult();
    };

    $('#run-random').addEventListener('click', draw);
    if (state.randomResult) renderRandomResult();
  }

  function renderRandomResult() {
    const entry = state.randomResult;
    if (!entry) return;
    const a = entry.anime;
    $('#random-result').innerHTML = `
      <div class="section-title"><h2>抽到的这一部</h2><span>${esc(entry.reason)}</span></div>
      <div class="card today">
        <a href="#/detail/${a.id}" data-open="${a.id}">${posterHtml(a)}</a>
        <div class="today-body">
          <h3>${esc(displayTitle(a))}</h3>
          <div class="chips" style="margin-top:6px">${(a.genres || []).slice(0, 5).map((t) => `<span class="chip pink">${esc(t)}</span>`).join('')}</div>
          <div class="small muted" style="margin-top:8px">评分 ${scoreText(a)} · ${esc(seasonLabel(a))} · ${esc(a.type || 'TV')}${a.episodes ? ` · ${a.episodes} 集` : ''} · ${esc(a.studios?.[0] || '制作公司未知')}</div>
          <p class="small" style="color:var(--ink-2);margin-top:8px">${esc(a.lead || '')}</p>
          <div class="actions">
            <button class="btn sm" id="draw-again">再抽一部</button>
            <button class="btn ghost sm" data-act="want" data-id="${a.id}">${state.watched.has(a.id) ? '已看过' : '标记看过'}</button>
            <button class="btn plain sm" data-act="similar" data-id="${a.id}">按这部推</button>
          </div>
        </div>
      </div>
    `;
    $('#draw-again').addEventListener('click', () => {
      const mood = $('input[name="rmood"]:checked')?.value || '';
      const minScore = Number($('input[name="rmin"]:checked')?.value || 7.6);
      const exclude = [...(state.randomResult ? [state.randomResult.anime.id] : [])];
      const picked = Rec.randomPick(state.catalog, { minScore, mood, excludeIds: exclude, count: 1 })[0];
      if (picked) {
        state.randomResult = picked;
        renderRandomResult();
      }
    });
  }

  /* ---------------- 浏览页 ---------------- */

  render.browse = function () {
    const tags = Rec.allTags(state.catalog).slice(0, 26);
    const b = state.browse;
    app.innerHTML = `
      <div class="page-head">
        <h1>全部番剧</h1>
        <p>
          收录 ${state.catalog.length}${state.shards ? ' / ' + (state.meta?.count ?? '…') : ''} 部，年份跨度 ${yearSpan()}。
          评分低于 6.2 的作品没有收录。
          ${state.shards && state.shards.loaded < state.shards.total ? '（完整目录还在后台加载：' + state.shards.loaded + '/' + state.shards.total + ' 片）' : ''}
        </p>
      </div>
      <div class="toolbar">
        <input type="text" id="browse-q" class="grow" placeholder="搜作品名或类型标签" value="${esc(b.q)}" style="border:1px solid var(--line-2);border-radius:8px;padding:8px 12px;font-family:inherit;font-size:14px" />
        <select id="browse-genre">
          <option value="">全部类型</option>
          ${tags.map((t) => `<option value="${esc(t.tag)}" ${b.genre === t.tag ? 'selected' : ''}>${esc(t.tag)}（${t.count}）</option>`).join('')}
        </select>
        <select id="browse-era">
          <option value="">全部年代</option>
          ${Rec.ERAS.map((e) => `<option value="${e.id}" ${b.era === e.id ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}
        </select>
        <select id="browse-type">
          <option value="any" ${b.type === 'any' ? 'selected' : ''}>全部形式</option>
          <option value="tv" ${b.type === 'tv' ? 'selected' : ''}>TV 动画</option>
          <option value="movie" ${b.type === 'movie' ? 'selected' : ''}>剧场版</option>
        </select>
        <select id="browse-score">
          <option value="0" ${!b.minScore ? 'selected' : ''}>不限评分</option>
          <option value="7" ${b.minScore === 7 ? 'selected' : ''}>7.0 以上</option>
          <option value="7.5" ${b.minScore === 7.5 ? 'selected' : ''}>7.5 以上</option>
          <option value="8" ${b.minScore === 8 ? 'selected' : ''}>8.0 以上</option>
        </select>
        <select id="browse-sort">
          <option value="heat" ${b.sort === 'heat' ? 'selected' : ''}>按热度</option>
          <option value="score" ${b.sort === 'score' ? 'selected' : ''}>按评分</option>
          <option value="new" ${b.sort === 'new' ? 'selected' : ''}>最新年份</option>
          <option value="old" ${b.sort === 'old' ? 'selected' : ''}>最老年份</option>
        </select>
        <button class="btn plain sm" id="browse-clear">清空条件</button>
      </div>
      <div id="browse-list"></div>
    `;

    const list = $('#browse-list');
    const renderList = () => {
      const filtered = Rec.queryCatalog(state.catalog, b);
      const slice = filtered.slice(0, b.shown);
      list.innerHTML = filtered.length
        ? `<div class="muted small" style="margin-bottom:12px">共 ${filtered.length} 部，已显示 ${slice.length} 部</div>
           <div class="grid">${slice.map((a) => cardHtml(a)).join('')}</div>
           ${filtered.length > slice.length ? `<div style="text-align:center;margin-top:24px"><button class="btn plain" id="load-more">再看 ${Math.min(36, filtered.length - slice.length)} 部</button></div>` : ''}`
        : `<div class="empty">没有符合条件的作品，换个筛选条件看看。</div>`;
      $('#load-more')?.addEventListener('click', () => {
        b.shown += 36;
        renderList();
      });
    };
    renderList();

    const rerender = () => {
      b.shown = 36;
      renderList();
    };

    $('#browse-q').addEventListener('input', (e) => {
      b.q = e.target.value;
      rerender();
    });
    for (const [id, key] of [
      ['#browse-genre', 'genre'],
      ['#browse-era', 'era'],
      ['#browse-type', 'type'],
      ['#browse-sort', 'sort'],
    ]) {
      $(id).addEventListener('change', (e) => {
        b[key] = e.target.value;
        rerender();
      });
    }
    $('#browse-score').addEventListener('change', (e) => {
      b.minScore = Number(e.target.value);
      rerender();
    });
    $('#browse-clear').addEventListener('click', () => {
      state.browse = { q: '', genre: '', era: '', sort: 'heat', minScore: 0, type: 'any', shown: 36 };
      render.browse();
    });
  };

  /* ---------------- 关于页 ---------------- */

  render.about = function () {
    const meta = state.meta || {};
    const favs = [...state.favorites].map(byId).filter(Boolean);
    app.innerHTML = `
      <div class="page-head">
        <h1>关于这个站</h1>
        <p>一个只解决一件事的小工具：帮不知道下一部看什么的人，随便选出几部值得看的番。</p>
      </div>
      <div class="card">
        <h3 style="font-size:15px">推荐是怎么算的</h3>
        <ul class="list-plain" style="margin-top:8px">
          <li>把你所选作品的类型/主题标签、制作公司、年代整理成一个带权重的「口味画像」。</li>
          <li>每部候选番也展开成同样的标签向量，算加权余弦相似度，再叠加评分、热度、年代贴合度。</li>
          <li>同系列续作会被降权，避免一上来就推第三季；如果你看过前作，续作会反过来加权。</li>
          <li>结果排序会做一次轻度打散，免得满屏都是同一种类型。</li>
          <li>随机模式按评分的三次方加权抽取，神作概率高，但冷门佳作依然有机会出现。</li>
        </ul>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="font-size:15px">卡片上那个分数是什么</h3>
        <ul class="list-plain" style="margin-top:8px">
          <li><b>A（粉色）是 AniList 均分</b>：原值 0–100，这里除以 10 显示成 10 分制；
            它是 AniList 用户打分的平均值。</li>
          <li><b>B（灰蓝）是 Bangumi 评分</b>：来自 <a href="https://bgm.tv" target="_blank" rel="noreferrer noopener">bgm.tv</a>
            官方 API，当前收录 ${meta.bangumi?.scored ?? state.catalog.filter((a) => a.bangumi?.score).length} 条，
            其中 ${meta.bangumi?.ranked ?? state.catalog.filter((a) => a.bangumi?.rank).length} 条带排名。</li>
          <li>两套评分互相独立，数值经常差 0.5 分以上（例如《东京喰种》AniList 7.4 / Bangumi 6.8），
            并列显示是为了让你自己判断，不是取平均。</li>
          <li>鼠标停在角标上可以看到两边的原始数据（评分人数、收藏数、bgm 排名）。
            想只看一边，用下面的「评分来源」切换。</li>
          <li>推荐排序用的是 AniList 的评分（72%）＋热度（18%）＋收藏数（10%）合成的口碑值，
            再叠加口味相似度 —— 所以列表头部不一定是分数最高的那几部。</li>
        </ul>
        <div class="syn-switch" style="margin-top:12px">
          ${RATINGS.map(
            (r) => `<button class="loc-btn ${state.rating === r.id ? 'on' : ''}" data-rating="${r.id}" data-rating-pref="${r.id}">${r.label}</button>`
          ).join('')}
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="font-size:15px">数据来源</h3>
        <ul class="list-plain" style="margin-top:8px">
          <li>条目、评分、类型与主题标签、英文简介、海报、集数与制作公司：<b>AniList GraphQL API</b>（按评分倒序扫全库收录）。</li>
          <li>Bangumi 评分、排名、中文名与官方中文简介：<b>api.bgm.tv</b>（离线抓取后随站点一起发布，静态版不再实时请求）。</li>
          <li>中文标题与 Bangumi 条目链接：bangumi-data 社区索引，点击详情里的「Bangumi 条目」可直达 bgm.tv。</li>
          <li><b>中文简介</b>：优先用 Bangumi 官方简介（${meta.synopsisZh?.fromBangumi ?? state.catalog.filter((a) => a.synopsisZhSource === 'bangumi').length} 条），
            没有的再用 <a href="https://zh.moegirl.org.cn" target="_blank" rel="noreferrer noopener">萌娘百科</a>
            （${meta.synopsisZh?.fromMoegirl ?? state.catalog.filter((a) => a.synopsisZhSource === 'moegirl').length} 条，CC BY-NC-SA 3.0 CN）。
            同系列续作没有独立条目时，会沿用本篇的中文简介并在页面上注明。</li>
          <li>数据集构建时间：${esc(meta.generatedAt ? new Date(meta.generatedAt).toLocaleString('zh-CN') : '未知')}，共 ${state.catalog.length} 部。</li>
        </ul>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="font-size:15px">简介语言</h3>
        <p class="small muted" style="margin-top:6px">详情页的简介按这里的设置显示。中文来源缺这条时会照实说明，并回落到英文原文。</p>
        <div class="syn-switch" style="margin-top:10px">
          ${LOCALES.map(
            (l) => `<button class="loc-btn ${state.locale === l.id ? 'on' : ''}" data-locale="${l.id}" data-locale-pref="${l.id}">${l.label}</button>`
          ).join('')}
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <h3 style="font-size:15px">你的数据</h3>
        <p class="small muted" style="margin-top:6px">最近看过 ${state.recent.length} 部 · 标记看过 ${state.watched.size} 部 · 收藏 ${state.favorites.size} 部，全部保存在浏览器 localStorage 中。</p>
        <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn plain sm" id="clear-recent">清空「最近看过」</button>
          <button class="btn plain sm" id="clear-watched">清空「标记看过」</button>
          <button class="btn plain sm" id="clear-all">全部清空</button>
        </div>
      </div>
      ${favs.length ? `<div class="section-title"><h2>我的收藏</h2><span>${favs.length} 部</span></div><div class="grid">${favs.map((a) => cardHtml(a)).join('')}</div>` : ''}
    `;
    const clear = (key) => {
      if (key === 'recent') state.recent = [];
      if (key === 'watched') state.watched = new Set();
      if (key === 'all') {
        state.recent = [];
        state.watched = new Set();
        state.favorites = new Set();
        state.profile = { tags: [], moods: [], era: '', length: '', minScore: 7.3, format: 'any' };
      }
      persist();
      render.about();
      toast('已清空');
    };
    $('#clear-recent').addEventListener('click', () => clear('recent'));
    $('#clear-watched').addEventListener('click', () => clear('watched'));
    $('#clear-all').addEventListener('click', () => clear('all'));
  };

  /* ---------------- 详情 ---------------- */

  function renderDetail(id) {
    const a = byId(id);
    if (!a) {
      app.innerHTML = `<div class="empty">找不到这部作品。<a href="#/browse" data-link>去全部番剧里找找</a></div>`;
      return;
    }
    const similar = Rec.recommendFromWatched(state.catalog, [a], { limit: 6 });
    app.innerHTML = `
      <p class="small" style="margin-bottom:14px"><a href="#/browse" data-link>← 回到全部番剧</a></p>
      <div class="card">
        <div class="detail">
          ${posterHtml(a, { showScore: false })}
          <div>
            <h2>${esc(displayTitle(a))}</h2>
            <div class="jp">${esc(altTitleLine(a))}</div>
            <div class="meta">
              <span title="${esc(scoreTip(a))}" class="${state.rating === 'bangumi' ? 'muted' : ''}">
                <b>${scoreText(a)}</b> 分<span class="muted">（AniList${a.members ? ` · ${a.members.toLocaleString('zh-CN')} 人标记` : ''}）</span>
              </span>
              ${
                a.bangumi?.score
                  ? `<span title="${esc(scoreTip(a))}" class="${state.rating === 'anilist' ? 'muted' : ''}">
                      <b>${a.bangumi.score.toFixed(1)}</b> 分<span class="muted">（Bangumi${a.bangumi.total ? ` · ${a.bangumi.total.toLocaleString('zh-CN')} 人评分` : ''}${a.bangumi.rank ? ` · 排名 #${a.bangumi.rank}` : ''}）</span>
                    </span>`
                  : ''
              }
              <span>${esc(seasonLabel(a))}</span>
              <span>${esc(a.type || 'TV')}${a.episodes ? ` · ${a.episodes} 集` : ''}</span>
              ${a.duration ? `<span>${esc(a.duration)}</span>` : ''}
              ${a.studios?.length ? `<span>${esc(a.studios.join('、'))}</span>` : ''}
            </div>
            <div class="chips">${(a.genres || []).map((t) => `<span class="chip pink">${esc(t)}</span>`).join('')}
              ${(a.demographics || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
            ${a.supplemental ? `<div class="note" style="margin-top:12px">这部在 AniList 上只有 ${scoreText(a)} 分，低于收录门槛，是为了「搜得到」才留在目录里的，不会出现在推荐结果中。</div>` : ''}
            ${synopsisHtml(a)}
            <div class="links">
              <a href="${esc(a.malUrl)}" target="_blank" rel="noreferrer noopener">MyAnimeList 条目</a>
              ${a.bangumiUrl ? `<a href="${esc(a.bangumiUrl)}" target="_blank" rel="noreferrer noopener">Bangumi 条目</a>` : ''}
              ${a.trailer ? `<a href="https://www.youtube.com/watch?v=${esc(a.trailer)}" target="_blank" rel="noreferrer noopener">预告片</a>` : ''}
            </div>
            <div class="actions">
              <button class="btn sm" data-act="want" data-id="${a.id}" data-on="已看过，取消标记" data-off="标记为看过">${state.watched.has(a.id) ? '已看过，取消标记' : '标记为看过'}</button>
              <button class="btn ghost sm" data-act="fav" data-id="${a.id}" data-on="取消收藏" data-off="加入收藏">${state.favorites.has(a.id) ? '取消收藏' : '加入收藏'}</button>
              <button class="btn plain sm" data-act="similar" data-id="${a.id}">按这部继续推</button>
            </div>
          </div>
        </div>
      </div>
      ${similar.length ? `<div class="section-title"><h2>和这部口味接近的</h2><span>按标签相似度排序</span></div><div class="grid">${similar.map((e) => cardHtml(e)).join('')}</div>` : ''}
    `;
  }

  /* ---------------- 弹层（从卡片快速查看） ---------------- */

  function openDetail(id) {
    const a = byId(id);
    if (!a) return;
    modal.dataset.id = id;
    modal.hidden = false;
    modal.innerHTML = `
      <div class="modal-panel">
        <button class="modal-close" data-close>×</button>
        <div class="detail">
          ${posterHtml(a, { showScore: false })}
          <div>
            <h2>${esc(displayTitle(a))}</h2>
            <div class="jp">${esc(altTitleLine(a))}</div>
            <div class="meta">
              <span><b>${scoreText(a)}</b> 分<span class="muted">（AniList）</span></span>
              ${a.bangumi?.score ? `<span><b>${a.bangumi.score.toFixed(1)}</b> 分<span class="muted">（Bangumi${a.bangumi.rank ? ` · 排名 #${a.bangumi.rank}` : ''}）</span></span>` : ''}
              <span>${esc(seasonLabel(a))}</span>
              <span>${esc(a.type || 'TV')}${a.episodes ? ` · ${a.episodes} 集` : ''}</span>
              ${a.studios?.length ? `<span>${esc(a.studios.join('、'))}</span>` : ''}
            </div>
            <div class="chips">${(a.genres || []).map((t) => `<span class="chip pink">${esc(t)}</span>`).join('')}</div>
            ${synopsisHtml(a, { compact: true })}
            <div class="links">
              <a href="#/detail/${a.id}" data-link data-goto-detail="${a.id}">查看完整条目 →</a>
              ${a.bangumiUrl ? `<a href="${esc(a.bangumiUrl)}" target="_blank" rel="noreferrer noopener">Bangumi</a>` : ''}
            </div>
            <div class="actions">
              <button class="btn sm" data-act="want" data-id="${a.id}">${state.watched.has(a.id) ? '已看过' : '标记看过'}</button>
              <button class="btn ghost sm" data-act="fav" data-id="${a.id}">${state.favorites.has(a.id) ? '已收藏' : '收藏'}</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) {
      modal.hidden = true;
      modal.innerHTML = '';
      return;
    }
    const jump = e.target.closest('[data-goto-detail]');
    if (jump) {
      modal.hidden = true;
      modal.innerHTML = '';
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) {
      modal.hidden = true;
      modal.innerHTML = '';
    }
  });

  /* ---------------- 启动 ---------------- */

  $('.brand').addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = '#/';
  });

  /** 数据集读不到时的提示：区分「用本地服务打开」和「服务挂了」两种情况。 */
  function loadFailureHtml(err, fileMode) {
    const hint = fileMode
      ? '这个页面需要通过本地服务打开：在项目目录执行 <code>node server.js</code>，然后访问 <b>http://127.0.0.1:8787</b> 。'
      : '请确认服务端仍在运行（<code>node server.js</code>），并且 <code>public/data/anime.json</code> 存在。';
    return `<div class="empty">数据集没能载入（${esc(err.message)}）。<br />${hint}</div>`;
  }

  async function boot() {
    render.boot();
    try {
      const res = await fetch('data/index.json');
      const data = await res.json();
      if (Array.isArray(data.items)) {
        state.catalog = data.items;
        state.catalogMap = new Map(state.catalog.map((a) => [a.id, a]));
        state.meta = data;
      } else {
        // 静态版：index.json + core.json + 分片（index 已经拉过了，直接传进去省一次请求）
        await loadCatalogProgressive(data);
      }
    } catch (err) {
      app.innerHTML = loadFailureHtml(err, location.protocol === 'file:');
      return;
    }
    // 过滤掉已经失效的本地记录
    state.recent = state.recent.filter((id) => byId(id));
    state.watched = new Set([...state.watched].filter((id) => byId(id)));
    state.favorites = new Set([...state.favorites].filter((id) => byId(id)));

    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const mode = params.get('mode');
    if (mode && ['watched', 'profile', 'random'].includes(mode)) state.pick.source = mode;

    navigate();
    // 预热：首页的「今天先看这部」
    
  }

  boot();
})();
