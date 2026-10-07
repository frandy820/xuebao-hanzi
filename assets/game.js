/* 雪宝识字大冒险 —— 游戏核心逻辑
   零识字门槛：全部操作靠图像+语音引导；文字仅作为学习对象出现。
   进度持久化: localStorage(hz_v1) + 导出/导入JSON。
   音频策略: 预录制mp3(assets/audio/u{code}.mp3) + WebSpeech兜底 + 点击后播放。 */

(function () {
"use strict";

/* ============ 数据接入 ============ */
const STAGES = (typeof CURRICULUM !== "undefined" && CURRICULUM.stages) || [];
const STAGE_META = {
  s1: { emoji: "🌲", name: "象形启蒙" },
  s2: { emoji: "🏠", name: "生活高频" },
  s3: { emoji: "🦋", name: "动物自然" },
  s4: { emoji: "❄️", name: "方位反义" },
  s5: { emoji: "🏰", name: "人物物品" },
  s6: { emoji: "🌟", name: "一年级进阶" },
};
const THEMES = {
  forest: "theme-forest", home: "theme-home", meadow: "theme-meadow",
  ice: "theme-ice", castle: "theme-castle", star: "theme-star",
};

/* ============ 进度模型 ============ */
const LS_KEY = "hanzi_game_v1";
let P = loadProgress();
function defaultProgress() {
  return {
    ver: 1,
    child: "小雪宝",
    created: Date.now(),
    stars: 0,
    levelsDone: {},     // "s1-0": {stars, at}
    charStats: {},      // hz: {seen, right, wrong, lastTs, mastered}
    wrongQueue: [],     // 错字复习队列 hz 列表
    daily: {},          // "2026-10-07": {sec, right, wrong, levels}
    lastPlay: null,
    audioOn: true,
  };
}
function loadProgress() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { const p = JSON.parse(raw); if (p && p.ver === 1) return p; }
  } catch (e) {}
  return defaultProgress();
}
function save() {
  P.lastPlay = Date.now();
  try { localStorage.setItem(LS_KEY, JSON.stringify(P)); } catch (e) {}
}
function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; }
function daily(k) { const t = today(); if (!P.daily[t]) P.daily[t] = { sec: 0, right: 0, wrong: 0, levels: 0 }; return P.daily[t]; }

/* ============ 音频引擎 ============ */
const AudioFX = {
  pool: {}, unlocked: false, speechOk: false,
  init() {
    try { this.speechOk = !!(window.speechSynthesis && window.speechSynthesis.speak); } catch(e) { this.speechOk = false; }
  },
  unlock() {
    // iOS/自动播放策略：用户手势里播放一段静音解锁
    try {
      const ctx = window.AudioContext || window.webkitAudioContext;
      if (ctx) { const ac = new ctx(); ac.resume().then(()=>ac.close()).catch(()=>{}); }
      if (this.speechOk) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); }
      this.unlocked = true;
    } catch(e) { this.unlocked = true; }
  },
  playChar(hz, cb) {
    if (!P.audioOn) { cb && cb(); return; }
    const code = "u" + hz.codePointAt(0);
    const url = "assets/audio/" + code + ".mp3";
    let a = this.pool[code];
    if (!a) { a = new Audio(url); a.preload = "auto"; this.pool[code] = a; }
    a.currentTime = 0;
    a.onended = () => cb && cb();
    a.onerror = () => this.speak(hz + "。", cb);   // mp3缺失→TTS兜底
    a.play().catch(() => this.speak(hz + "。", cb));
  },
  playWords(hz, word, cb) {
    // 字+组词连读：直接 TTS（mp3 即"字，词的字"完整句）
    if (!P.audioOn) { cb && cb(); return; }
    const code = "u" + hz.codePointAt(0);
    const url = "assets/audio/" + code + ".mp3";
    let a = this.pool["w" + code];
    if (!a) { a = new Audio(url); a.preload = "auto"; this.pool["w" + code] = a; }
    a.currentTime = 0;
    a.onended = () => cb && cb();
    a.onerror = () => this.speak(hz + "，" + word + "的" + hz, cb);
    a.play().catch(() => this.speak(hz + "，" + word + "的" + hz, cb));
  },
  speak(text, cb, noCancel) {
    if (!this.speechOk || !P.audioOn) { cb && cb(); return; }
    try {
      if (!noCancel) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN"; u.rate = 0.82;
      const voices = speechSynthesis.getVoices();
      const v = voices.find(v => /zh[-_]CN/i.test(v.lang) && /female|Xiaoxiao|Yaoyao|Huihui/i.test(v.name)) || voices.find(v => /zh[-_]CN/i.test(v.lang));
      if (v) u.voice = v;
      u.onend = () => cb && cb();
      u.onerror = () => cb && cb();
      speechSynthesis.speak(u);
    } catch(e) { cb && cb(); }
  },
};

