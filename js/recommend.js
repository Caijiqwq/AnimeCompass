/**
 * 番剧推荐引擎（浏览器 / Node 通用）。
 *
 * 核心思路：
 *   1. 把「你看过的番」或「你勾选的偏好」压缩成一个带权重的标签口味画像；
 *   2. 每个候选番也展开成同样的标签向量；
 *   3. 用加权余弦相似度算口味接近程度，再叠加上「口碑」「热度」「年代贴合」，
 *      并扣掉「同系列续作」和「已经看过」的重复推荐；
 *   4. 给每条结果生成一句人话理由。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AnimeRec = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DIM = { GENRE: 'g', THEME: 't', DEMO: 'd', STUDIO: 's', YEAR: 'y', LENGTH: 'l' };
  const WEIGHT = { g: 1.0, t: 0.95, d: 0.4, s: 0.5, y: 0.5, l: 0.2 };
  const EPS = 0.35; // 画像向量的平滑项，避免小样本导致相似度失控

  /**
   * 这些标签几乎人人都有（主角性别、受众定位之类），
   * 拿来做「口味画像」只会把相似度抹平，所以在计算偏好时忽略，
   * 但仍然会在卡片上展示。
   */
  const NOT_TASTE = new Set([
    '男主角', '女主角', '男性主角', '女性主角', '男性配角', '女性配角',
    '群像', '少年向', '青年向', '少女向', '女性向', '子供向', '成人向',
    '异性恋', '同性恋', 'BL', '百合', '全员主角', '动物主角', '儿童主角',
    '少年主角', '成人主角', '老年主角', '拟人', '拟人化',
  ]);

  const ERAS = [
    { id: 'recent', label: '近三年新番', from: new Date().getFullYear() - 2, to: 9999 },
    { id: '2010s', label: '2010–2019', from: 2010, to: 2019 },
    { id: '2000s', label: '2000–2009', from: 2000, to: 2009 },
    { id: 'classic', label: '上世纪经典', from: 1900, to: 1999 },
  ];

  const MOODS = [
    {
      id: 'healing',
      label: '治愈放松',
      hint: '睡前看，不费脑子',
      boost: { 日常: 1.6, 治愈: 1.8, 治愈系少女: 1.2, 恋爱: 0.5, 音乐: 0.4, 搞笑: 0.5 },
      damp: { 恐怖: 1.4, 血腥: 1.4, 惊悚: 1.2, 心理: 0.6, 生存: 0.6 },
    },
    {
      id: 'hype',
      label: '热血上头',
      hint: '看得想站起来',
      boost: { 动作: 1.7, 战斗: 1.5, 超能力: 1.2, 运动: 1.1, 冒险: 0.8, 团队竞技: 0.8, 机甲: 0.7 },
      damp: { 日常: 0.4, 治愈: 0.3 },
    },
    {
      id: 'brain',
      label: '烧脑推理',
      hint: '愿意停下来想',
      boost: { 悬疑: 1.8, 心理: 1.5, 惊悚: 1.1, 侦探: 1.3, 智斗游戏: 1.4, 科幻: 0.9, 时间旅行: 1.0, 剧情: 0.5 },
      damp: { 搞笑: 0.4, 后宫: 0.4 },
    },
    {
      id: 'heart',
      label: '想被戳一下',
      hint: '哭一场也行',
      boost: { 剧情: 1.7, 恋爱: 1.3, 青春: 1.2, 音乐: 1.0, 校园: 0.7, 女性向: 0.6, 舞台艺术: 0.6 },
      damp: { 后宫: 0.5, 擦边: 0.6 },
    },
    {
      id: 'laugh',
      label: '只想笑',
      hint: '不想动情绪',
      boost: { 搞笑: 1.9, 无厘头: 1.5, 恶搞: 1.4, 日常: 1.0, 宅文化: 0.9, 喜剧: 1.2 },
      damp: { 恐怖: 1.2, 血腥: 1.1, 剧情: 0.5 },
    },
    {
      id: 'world',
      label: '换一个世界',
      hint: '设定越怪越好',
      boost: { 奇幻: 1.5, 科幻: 1.4, 异世界: 1.6, 冒险: 1.1, 神话: 0.9, 宇宙: 0.8, 转生: 1.0 },
      damp: { 日常: 0.6 },
    },
  ];

  const LENGTHS = [
    { id: 'short', label: '12 集左右，一次能看完', test: (a) => (a.episodes ?? 12) <= 14 },
    { id: 'mid', label: '半年番，24 集上下', test: (a) => (a.episodes ?? 0) > 14 && (a.episodes ?? 0) <= 30 },
    { id: 'long', label: '长连载，够看很久', test: (a) => (a.episodes ?? 0) > 30 },
  ];

  /* ---------------------------------------------------------------- */
  /* 工具                                                              */
  /* ---------------------------------------------------------------- */

  function normalizeTitle(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[!！?？。.,，、·:：;；'"“”‘’()（）\[\]【】~～\-—_\s]/g, '')
      .trim();
  }

  /** 参与搜索与展示的所有称呼（含中文短别名与常见另译名）。 */
  function titles(a) {
    return [a.title, a.titleCn, a.titleEn, a.shortName, ...(a.aliases || [])].filter(Boolean);
  }

  /** 把「的 / 某」这类虚词去掉，让《某科学的超电磁炮》也能命中「科学超电磁炮」。 */
  function looseTitle(s) {
    return normalizeTitle(s).replace(/的|之/g, '').replace(/^某/, '');
  }

  /** 模糊匹配一部作品：精确 > 前缀 > 包含。 */
  function matchScore(query, a) {
    const q = normalizeTitle(query);
    const loose = looseTitle(query);
    if (q.length < 2) return 0;
    let best = 0;
    for (const t of titles(a)) {
      const n = normalizeTitle(t);
      if (!n) continue;
      const ln = looseTitle(t);
      if (n === q) best = Math.max(best, 1);
      else if (n.startsWith(q) || q.startsWith(n)) best = Math.max(best, 0.85);
      else if (n.includes(q)) best = Math.max(best, 0.7);
      else if (q.length >= 4 && q.includes(n) && n.length >= 3) best = Math.max(best, 0.76); // 条目名是查询的一部分
      // 去掉虚词后再比一次，命中的会略微降分，但仍然算找到
      if (best < 0.7 && loose.length >= 2 && ln) {
        if (ln === loose) best = Math.max(best, 0.92);
        else if (ln.includes(loose) || loose.includes(ln)) best = Math.max(best, 0.68);
      }
    }
    return best;
  }

  function findAnime(catalog, query, limit = 8) {
    return catalog
      .map((a) => ({ a, s: matchScore(query, a) }))
      .filter((x) => x.s >= 0.6)
      .sort((x, y) => y.s - x.s || (y.a.members || 0) - (x.a.members || 0))
      .slice(0, limit)
      .map((x) => x.a);
  }

  /* ---------------------------------------------------------------- */
  /* 向量化                                                            */
  /* ---------------------------------------------------------------- */

  function addTo(vec, key, value) {
    if (!key) return;
    vec[key] = (vec[key] || 0) + value;
  }

  function bump(map, key, factor) {
    if (!key) return;
    map[key] = (map[key] || 0) + factor;
  }

  /** 数据里类型(genres)、主题(tags)、受众(demographics)分开存，展示时合并；计算口味时剔除背景标签。 */
  /** 标题归一化后比较前缀，判断两条记录是否同一系列。 */
  function titlePrefixOf(anime, len = 12) {
    return normalizeTitle(anime.romaji || anime.title || anime.titleCn || '').slice(0, len);
  }

  function sameSeries(a, b) {
    const x = titlePrefixOf(a);
    const y = titlePrefixOf(b);
    if (!x || !y) return false;
    return x === y || x.startsWith(y) || y.startsWith(x);
  }

  function tagsOf(anime) {
    return [...(anime.genres || []), ...(anime.tags || []), ...(anime.demographics || [])];
  }

  function tasteTagsOf(anime) {
    return tagsOf(anime).filter((t) => !NOT_TASTE.has(t));
  }

  /** 一部作品 → 带权标签向量（类型/主题权重高，受众权重低） */
  function vectorizeFull(anime, weight = 1, tagWeights) {
    const v = {};
    for (const tag of [...(anime.genres || []), ...(anime.tags || [])]) {
      if (NOT_TASTE.has(tag)) continue;
      const base = tagWeights && tagWeights[tag] != null ? tagWeights[tag] : 1;
      addTo(v, DIM.GENRE + tag, WEIGHT.g * base * weight);
    }
    for (const d of anime.demographics || []) addTo(v, DIM.DEMO + d, WEIGHT.d * weight);
    for (const s of anime.studios || []) addTo(v, DIM.STUDIO + s, WEIGHT.s * weight);
    if (anime.year) addTo(v, DIM.YEAR + Math.floor(anime.year / 5) * 5, WEIGHT.y * weight);
    return v;
  }

  function dot(a, b) {
    let sum = 0;
    for (const k in a) if (b[k]) sum += a[k] * b[k];
    return sum;
  }

  function norm(a) {
    let sum = 0;
    for (const k in a) sum += a[k] * a[k];
    return Math.sqrt(sum);
  }

  function cosine(a, b) {
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return 0;
    return dot(a, b) / (na * nb);
  }

  /** 给画像向量补平滑项，让冷门标签不至于因为样本少而无限放大。 */
  function smooth(vec, extra = 0) {
    const out = {};
    for (const k in vec) out[k] = vec[k] / (1 + extra * 0.08);
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* 质量分                                                            */
  /* ---------------------------------------------------------------- */

  function qualityScore(a) {
    // 两个来源的评分各占一部分：AniList 覆盖广，Bangumi 更贴近中文观众口味
    const anilist = a.score || 6.5;
    const bangumi = a.bangumi?.score ?? null;
    const blended = bangumi ? anilist * 0.6 + bangumi * 0.4 : anilist;
    // 评分映射到 0..1，7.5 分左右开始明显加分
    const base = Math.max(0, Math.min(1, (blended - 6.2) / 2.6));
    const popularity = Math.max(0, Math.min(1, Math.log10((a.members || 0) + 10) / 6.5));
    const favorite = Math.max(0, Math.min(1, Math.log10((a.favorites || 0) + 1) / 5));
    return base * 0.72 + popularity * 0.18 + favorite * 0.1;
  }

  function freshness(a, nowYear) {
    if (!a.year) return 0.5;
    const age = nowYear - a.year;
    if (age <= 2) return 0.72;
    if (age <= 5) return 0.66;
    if (age <= 12) return 0.6;
    return 0.5;
  }

  function eraAffinity(a, seedYears) {
    if (!a.year || !seedYears.length) return 0.5;
    const near = seedYears.some((y) => Math.abs(y - a.year) <= 6);
    return near ? 0.75 : 0.45;
  }

  /* ---------------------------------------------------------------- */
  /* 理由生成                                                          */
  /* ---------------------------------------------------------------- */

  function sharedTags(candidate, profileTags, limit = 3) {
    const own = new Set(candidate.genres || []);
    const hits = [];
    for (const [tag, w] of profileTags) {
      if (own.has(tag)) hits.push({ tag, w });
    }
    hits.sort((x, y) => y.w - x.w);
    return hits.slice(0, limit).map((h) => h.tag);
  }

  function buildReason({ candidate, seedTitle, tags, kind, quality, isHiddenGem, isRecent, studioMatch, isSequel }) {
    const parts = [];
    if (isSequel && seedTitle) {
      parts.push(`接在《${seedTitle}》后面的续作，正好顺着看下去`);
    } else if (seedTitle) {
      parts.push(tags.length ? `和《${seedTitle}》一样有${tags.join('、')}的味道` : `和《${seedTitle}》观感接近`);
    } else if (tags.length) {
      parts.push(`刚好撞上你选的${tags.join('、')}`);
    }
    if (kind === 'random') parts.push('随机翻到的一张牌');
    if (studioMatch) parts.push(`同一家制作：${studioMatch}`);
    if (isHiddenGem) parts.push('评分高但看的人不多，属于冷门好货');
    else if (quality >= 0.86) parts.push('口碑站在第一梯队');
    if (isRecent) parts.push('近两年新番，不容易被剧透');
    if (!parts.length) parts.push('和你平时看的口味同一挂');
    return parts.slice(0, 2).join('，') + '。';
  }

  /* ---------------------------------------------------------------- */
  /* 主入口 1：按最近看过的番推荐                                        */
  /* ---------------------------------------------------------------- */

  function recommendFromWatched(catalog, watched, options = {}) {
    const nowYear = options.nowYear || new Date().getFullYear();
    const limit = options.limit || 12;
    const watchedIds = new Set();
    const watchedFranchises = new Map();
    const profileTags = new Map();
    const studioWeights = new Map();
    const seedYears = [];
    const seedList = [];
    const sequelIds = new Set();

    for (const w of watched) {
      const anime = typeof w === 'object' ? w : catalog.find((a) => a.id === Number(w));
      if (!anime) continue;
      seedList.push(anime);
      watchedIds.add(anime.id);
      // 记下「谁的前作被看过」，用来识别直接续作（要求标题确实同系列）
      for (const rel of anime.relations || []) {
        if (rel.type !== 'SEQUEL') continue;
        const next = catalog.find((x) => x.id === Number(rel.id));
        if (next && sameSeries(anime, next)) sequelIds.add(Number(rel.id));
      }
      if (anime.year) seedYears.push(anime.year);
      const wKey = normalizeTitle(anime.title).slice(0, 10);
      watchedFranchises.set(wKey, anime);
      for (const tag of tagsOf(anime)) {
        profileTags.set(tag, (profileTags.get(tag) || 0) + 1);
      }
      for (const s of anime.studios || []) studioWeights.set(s, (studioWeights.get(s) || 0) + 1);
    }
    if (!seedList.length) return [];

    const profile = smooth(vectorizeFullFromTags(profileTags, studioWeights, seedYears), seedList.length);

    const scored = [];
    for (const a of catalog) {
      if (watchedIds.has(a.id)) continue;
      const fKey = normalizeTitle(a.title).slice(0, 10);
      const isSequelOfWatched =
        sequelIds.has(a.id) || (watchedFranchises.has(fKey) && watchedFranchises.get(fKey).id !== a.id);
      const v = vectorizeFull(a, 1);
      const sim = cosine(profile, v);
      const q = qualityScore(a);

      let score = sim * 62 + q * 26 + eraAffinity(a, seedYears) * 6 + freshness(a, nowYear) * 6;
      // 看过前作时，直接续作优先；层级越深（总集篇、外传、第 N 季）给的加权越少
      if (isSequelOfWatched) score += 11 - Math.min(a.franchiseRank || 0, 6) * 1.5;
      else if (a.franchiseRank > 0) score -= 4 + Math.min(a.franchiseRank, 5) * 2.5; // 否则别一上来就推第三季

      const ownTags = new Set(a.genres || []);
      const overlap = [...profileTags.keys()].filter((t) => ownTags.has(t));
      if (!overlap.length) score -= 6; // 完全不沾边
      if (a.supplemental) score -= 40; // 仅作目录收录、评分偏低的作品不主动推荐

      const studioMatch = (a.studios || []).find((s) => studioWeights.has(s)) || null;
      const bestSeed = pickBestSeed(a, seedList, isSequelOfWatched);
      const ranked = profileTags.size ? [...profileTags.entries()].sort((x, y) => y[1] - x[1]).map(([t]) => t) : [];
      const tags = ranked.filter((t) => ownTags.has(t)).slice(0, 3);

      scored.push({
        anime: a,
        score,
        breakdown: { similarity: sim, quality: q, overlap: overlap.length },
        reason: buildReason({
          candidate: a,
          seedTitle: bestSeed ? bestSeed.titleCn || bestSeed.title : null,
          tags,
          kind: 'watched',
          quality: q,
          isSequel: isSequelOfWatched,
          isHiddenGem: q > 0.62 && (a.members || 0) < 200000 && (a.score || 0) >= 7.8,
          isRecent: (a.year || 0) >= nowYear - 3,
          studioMatch: studioMatch && studioWeights.get(studioMatch) > 1 ? studioMatch : null,
        }),
      });
    }

    return finalize(scored, limit);
  }

  function pickBestSeed(candidate, seedList, isSequel) {
    let best = null;
    let bestScore = -1;
    for (const seed of seedList) {
      const own = new Set(seed.genres || []);
      const shared = (candidate.genres || []).filter((t) => own.has(t)).length;
      const studio = (candidate.studios || []).some((s) => (seed.studios || []).includes(s)) ? 1 : 0;
      // 续作的理由要说清是接在哪一部后面，所以同系列的前作优先
      const sameFranchise = isSequel && sameSeries(seed, candidate) ? 6 : 0;
      const score = shared + studio + sameFranchise;
      if (score > bestScore) {
        bestScore = score;
        best = seed;
      }
    }
    return best;
  }

  function vectorizeFullFromTags(profileTags, studioWeights, seedYears) {
    const v = {};
    for (const [tag, count] of profileTags) addTo(v, DIM.GENRE + tag, WEIGHT.g * (0.6 + count * 0.4));
    for (const [studio, count] of studioWeights) addTo(v, DIM.STUDIO + studio, WEIGHT.s * (0.4 + count * 0.4));
    for (const y of seedYears) addTo(v, DIM.YEAR + Math.floor(y / 5) * 5, WEIGHT.y * 0.6);
    return v;
  }

  /* ---------------------------------------------------------------- */
  /* 主入口 2：按问卷偏好推荐                                           */
  /* ---------------------------------------------------------------- */

  function recommendFromProfile(catalog, profile = {}, options = {}) {
    const nowYear = options.nowYear || new Date().getFullYear();
    const limit = options.limit || 12;

    const tagWeights = {};
    for (const t of profile.tags || []) bump(tagWeights, t, 1);
    const moods = (profile.moods || []).map((id) => MOODS.find((m) => m.id === id)).filter(Boolean);
    for (const m of moods) {
      for (const [tag, w] of Object.entries(m.boost)) bump(tagWeights, tag, w);
      for (const [tag, w] of Object.entries(m.damp)) bump(tagWeights, tag, -w * 0.75);
    }

    const era = ERAS.find((e) => e.id === profile.era);
    const lengthRule = LENGTHS.find((l) => l.id === profile.length);
    const minScore = Number(profile.minScore) || 7.3;
    const format = profile.format || 'any';
    const excludeIds = new Set((profile.excludeIds || []).map(Number));

    const v = {};
    let positiveTags = [];
    for (const [tag, w] of Object.entries(tagWeights)) {
      if (w > 0) {
        addTo(v, DIM.GENRE + tag, WEIGHT.g * w);
        positiveTags.push([tag, w]);
      }
    }
    positiveTags.sort((x, y) => y[1] - x[1]);

    const hasTaste = positiveTags.length > 0;
    const profileVec = smooth(v, hasTaste ? 2 : 0);

    const scored = [];
    for (const a of catalog) {
      if (excludeIds.has(a.id)) continue;
      if ((a.score || 0) < minScore) continue;
      if (era && (a.year == null || a.year < era.from || a.year > era.to)) continue;
      if (lengthRule && !lengthRule.test(a)) continue;
      if (format === 'movie' && a.type !== 'Movie') continue;
      if (format === 'tv' && a.type === 'Movie') continue;

      const av = vectorizeFull(a, 1, tagWeights);
      const sim = hasTaste ? cosine(profileVec, av) : 0;
      const q = qualityScore(a);
      let score = q * 42 + sim * 48 + freshness(a, nowYear) * 8;
      if (a.franchiseRank > 2) score -= 4;

      const weightMap = new Map(positiveTags);
      const tags = sharedTags(a, weightMap, 3);
      if (!tags.length && hasTaste) score -= 10;
      if (a.supplemental) score -= 40; // 同上：只进目录，不主动推

      scored.push({
        anime: a,
        score,
        breakdown: { similarity: sim, quality: q },
        reason: buildReason({
          candidate: a,
          tags,
          kind: 'profile',
          quality: q,
          isHiddenGem: q > 0.62 && (a.members || 0) < 200000 && (a.score || 0) >= 7.8,
          isRecent: (a.year || 0) >= nowYear - 3,
        }),
      });
    }

    return finalize(scored, limit);
  }

  /* ---------------------------------------------------------------- */
  /* 主入口 3：随机一部优质番                                          */
  /* ---------------------------------------------------------------- */

  function randomPick(catalog, options = {}) {
    const seedFranchise = new Set();
    const pool = catalog.filter((a) => {
      if ((a.score || 0) < (options.minScore ?? 7.5)) return false;
      if (!a.image) return false;
      if (a.supplemental) return false; // 评分偏低的补录条目不进随机池
      if (options.mood) {
        const m = MOODS.find((x) => x.id === options.mood);
        if (m) {
          const damped = Object.keys(m.damp).some((t) => (a.genres || []).includes(t));
          const boosted = Object.keys(m.boost).some((t) => (a.genres || []).includes(t));
          if (damped && !boosted) return false;
        }
      }
      if (options.era) {
        const era = ERAS.find((e) => e.id === options.era);
        if (era && (a.year == null || a.year < era.from || a.year > era.to)) return false;
      }
      if (options.excludeIds && options.excludeIds.map(Number).includes(a.id)) return false;
      if ((a.franchiseRank ?? 0) > 0) return false; // 只抽系列起点，避免抽到第 4 季或总集篇
      return true;
    });
    if (!pool.length) return [];

    // 评分越高权重越大，但仍然给小众佳作出场机会
    const weights = pool.map((a) => Math.pow(Math.max(0.2, qualityScore(a)), 3) * 100 + 6);
    const total = weights.reduce((s, w) => s + w, 0);
    const count = Math.min(options.count || 1, pool.length);
    const picked = [];
    const used = new Set();
    while (picked.length < count) {
      let r = Math.random() * total;
      let idx = 0;
      for (; idx < pool.length; idx++) {
        r -= weights[idx];
        if (r <= 0) break;
      }
      idx = Math.min(idx, pool.length - 1);
      if (used.has(idx)) {
        // 退化为线性探测，避免极低概率死循环
        let probe = 0;
        while (used.has(idx) && probe < pool.length) {
          idx = (idx + 1) % pool.length;
          probe++;
        }
      }
      used.add(idx);
      const a = pool[idx];
      seedFranchise.add(normalizeTitle(a.title).slice(0, 10));
      picked.push({
        anime: a,
        score: qualityScore(a) * 100,
        breakdown: { quality: qualityScore(a) },
        reason: buildReason({
          candidate: a,
          kind: 'random',
          tags: (a.genres || []).slice(0, 3),
          quality: qualityScore(a),
          isHiddenGem: (a.members || 0) < 200000 && (a.score || 0) >= 7.8,
          isRecent: (a.year || 0) >= new Date().getFullYear() - 3,
        }),
      });
    }
    return picked;
  }

  /* ---------------------------------------------------------------- */
  /* 排序收尾：分数归一 + 轻度多样性                                    */
  /* ---------------------------------------------------------------- */

  function finalize(scored, limit) {
    scored.sort((x, y) => y.score - x.score);
    if (!scored.length) return [];
    const top = scored.slice(0, Math.max(limit * 4, 40));

    // 轻度打散：同一主标签连续出现超过 3 次就往后挪一位
    const out = [];
    const used = new Set();
    const tagCount = new Map();
    while (out.length < limit && used.size < top.length) {
      let fallback = -1;
      let pickIndex = -1;
      for (let i = 0; i < top.length; i++) {
        if (used.has(i)) continue;
        if (fallback === -1) fallback = i;
        const crowded = (top[i].anime.genres || []).some((t) => (tagCount.get(t) || 0) >= 3);
        if (!crowded) {
          pickIndex = i;
          break;
        }
      }
      if (pickIndex === -1) pickIndex = fallback;
      if (pickIndex === -1) break;
      used.add(pickIndex);
      const entry = top[pickIndex];
      for (const t of entry.anime.genres || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);
      out.push(entry);
    }

    const max = out[0]?.score || 1;
    const min = out[out.length - 1]?.score || 0;
    return out.map((e) => ({
      ...e,
      match: Math.round(
        52 + Math.max(0, min === max ? 0.7 : (e.score - min) / (max - min)) * 43
      ),
    }));
  }

  /* ---------------------------------------------------------------- */
  /* 目录筛选（浏览页用）                                              */
  /* ---------------------------------------------------------------- */

  function queryCatalog(catalog, filter = {}) {
    const keyword = normalizeTitle(filter.q || '');
    let list = catalog.filter((a) => {
      if (filter.genre && !(a.genres || []).includes(filter.genre)) return false;
      if (filter.era) {
        const era = ERAS.find((e) => e.id === filter.era);
        if (era && (a.year == null || a.year < era.from || a.year > era.to)) return false;
      }
      if (filter.type && filter.type !== 'any') {
        if (filter.type === 'movie' && a.type !== 'Movie') return false;
        if (filter.type === 'tv' && a.type === 'Movie') return false;
      }
      if (filter.minScore && (a.score || 0) < filter.minScore) return false;
      if (keyword) {
        const hit = titles(a).some((t) => normalizeTitle(t).includes(keyword));
        const tagHit = (a.genres || []).some((t) => normalizeTitle(t).includes(keyword));
        if (!hit && !tagHit) return false;
      }
      return true;
    });
    const sort = filter.sort || 'heat';
    if (sort === 'score') list.sort((a, b) => (b.score || 0) - (a.score || 0));
    else if (sort === 'new') list.sort((a, b) => (b.year || 0) - (a.year || 0) || (b.score || 0) - (a.score || 0));
    else if (sort === 'old') list.sort((a, b) => (a.year || 9999) - (b.year || 9999));
    else list.sort((a, b) => (b.members || 0) - (a.members || 0));
    return list;
  }

  function allTags(catalog) {
    const count = new Map();
    for (const a of catalog) for (const t of a.genres || []) count.set(t, (count.get(t) || 0) + 1);
    return [...count.entries()]
      .filter(([, c]) => c >= 3)
      .sort((x, y) => y[1] - x[1])
      .map(([t, c]) => ({ tag: t, count: c }));
  }

  /** 从偏好标签/心情反推「可能喜欢的作品」，用于把条目推荐给问卷用户 */
  function suggestTagsForAnime(anime) {
    return (anime.genres || []).slice(0, 4);
  }

  return {
    DIM,
    ERAS,
    MOODS,
    LENGTHS,
    normalizeTitle,
    findAnime,
    matchScore,
    recommendFromWatched,
    recommendFromProfile,
    randomPick,
    queryCatalog,
    allTags,
    qualityScore,
    suggestTagsForAnime,
  };
});