/* ============ UI 工具 ============ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
function show(sceneId) {
  ["scene-start","scene-map","scene-album","scene-level","scene-win","scene-parent"].forEach(id => {
    $("#" + id).classList.toggle("hidden", id !== sceneId);
  });
  $("#topbar").classList.toggle("hidden", sceneId === "scene-start");
}
function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(a) { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }

/* ============ 全部汉字池（出干扰项用） ============ */
const ALL_CHARS = [];
STAGES.forEach(st => st.levels.forEach(lv => lv.forEach(c => ALL_CHARS.push(c))));

// v3：生字插画映射表（hz → 文件名）；未列出的字自动回退大号 emoji
const CHAR_IMGS = {
  // v3 自动生成：hz → 插画文件名（缺图自动回退大emoji）
  "一": "c19968.jpg",
  "七": "c19971.jpg",
  "三": "c19977.jpg",
  "上": "c19978.jpg",
  "下": "c19979.jpg",
  "九": "c20061.jpg",
  "二": "c20108.jpg",
  "云": "c20113.jpg",
  "五": "c20116.jpg",
  "人": "c20154.jpg",
  "他": "c20182.jpg",
  "你": "c20320.jpg",
  "兔": "c20820.jpg",
  "八": "c20843.jpg",
  "六": "c20845.jpg",
  "关": "c20851.jpg",
  "写": "c20889.jpg",
  "出": "c20986.jpg",
  "十": "c21313.jpg",
  "午": "c21320.jpg",
  "去": "c21435.jpg",
  "口": "c21475.jpg",
  "句": "c21477.jpg",
  "哥": "c21733.jpg",
  "喝": "c21917.jpg",
  "四": "c22235.jpg",
  "地": "c22320.jpg",
  "坐": "c22352.jpg",
  "大": "c22823.jpg",
  "天": "c22825.jpg",
  "妈": "c22920.jpg",
  "姓": "c22995.jpg",
  "字": "c23383.jpg",
  "学": "c23398.jpg",
  "小": "c23567.jpg",
  "山": "c23665.jpg",
  "川": "c24029.jpg",
  "开": "c24320.jpg",
  "弟": "c24351.jpg",
  "我": "c25105.jpg",
  "手": "c25163.jpg",
  "数": "c25968.jpg",
  "文": "c25991.jpg",
  "日": "c26085.jpg",
  "早": "c26089.jpg",
  "月": "c26376.jpg",
  "木": "c26408.jpg",
  "本": "c26412.jpg",
  "来": "c26469.jpg",
  "校": "c26657.jpg",
  "水": "c27700.jpg",
  "火": "c28779.jpg",
  "爸": "c29240.jpg",
  "牛": "c29275.jpg",
  "狗": "c29399.jpg",
  "王": "c29579.jpg",
  "班": "c29677.jpg",
  "田": "c30000.jpg",
  "目": "c30446.jpg",
  "看": "c30475.jpg",
  "禾": "c31166.jpg",
  "站": "c31449.jpg",
  "羊": "c32650.jpg",
  "耳": "c32819.jpg",
  "虫": "c34411.jpg",
  "词": "c35789.jpg",
  "说": "c35828.jpg",
  "读": "c35835.jpg",
  "足": "c36275.jpg",
  "雨": "c38632.jpg",
  "风": "c39118.jpg",
  "飞": "c39134.jpg",
  "马": "c39532.jpg",
  "鱼": "c40060.jpg",
  "鸟": "c40479.jpg",
  "鸡": "c40481.jpg"
};
// v3：场景大图（关卡背景）
const SCENE_IMGS = { forest: "scene_forest.jpg", home: "scene_home.jpg", meadow: "scene_meadow.jpg", ice: "scene_ice.jpg", castle: "scene_castle.jpg", star: "scene_star.jpg" };

/* ============ 关卡解锁模型 ============ */
function flatLevels() {
  const out = [];
  STAGES.forEach((st, si) => st.levels.forEach((lv, li) => out.push({ stage: st, si, li, key: st.id + "-" + li, chars: lv })));
  return out;
}
const FLAT = flatLevels();
function isUnlocked(idx) {
  if (idx === 0) return true;
  const prev = FLAT[idx - 1];
  return !!P.levelsDone[prev.key];
}
function firstUndone() { const i = FLAT.findIndex(f => !P.levelsDone[f.key]); return i < 0 ? FLAT.length - 1 : i; }

/* ============ 场景：开场 ============ */
function bindStart() {
  $("#btn-start").addEventListener("click", () => {
    AudioFX.unlock();
    P.audioOn = true;
    save();
    show("scene-map");
    AudioFX.speak("欢迎来到雪宝识字大冒险！选一个亮晶晶的地方，点开始吧。");
  });
  $("#btn-parent").addEventListener("click", () => { AudioFX.unlock(); openParent(); });
  $("#btn-audio").addEventListener("click", () => {
    P.audioOn = !P.audioOn;
    $("#btn-audio").textContent = P.audioOn ? "🔊" : "🔇";
    save();
    if (!P.audioOn) { try { speechSynthesis.cancel(); } catch(e){} }
  });
  $("#btn-home").addEventListener("click", () => { try { speechSynthesis.cancel(); } catch(e){} show("scene-map"); renderMap(); });
}

/* ============ v4 场景：字卡图鉴册 ============ */
function renderAlbum() {
  const grid = $("#album-grid");
  grid.innerHTML = "";
  const learned = ALL_CHARS.filter(c => { const s = P.charStats[c.hz]; return s && s.mastered; });
  const seen = ALL_CHARS.filter(c => { const s = P.charStats[c.hz]; return s && s.seen > 0; }).length;
  $("#album-progress").textContent = "✨ " + learned.length + " / " + ALL_CHARS.length;
  const frag = document.createDocumentFragment();
  ALL_CHARS.forEach(c => {
    const s = P.charStats[c.hz];
    const master = s && s.mastered;
    const card = document.createElement("div");
    card.className = "album-card" + (master ? "" : " locked");
    const img = CHAR_IMGS[c.hz] ? `<img src="assets/img/${CHAR_IMGS[c.hz]}" alt="${c.word}" loading="lazy">` : `<div style="width:100%;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;font-size:34px;background:var(--ice-50)">${c.icon || "📖"}</div>`;
    card.innerHTML = img + `<div class="al-hz">${master ? c.hz : "？"}</div>` + (master && s.right === 3 && s.wrong === 0 ? `<span class="al-new">新!</span>` : "");
    card.addEventListener("click", () => {
      AudioFX.playWords(c.hz, c.word);
    });
    frag.appendChild(card);
  });
  grid.appendChild(frag);
  AudioFX.speak(`你已经点亮了${learned.length}张字卡${learned.length > 0 ? "，真棒！" : "，快去冒险吧！"}`);
}
function bindAlbum() {
  $("#btn-album").addEventListener("click", () => { AudioFX.unlock(); show("scene-album"); renderAlbum(); });
  $("#btn-album-back").addEventListener("click", () => { try { speechSynthesis.cancel(); } catch(e){} show("scene-map"); renderMap(); });
}

/* ============ 场景：地图 ============ */
function renderMap() {
  $("#star-count").textContent = "⭐ " + P.stars;
  const grid = $("#stage-grid");
  grid.innerHTML = "";
  const cur = firstUndone();
  STAGES.forEach((st, si) => {
    const anyUnlocked = st.levels.some((_, li) => isUnlocked(FLAT.findIndex(f => f.stage === st && f.li === li)));
    const card = document.createElement("div");
    card.className = "stage-card" + (anyUnlocked ? "" : " locked");
    const meta = STAGE_META[st.id] || { emoji: "✨", name: st.name };
    const doneCount = st.levels.filter((_, li) => P.levelsDone[st.id + "-" + li]).length;
    card.innerHTML = `
      <div class="stage-head">
        <div class="stage-name">
          <span class="stage-emoji">${anyUnlocked ? meta.emoji : "🔒"}</span>
          <div><h3>${st.name}</h3><p>${st.desc || ""} · ${doneCount}/${st.levels.length}关</p></div>
        </div>
        <span class="stage-lock">${anyUnlocked ? "" : "🔒"}</span>
      </div>
      <div class="stage-levels"></div>`;
    const lvWrap = card.querySelector(".stage-levels");
    st.levels.forEach((lv, li) => {
      const fIdx = FLAT.findIndex(f => f.stage === st && f.li === li);
      const key = st.id + "-" + li;
      const done = !!P.levelsDone[key];
      const unlocked = isUnlocked(fIdx);
      const node = document.createElement("button");
      node.className = "level-node " + (done ? "done" : unlocked ? (fIdx === cur ? "current" : "") : "locked");
      node.textContent = done ? "⭐" : unlocked ? (li + 1) : "🔒";
      node.setAttribute("aria-label", st.name + "第" + (li+1) + "关");
      if (unlocked) {
        node.addEventListener("click", () => startLevel(fIdx));
      } else {
        node.addEventListener("click", () => {
          AudioFX.speak("先完成前面的关卡，才能解锁这里哦。");
          wiggle(node);
        });
      }
      lvWrap.appendChild(node);
    });
    grid.appendChild(card);
  });
  grid.scrollTop = 0;
  const curCard = grid.children[Math.floor(cur / 10)] || grid.children[0];
}
function wiggle(el) { el.animate([{transform:"translateX(0)"},{transform:"translateX(-5px)"},{transform:"translateX(5px)"},{transform:"translateX(0)"}], {duration:300}); }

/* ============ 场景：关卡 ============ */
let LV = null; // 当前关运行态
const TYPE_INFO = {
  // v2改版：所有题型选项均为汉字（认字是核心目标）；图片/读音只作辅助提示
  pic2char:   { prompt: "看图，找出正确的汉字", ask: false, opt: "hz", main: "pic" },
  sound2char: { prompt: "听一听，找出正确的汉字", ask: true,  opt: "hz", main: "none" },
  picSound2char: { prompt: "看图听读音，找出正确的汉字", ask: true, opt: "hz", main: "pic" },
  word2char:  { prompt: "听词语，选出对应的汉字", ask: true,  opt: "hz", main: "none" },
  char2pic:   { prompt: "这个字，是哪张图呢？", ask: false, opt: "emoji", main: "hz" },
  sent2char:  { prompt: "听句子，选出缺少的汉字", ask: true,  opt: "hz", main: "none" },
};

function startLevel(fIdx) {
  const f = FLAT[fIdx];
  LV = { f, fIdx, queue: buildQueue(f), i: 0, hearts: 3, right: 0, wrongCount: 0, wrongLoss: 0, secTimer: null, t0: Date.now() };
  const themeCls = THEMES[f.stage.theme] || "theme-forest";
  const sceneImg = SCENE_IMGS[f.stage.theme];
  $("#level-stage").className = themeCls + (sceneImg ? " scene-bg" : "");
  $("#hud-hearts").textContent = "❤️".repeat(3);
  show("scene-level");
  LV.secTimer = setInterval(() => { daily().sec += 3; }, 3000);
  nextQuestion(true);
}

function buildQueue(f) {
  // v2改版：每关每字1题，题型轮换且全部以汉字为选项（s1阶段图辅最重，后续纯字化）
  const q = [];
  const types = f.stage.types;
  f.chars.forEach((c, ci) => {
    const type = types[ci % types.length];
    q.push({ char: c, type });
  });
  // 插入最多2个历史错字复习（sound2char 最稳）
  const wrongs = P.wrongQueue.filter(h => !f.chars.some(c => c.hz === h)).slice(0, 2);
  wrongs.forEach(h => {
    const c = ALL_CHARS.find(x => x.hz === h);
    if (c) q.splice(Math.min(q.length, 2 + Math.floor(Math.random() * 3)), 0, { char: c, type: "sound2char", review: true });
  });
  return q;
}

function nextQuestion(first) {
  if (!LV) return;
  if (LV.i >= LV.queue.length) { levelClear(); return; }
  const item = LV.queue[LV.i];
  renderQuestion(item);
}

function renderQuestion(item) {
  const info = TYPE_INFO[item.type];
  const c = item.char;
  $("#hud-progress").parentElement.style.display = "";
  $("#hud-bar").style.width = Math.round((LV.i / LV.queue.length) * 100) + "%";
  $("#companion-emoji").textContent = rnd(["🐰", "👑", "🐰"]);
  $("#companion-bubble").textContent = item.review ? "复习时间到！" : rnd(["看仔细哦～", "你想一想～", "加油哦！"]);

  // 题干
  const qa = $("#q-audio");
  const qLabel = $("#q-audio-label");
  $("#q-prompt").textContent = info.prompt;

  // 主体显示区（v3：优先插画大图，无图时回退大号 emoji；v4：趣味模式一一擦雪花看图/惊喜卡）
  let mainHtml = "";
  if (info.main === "pic") {
    if (CHAR_IMGS[c.hz]) {
      // 趣味流：s1-s3 看图题 40% 概率变擦雪花卡，其余直接大图
      const wantScratch = !item.review && Math.random() < 0.4;
      mainHtml = `<div class="q-main-card has-img${wantScratch ? " scratch" : ""}">` +
        `<img class="q-img" src="assets/img/${CHAR_IMGS[c.hz]}" alt="${c.word}">` +
        (wantScratch
          ? `<canvas class="scratch-canvas"></canvas><span class="scratch-tip">❄️ 用手指擦开雪花</span>`
          : `<span class="q-img-tag">${c.icon || ""}</span>`) + `</div>`;
    } else {
      mainHtml = `<div class="q-main-card"><span class="opt-emoji">${c.icon}</span></div>`;
    }
  } else if (info.main === "hz") {
    mainHtml = `<div class="q-main-card"><span class="opt-hz">${c.hz}</span></div>`;
  }
  // 题目语音按钮行为
  qa.onclick = () => {
    qa.classList.add("playing");
    const done = () => { qa.classList.remove("playing"); };
    if (item.type === "picSound2char") AudioFX.playWords(c.hz, c.word, done);
    else if (item.type === "sound2char") AudioFX.playWords(c.hz, c.word, done);
    else if (item.type === "word2char") AudioFX.speak(c.word + "。是哪个字呢？", done);
    else if (item.type === "sent2char") AudioFX.speak((c.sent || (c.word + "里有" + c.hz)) + "。是哪个字呢？", done);
    else if (item.type === "char2pic") AudioFX.speak("这个字念" + c.py + "。它像哪张图呢？", done);
    else AudioFX.speak(info.prompt, done);
  };

  // 选项（v2：汉字为主）
  const opts = $("#options");
  opts.className = "options";
  let optData;
  if (info.opt === "emoji") {
    const others = shuffle(ALL_CHARS.filter(x => x.hz !== c.hz && x.icon !== c.icon)).slice(0, 3);
    optData = shuffle([{ c, ok: true }, ...others.map(o => ({ c: o, ok: false }))]);
    opts.innerHTML = optData.map((o, i) => `<button class="opt" data-i="${i}"><span class="opt-emoji">${o.c.icon}</span></button>`).join("");
  } else if (info.opt === "py") {
    const others = shuffle(ALL_CHARS.filter(x => x.hz !== c.hz && x.py !== c.py)).slice(0, 3);
    optData = shuffle([{ c, ok: true }, ...others.map(o => ({ c: o, ok: false }))]);
    opts.innerHTML = optData.map((o, i) => `<button class="opt" data-i="${i}"><span class="opt-py" style="font-size:26px">${o.c.py}</span></button>`).join("");
    opts.classList.add("triple");
  } else { // hz
    const others = shuffle(ALL_CHARS.filter(x => x.hz !== c.hz)).slice(0, 3);
    optData = shuffle([{ c, ok: true }, ...others.map(o => ({ c: o, ok: false }))]);
    opts.innerHTML = optData.map((o, i) => `<button class="opt" data-i="${i}"><span class="opt-hz">${o.c.hz}</span></button>`).join("");
  }
  // 主体插入（若有）
  if (mainHtml) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;justify-content:center;width:100%";
    wrap.innerHTML = mainHtml;
    $("#question-area").insertBefore(wrap, $("#q-prompt"));
    LV._mainEl = wrap;
  } else if (LV._mainEl) { LV._mainEl.remove(); LV._mainEl = null; }

  opts.querySelectorAll(".opt").forEach(btn => {
    btn.addEventListener("click", () => {
      if (LV._locked) return;
      const o = optData[+btn.dataset.i];
      answer(o, btn, item);
    });
  });

  // v4：初始化擦雪花层
  const scratchCard = $(".q-main-card.scratch");
  if (scratchCard) initScratch(scratchCard, c);

  // 自动读题
  setTimeout(() => { if (qa && qa.onclick) qa.onclick(); }, 500);
}

function answer(o, btn, item) {
  LV._locked = true;
  const c = item.char;
  const stat = P.charStats[c.hz] || (P.charStats[c.hz] = { seen: 0, right: 0, wrong: 0, lastTs: 0, mastered: false });
  stat.seen++; stat.lastTs = Date.now();
  if (LV) LV._locked = true;
  if (o.ok) {
    btn.classList.add("correct");
    LV.right++; stat.right++;
    // v4：答对粒子特效（从所点按钮位置搬发）
    try { const br = btn.getBoundingClientRect(); const hs = document.getElementById("level-stage").getBoundingClientRect(); burstFX(br.left + br.width / 2 - hs.left, br.top + br.height / 2 - hs.top); } catch (e) {}
    if (stat.right >= 3 && stat.right >= stat.wrong * 2) stat.mastered = true;
    daily().right++;
    const wrongIdx = P.wrongQueue.indexOf(c.hz);
    if (wrongIdx >= 0 && stat.right > stat.wrong) P.wrongQueue.splice(wrongIdx, 1);
    showFeedback(true, c, item);
  } else {
    btn.classList.add("wrong");
    stat.wrong++;
    LV.wrongCount++; LV.wrongLoss++;
    daily().wrong++;
    if (!P.wrongQueue.includes(c.hz)) P.wrongQueue.push(c.hz);
    LV.hearts = Math.max(0, LV.hearts - 1);
    $("#hud-hearts").textContent = "❤️".repeat(LV.hearts) || "💔";
    // 高亮正确项
    $$("#options .opt").forEach(b => {
      const od = optDataOf(b);
    });
    showFeedback(false, c, item);
  }
  save();
}
function optDataOf() { return null; }

/* ============ v4 趣味：答对撒星雷/雪花粒子 ============ */
function burstFX(x, y) {
  const host = document.getElementById("level-stage");
  if (!host) return;
  const cv = document.createElement("canvas");
  cv.className = "fx-burst";
  const r = host.getBoundingClientRect();
  cv.width = r.width; cv.height = r.height;
  host.appendChild(cv);
  const ctx = cv.getContext("2d");
  const parts = [];
  const N = 26;
  for (let i = 0; i < N; i++) {
    const ang = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 5;
    parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 3, g: 0.18, life: 1, star: Math.random() < 0.5, r: 3 + Math.random() * 4 });
  }
  let frame = 0;
  (function tick() {
    frame++;
    ctx.clearRect(0, 0, cv.width, cv.height);
    let alive = 0;
    parts.forEach(p => {
      if (p.life <= 0) return;
      alive++;
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life -= 0.02;
      ctx.globalAlpha = Math.max(p.life, 0);
      if (p.star) { ctx.fillStyle = "#fbbf24"; ctx.font = p.r * 3 + "px serif"; ctx.fillText("⭐", p.x, p.y); }
      else { ctx.fillStyle = "#bae6fd"; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill(); }
    });
    ctx.globalAlpha = 1;
    if (alive && frame < 90) requestAnimationFrame(tick);
    else cv.remove();
  })();
}

/* ============ v4 趣味：擦雪花看图 ============ */
function initScratch(card, c) {
  const cv = card.querySelector(".scratch-canvas");
  if (!cv) return;
  const img = card.querySelector(".q-img");
  const tip = card.querySelector(".scratch-tip");
  const setup = () => {
    const r = card.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const ctx = cv.getContext("2d");
    // 雪花层：冰蓝渐变 + 大颗雪花
    const g = ctx.createLinearGradient(0, 0, 0, cv.height);
    g.addColorStop(0, "#dbeafe"); g.addColorStop(1, "#bfdbfe");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "rgba(255,255,255,.9)";
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * cv.width, y = Math.random() * cv.height, rr = (4 + Math.random() * 7) * dpr;
      ctx.beginPath();
      for (let a = 0; a < 6; a++) {
        const ang = a * Math.PI / 3;
        ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * rr, y + Math.sin(ang) * rr);
        ctx.moveTo(x, y); ctx.lineTo(x - Math.cos(ang) * rr * .6, y - Math.sin(ang) * rr * .6);
      }
      ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 2 * dpr; ctx.stroke();
    }
    ctx.fillStyle = "#64748b"; ctx.font = `${13 * dpr}px sans-serif`; ctx.textAlign = "center";
    ctx.fillText("❄ 擦开看看 ❄", cv.width / 2, cv.height / 2 + 5 * dpr);
    // 擦除逻辑
    ctx.globalCompositeOperation = "destination-out";
    let wiped = 0, done = false;
    const BR = 26 * dpr;
    const wipe = (x, y) => {
      if (done) return;
      ctx.beginPath(); ctx.arc(x, y, BR, 0, 7); ctx.fill();
      // 每 6 笔测一次擦开比例
      if (++wiped % 6 === 0) {
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let clear = 0, tot = 0;
        for (let i = 3; i < d.length; i += 64) { tot++; if (d[i] < 40) clear++; }
        if (clear / tot > 0.25) {
          done = true;
          cv.style.transition = "opacity .5s"; cv.style.opacity = "0";
          if (tip) tip.style.display = "none";
          setTimeout(() => cv.remove(), 520);
          AudioFX.speak("哇，你看！这是什么呀？", null, true); // 趣味旁白，不打断题音
        }
      }
    };
    const pos = e => {
      const t = e.touches ? e.touches[0] : e;
      const cr = cv.getBoundingClientRect();
      return [(t.clientX - cr.left) * dpr, (t.clientY - cr.top) * dpr];
    };
    let drawing = false;
    cv.addEventListener("pointerdown", e => { drawing = true; const p = pos(e); wipe(p[0], p[1]); e.preventDefault(); });
    cv.addEventListener("pointermove", e => { if (drawing) { const p = pos(e); wipe(p[0], p[1]); e.preventDefault(); } });
    window.addEventListener("pointerup", () => drawing = false);
  };
  if (img && !img.complete) img.addEventListener("load", setup, { once: true });
  else setup();
}

function showFeedback(ok, c, item) {
  const ov = $("#feedback-overlay");
  const card = $("#feedback-card");
  // 双保险：音频回调若不触发（无声环境/异常），4.5s 后自动关闭浮层
  if (LV && LV._fbTimer) clearTimeout(LV._fbTimer);
  const fbTimeout = setTimeout(() => {
    if (!$("#feedback-overlay").classList.contains("hidden")) closeFeedback(ok);
  }, 4500);
  if (LV) LV._fbTimer = fbTimeout;
  if (ok) {
    card.innerHTML = `<div class="fb-emoji">🎉</div><div class="fb-title">${rnd(CHEERS.right)}</div>
      <div class="fb-sub"><span class="hz-big">${c.hz}</span>${c.py} · ${c.word}</div>`;
    AudioFX.speak(rnd(CHEERS.rightVoice) + c.hz + "，" + c.word + "的" + c.hz + ".", () => closeFeedback(ok));
  } else {
    card.innerHTML = `<div class="fb-emoji">🐰</div><div class="fb-title">${rnd(CHEERS.wrong)}</div>
      <div class="fb-sub"><span class="hz-big">${c.hz}</span>听一听：${c.py} · ${c.word}</div>`;
    AudioFX.speak(rnd(CHEERS.wrongVoice) + c.hz + "，" + c.word + "的" + c.hz + ".", () => {
      setTimeout(() => closeFeedback(ok), 300);
    });
  }
  ov.classList.remove("hidden");
}
function closeFeedback(ok) {
  // 防重复关闭（音频回调与超时兑底可能同时到达）
  const ovEl = $("#feedback-overlay");
  if (ovEl.classList.contains("hidden")) return;
  ovEl.classList.add("hidden");
  if (LV && LV._fbTimer) { clearTimeout(LV._fbTimer); LV._fbTimer = null; }
  if (!LV) return;
  LV._locked = false;
  if (ok) { LV.i++; nextQuestion(); }
  else {
    // 答错不前进，重读本题（选项重新洗牌）
    const item = LV.queue[LV.i];
    if (LV.hearts <= 0) {
      // 心用完：温柔结束本关，回地图（不惩罚）
      endLevelFail();
    } else {
      renderQuestion(item);
    }
  }
}

function levelClear() {
  clearInterval(LV.secTimer);
  const f = LV.f;
  const key = f.key;
  const firstDone = !P.levelsDone[key];
  const stars = LV.wrongLoss <= 0 ? 3 : (LV.hearts >= 2 ? 3 : LV.hearts === 1 ? 2 : 1);
  P.levelsDone[key] = { stars: Math.max(stars, (P.levelsDone[key]||{}).stars || 0), at: Date.now() };
  P.stars += firstDone ? stars : 0;
  daily().levels++;
  save();
  // 过关界面
  $("#win-stars").textContent = "⭐".repeat(stars);
  $("#win-title").textContent = rnd(CHEERS.win);
  const newChars = f.chars.map(c => `<span class="w">${c.hz}</span>`).join("");
  $("#win-new").innerHTML = `学会的字：${newChars}`;
  // 场景化庆祝（与关卡主题绑定，不点名老师）
  const themeCheer = THEME_CHEERS[f.stage.theme] || "";
  $("#win-cheer").textContent = "";
  show("scene-win");
  AudioFX.speak(rnd(CHEERS.winVoice) + themeCheer);
}
// 记录答错次数用于星级
function endLevelFail() {
  clearInterval(LV.secTimer);
  save();
  show("scene-map");
  renderMap();
  AudioFX.speak("小兔子有点累啦，我们休息一下，再来一次吧！");
}

/* 场景化过关彩蛋：与关卡主题绑定的氛围语（不点名任何老师） */
const THEME_CHEERS = {
  forest: "你像小树一样，又长高了一点！",
  home: "家里的东西，你都知道是哪个字啦！",
  meadow: "小动物们都为你欢呼呢！",
  ice: "冰雪公主的城堡又亮起了一盏灯！",
  castle: "城堡的大门为你敞开啦！",
  star: "你又摘到了一颗亮晶晶的星星！",
};

/* ============ 场景：过关按钮 ============ */
function bindWin() {
  $("#btn-next").addEventListener("click", () => {
    const next = LV.fIdx + 1;
    if (next < FLAT.length) startLevel(next);
    else { show("scene-map"); renderMap(); AudioFX.speak("所有关卡都完成啦！你是最棒的小学生！"); }
  });
  $("#btn-map").addEventListener("click", () => { show("scene-map"); renderMap(); });
}
$("#btn-back").addEventListener("click", () => {
  if (LV) clearInterval(LV.secTimer);
  save();
  show("scene-map"); renderMap();
});

/* ============ 家长中心 ============ */
function openParent() {
  show("scene-parent");
  const q = $("#lock-q");
  const a = Math.ceil(Math.random() * 20 + 10), b = Math.ceil(Math.random() * 9 + 2);
  q.dataset.ans = a * b;
  q.textContent = `${a} × ${b}`;
  $("#lock-input").value = "";
  $("#lock-err").classList.add("hidden");
  $("#parent-lock").classList.remove("hidden");
  $("#parent-body").classList.add("hidden");
}
function bindParent() {
  $("#lock-btn").addEventListener("click", tryUnlock);
  $("#lock-input").addEventListener("keydown", e => { if (e.key === "Enter") tryUnlock(); });
  $("#lock-exit").addEventListener("click", () => show("scene-start"));
  function tryUnlock() {
    const ans = +$("#lock-q").dataset.ans;
    if (+$("#lock-input").value === ans) {
      $("#parent-lock").classList.add("hidden");
      $("#parent-body").classList.remove("hidden");
      renderParent();
    } else {
      $("#lock-err").classList.remove("hidden");
      $("#lock-input").value = "";
    }
  }
}
function renderParent() {
  const body = $("#parent-body");
  const total = ALL_CHARS.length;
  const learned = Object.values(P.charStats).filter(s => s.right >= 1).length;
  const mastered = Object.values(P.charStats).filter(s => s.mastered).length;
  const weak = Object.entries(P.charStats).filter(([h, s]) => s.wrong > s.right).map(([h]) => h);
  const days = Object.entries(P.daily).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
  const levelsDoneN = Object.keys(P.levelsDone).length;
  const totalMin = Object.values(P.daily).reduce((s, d) => s + d.sec, 0) / 60;
  body.innerHTML = `
    <div class="report-block"><h3>📊 总览</h3>
      <div class="kv-grid">
        <div class="kv"><div class="k">已玩关卡</div><div class="v">${levelsDoneN}/${FLAT.length}</div></div>
        <div class="kv"><div class="k">认识的字</div><div class="v">${learned}/${total}</div></div>
        <div class="kv"><div class="k">掌握的字</div><div class="v">${mastered}</div></div>
        <div class="kv"><div class="k">累计时长</div><div class="v">${Math.round(totalMin)}分</div></div>
      </div>
    </div>
    <div class="report-block"><h3>📅 每日学习（近14天）</h3>
      ${days.length ? days.map(([d, v]) => `<p>${d}：${Math.round(v.sec/60)}分钟 · 答对${v.right} · 答错${v.wrong} · ${v.levels}关</p>`).join("") : "<p>还没有学习记录</p>"}
    </div>
    <div class="report-block"><h3>🔁 待复习的错字（${weak.length}）</h3>
      <div>${weak.length ? weak.map(h => `<span class="char-chip weak">${h}</span>`).join("") : "<p>暂无 🎉</p>"}</div>
    </div>
    <div class="report-block"><h3>✅ 已学会的字</h3>
      <div>${Object.entries(P.charStats).filter(([h,s]) => s.right >= 1).map(([h,s]) => `<span class="char-chip learned">${h}</span>`).join("") || "<p>暂无</p>"}</div>
    </div>
    <div class="report-block"><h3>💾 数据管理</h3>
      <div class="btn-line">
        <button class="btn-outline" id="btn-export">导出进度备份</button>
        <button class="btn-outline" id="btn-import">导入进度备份</button>
        <button class="btn-outline" id="btn-reset">重置全部进度</button>
      </div>
      <p style="margin-top:10px">数据保存在本机浏览器（localStorage）。建议每周点一次「导出进度备份」保存 JSON 文件；换设备/重装浏览器前先导出、再导入即可恢复。</p>
      <input type="file" id="file-import" accept=".json" style="display:none">
    </div>`;
  $("#btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(P, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `识字进度备份-${today()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#btn-import").addEventListener("click", () => $("#file-import").click());
  $("#file-import").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const p = JSON.parse(r.result);
        if (p && p.ver === 1) { P = p; save(); renderParent(); alert("导入成功！"); }
        else alert("文件格式不对");
      } catch (err) { alert("导入失败：" + err.message); }
    };
    r.readAsText(f);
  });
  $("#btn-reset").addEventListener("click", () => {
    if (confirm("确定要清空全部学习进度吗？此操作不可恢复（建议先导出备份）。")) {
      P = defaultProgress(); save(); renderParent();
    }
  });
}

/* ============ 启动 ============ */
function boot() {
  AudioFX.init();
  bindStart(); bindWin(); bindParent(); bindAlbum();
  $("#btn-audio").textContent = P.audioOn ? "🔊" : "🔇";
  if (!P.audioOn) $("#btn-audio").textContent = "🔇";
  // 回来时直接进地图（进度已在）
  if (P.levelsDone && Object.keys(P.levelsDone).length) { show("scene-start"); }
  else show("scene-start");
  renderMap();
  window.__HZ_DEBUG__ = { P, FLAT, startLevel, renderParent, CHAR_IMGS, SCENE_IMGS, burstFX, renderAlbum };
}
document.addEventListener("DOMContentLoaded", boot);
window.__HZ_TEST__ = {
  getLV: () => LV,
  current: () => LV ? LV.queue[LV.i] : null,
  correctIndex: () => {
    // 返回当前题正确项的索引（自动化验收/调试用）
    const item = LV ? LV.queue[LV.i] : null;
    if (!item) return -1;
    const btns = $$("#options .opt");
    for (let k = 0; k < btns.length; k++) {
      const c = item.char;
      const info = TYPE_INFO[item.type];
      let txt = btns[k].textContent || "";
      if (info.opt === "emoji") { if (btns[k].querySelector(".opt-emoji") && btns[k].querySelector(".opt-emoji").textContent === c.icon) return k; }
      else if (info.opt === "py") { if (btns[k].querySelector(".opt-py") && btns[k].querySelector(".opt-py").textContent === c.py) return k; }
      else { if (btns[k].querySelector(".opt-hz") && btns[k].querySelector(".opt-hz").textContent === c.hz) return k; }
    }
    return -1;
  },
  answer: (optIndex) => {
    const btns = $$("#options .opt");
    if (btns[optIndex]) btns[optIndex].click();
  },
  closeFeedback,
};
})();
