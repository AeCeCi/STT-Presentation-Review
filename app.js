const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  view: "home",
  tab: "upload",
  analysis: null,
  qaIndex: 0,
  qaAnswers: {},
  qaResults: {},
  selectedFile: null,
  selectedMaterial: null,
  materialPreview: null,
  materialObjectUrl: "",
  practiceMaterial: null,
  practicePreview: null,
  practiceObjectUrl: "",
  practicePdfDoc: null,
  practicePdfRenderKey: "",
  practicePdfZoom: 0.9,
  busy: false,
  recognition: null,
  listening: false,
  streamingTranscript: "",
  streamingInterim: "",
  streamingTimeline: [],
  streamingStartMs: null,
  streamingLastFinalSec: 0,
  mediaStream: null,
  mediaRecorder: null,
  mediaChunks: [],
  recordedBlob: null,
  recordedAudioUrl: "",
  recordedAudioName: "",
  recordingSavedPath: "",
  recordingMime: "audio/webm",
  targetLang: "en",
  translation: "",
  translationStatus: "대기",
  uploadTranslationText: "",
  uploadTranslation: "",
  uploadTranslationStatus: "대기",
  practice: {
    active: false,
    startedAtMs: null,
    pageStartedAtMs: null,
    currentPage: 1,
    records: [],
    tick: 0,
  },
};

const $ = (id) => document.getElementById(id);
const html = (value = "") => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

const scoreOf = (value) => Math.max(0, Math.min(100, Number(value || 0)));
const ready = () => Boolean(state.analysis);
const nowMs = () => Date.now();
const userErrorMessage = (err, fallback = "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.") => (err && err.message ? err.message : fallback);

function formatClock(seconds = 0) {
  const total = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatDuration(seconds = 0) {
  const n = Math.max(0, Math.round(Number(seconds || 0)));
  return n >= 60 ? `${Math.floor(n / 60)}분 ${n % 60}초` : `${n}초`;
}

function streamingElapsedSec() {
  if (!state.streamingStartMs) return 0;
  return (nowMs() - state.streamingStartMs) / 1000;
}

function practiceElapsedSec() {
  if (!state.practice.startedAtMs) return 0;
  return (nowMs() - state.practice.startedAtMs) / 1000;
}

function currentPageElapsedSec() {
  if (!state.practice.pageStartedAtMs) return 0;
  return (nowMs() - state.practice.pageStartedAtMs) / 1000;
}

function asText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((item) => asText(item)).filter(Boolean).join(", ");
  if (typeof value === "object") {
    for (const key of ["title", "question", "detail", "fix", "summary", "text", "value", "name", "category", "reason"]) {
      if (value[key]) return asText(value[key], fallback);
    }
  }
  return fallback;
}

function meaningfulText(value, fallback = "") {
  const text = asText(value, fallback).trim();
  if (!text || /^\d+\.?$/.test(text)) return "";
  return text;
}

function metricCount(value, fallbackList = []) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const match = value.match(/\d+/);
    return match ? Number(match[0]) : 0;
  }
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return Array.isArray(fallbackList) ? fallbackList.length : 0;
}

function cleanSpeaker(value) {
  const text = asText(value, "화자 1").trim();
  if (!text || text.includes("미상") || /[\uFFFD]/.test(text)) return "화자 1";
  return text;
}

function displayVoiceScores(analysis) {
  const base = analysis?.voice_scores && typeof analysis.voice_scores === "object" ? analysis.voice_scores : {};
  const keys = ["발표 흐름", "내용 전달력", "Q&A 대응", "시간 관리"];
  const normalized = Object.fromEntries(keys.map((key) => [key, scoreOf(base[key])]));
  if (Object.values(normalized).reduce((sum, value) => sum + value, 0) > 0 || !analysis?.score) return normalized;
  const score = scoreOf(analysis.score);
  const wpm = Number(analysis.wpm || 0);
  const fillers = Number(analysis.filler_total || 0);
  return {
    "발표 흐름": scoreOf(score + (wpm >= 110 && wpm <= 150 ? 3 : -8)),
    "내용 전달력": scoreOf(score - Math.min(14, Math.floor(fillers / 4))),
    "Q&A 대응": scoreOf(score - 8),
    "시간 관리": scoreOf(90 - Math.floor(Math.abs(wpm - 135) / 2)),
  };
}

function cleanVocabItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === "string") return { original: item, replacement: "", reason: "" };
    return {
      original: asText(item?.original || item?.before || item?.word || item?.expression),
      replacement: asText(item?.replacement || item?.after || item?.suggestion),
      reason: asText(item?.reason || item?.detail),
    };
  }).filter((item) => item.original || item.replacement || item.reason);
}

function cleanProblems(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === "string") return { title: meaningfulText(item), level: "확인", fix: "" };
    return {
      title: meaningfulText(item?.title || item?.problem || item?.issue || item?.category),
      level: asText(item?.level || item?.severity, "확인"),
      fix: meaningfulText(item?.fix || item?.solution || item?.detail || item?.reason),
    };
  }).filter((item) => item.title || item.fix);
}

function cleanPriorities(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === "string") return { title: meaningfulText(item), impact: "", detail: "" };
    return {
      title: meaningfulText(item?.title || item?.name || item?.priority),
      impact: asText(item?.impact || item?.level || ""),
      detail: meaningfulText(item?.detail || item?.description || item?.fix),
    };
  }).filter((item) => item.title || item.detail);
}

function cleanQuestions(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === "string") return { category: "질문", question: meaningfulText(item), level: "-" };
    return {
      category: asText(item?.category || item?.type, "질문"),
      question: meaningfulText(item?.question || item?.title || item?.text),
      level: asText(item?.level || item?.difficulty, "-"),
    };
  }).filter((item) => item.question);
}

/* ---------- design helpers: icons, badges, decorations, shell ---------- */
const ICONS = {
  sparkle: '<path style="fill:currentColor;stroke:none" d="M12 2.5c.7 4.9 4 8.2 9 9-5 .7-8.3 4-9 9-.7-5-4-8.3-9-9 5-.8 8.3-4.1 9-9z"/>',
  mic: '<path d="M12 15.5a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5.5a4 4 0 0 0 4 4z"/><path d="M19 11.5a7 7 0 0 1-14 0"/><path d="M12 18.5V21"/><path d="M8.5 21h7"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  slides: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v3"/><path d="M8 21h8"/><path d="M7 9h6"/><path d="M7 12h10"/>',
  play: '<path style="fill:currentColor;stroke:none" d="M7 4.8v14.4a1 1 0 0 0 1.5.9l11.2-7.2a1 1 0 0 0 0-1.7L8.5 3.9A1 1 0 0 0 7 4.8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16v-6"/><path d="M12 16V6"/><path d="M17 16v-3"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M17.5 13.5a6.5 6.5 0 0 1 4 6.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  message: '<path d="M20 12a8 8 0 0 1-11.6 7.1L4 20l1-4.2A8 8 0 1 1 20 12z"/>',
  check: '<path d="m5 12 4.5 4.5L19 7"/>',
  arrowLeft: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  download: '<path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
  translate: '<path d="M4 5h9"/><path d="M8.5 3v2"/><path d="M11 5c-.6 4.2-3.3 7.3-7 9"/><path d="M6 9c1 2.6 3 4.6 5.5 5.6"/><path d="m13 21 4-9 4 9"/><path d="M14.5 17.5h5"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  award: '<circle cx="12" cy="9" r="6"/><path d="m8.5 14-1.5 7 5-3 5 3-1.5-7"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  volume: '<path d="M4 10v4h4l5 4V6l-5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/><path d="M18.5 6.5a8 8 0 0 1 0 11"/>',
  trending: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M8.5 14.5A6 6 0 1 1 15.5 14.5c-.8.8-1.5 1.5-1.5 3.5h-4c0-2-.7-2.7-1.5-3.5z"/>',
  alert: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  home: '<path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  briefcase: '<path d="M3 8h18v12H3z"/><path d="M9 8V5h6v3"/><path d="M3 13h18"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  fit: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  quote: '<path d="M7 7h4v4H8v3H5V9a2 2 0 0 1 2-2z"/><path d="M15 7h4v4h-3v3h-3V9a2 2 0 0 1 2-2z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  text: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h14"/>',
  github: '<path style="fill:currentColor;stroke:none" d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.6 2.4 1.1 3 .9.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.5 9.5 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/>',
};

function icon(name, cls = "") {
  return `<span class="icon ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[name] || ICONS.sparkle}</svg></span>`;
}

function deco() {
  return "";
}

function scoreTone(value) {
  const n = scoreOf(value);
  if (n >= 75) return "lilac";
  if (n >= 50) return "honey";
  return "orange";
}

function bar(label, value, tone = "") {
  const n = scoreOf(value);
  return `<div class="scorebar"><p>${html(label)}<b>${n}점</b></p><span><i class="${tone || scoreTone(n)}" style="width:${n}%"></i></span></div>`;
}

function card(title, body, cls = "", iconName = "") {
  const head = title ? `<h3>${iconName ? icon(iconName) : ""}${html(title)}</h3>` : "";
  return `<article class="card ${cls}">${head}${body}</article>`;
}

function toneOf(text) {
  const t = String(text || "").toLowerCase();
  if (/높음|심각|누락|부족|위험|미흡|high|critical/.test(t)) return "bad";
  if (/보통|보완|주의|개선|medium|moderate/.test(t)) return "warn";
  if (/낮음|양호|우수|좋음|통과|완료|적정|low|good|pass/.test(t)) return "good";
  return "";
}

function badge(text, tone = "") {
  const value = asText(text, "").trim();
  if (!value) return "";
  return `<span class="badge ${tone || toneOf(value)}">${html(value)}</span>`;
}

function emptyState(title, text, iconName = "sparkle") {
  return `<section class="empty"><span class="circle-icon lg">${icon(iconName)}</span><b>${html(title)}</b><p>${html(text)}</p></section>`;
}

function alertBox(title, bodyHtml) {
  return `<div class="alert">${icon("alert")}<div><b>${html(title)}</b><p>${bodyHtml}</p></div></div>`;
}

function fileChip(file, placeholder) {
  return file
    ? `<small class="file-chip" title="${html(file.name)}">${html(file.name)}</small>`
    : `<small>${html(placeholder)}</small>`;
}

function setView(view, tab = state.tab) {
  state.view = view;
  state.tab = tab;
  render();
}

function setTab(tab) {
  state.view = "demo";
  state.tab = tab;
  render();
}

/* ==========================================================================
   HOME — "The product performs" (design-taste-frontend direction sheet)
   Idea: on this page the rehearsal record the app returns (score sheet,
   timestamped transcript, page-by-page log, judges' questions) is the picture;
   every picture is a working fragment of the product at true size.
   Live thing: the transcript sheet listens to the visitor's own voice.
   ========================================================================== */

const NAV_LINKS = [
  ["practice", "발표 연습"],
  ["analysis", "분석 결과"],
  ["questions", "예상 질문"],
];

const SAMPLE = {
  deck: "sample_pitch_deck.pptx",
  audio: "sample_pitch.m4a",
  date: "2026-10-15",
  length: "5분 12초",
  scores: [["발표 흐름", 82], ["내용 전달력", 76], ["Q&A 대응", 70], ["시간 관리", 85]],
  total: 78,
  grade: "B+",
  status: "통과 권장",
  summary: "전반적으로 구조가 명확하고 핵심 메시지 전달이 좋습니다. 중반부에 추임새가 집중되고 시장 규모 근거가 약합니다.",
  lines: [
    ["00:00", "안녕하세요, 오늘 발표를 맡은 발표자입니다.", "화자 1 · 공백 0초"],
    ["00:08", "저희는 발표 연습을 돕는 AI 심사 서비스를 만들고 있습니다.", "화자 1 · 공백 0.6초"],
    ["00:17", "시장은 어, 엄청 큰 시장이고요.", "화자 1 · 공백 1.2초"],
    ["00:24", "국내 TAM은 약 1,200억 원 규모로 추정됩니다.", "화자 1 · 공백 0.4초"],
    ["00:33", "그, 기존 서비스는 문서 요약에 그치고 평가는 하지 못합니다.", "화자 1 · 공백 0.9초"],
    ["00:42", "저희 기술은 자료 페이지와 음성 구간을 자동으로 매칭합니다.", "화자 1 · 공백 0.5초"],
  ],
  fillers: [["어", 6], ["그", 3], ["음", 3], ["이제", 2]],
  pages: [
    ["1", "00:00–00:42", "42초", "안녕하세요, 오늘 발표를 맡은 발표자입니다. 저희는…", 42, 82],
    ["2", "00:42–01:52", "1분 10초", "시장은 어, 엄청 큰 시장이고요. 국내 TAM은…", 70, 64],
    ["3", "01:52–02:31", "39초", "저희 기술은 자료 페이지와 음성 구간을…", 39, 71],
  ],
  questions: [
    ["투자 심사역", "목표 시장 규모와 그 근거 자료는 무엇입니까?", "상"],
    ["기술 전문가", "경쟁사 대비 핵심 기술 차별점은 무엇입니까?", "중"],
    ["산업 전문가", "초기 고객 확보 전략은 무엇입니까?", "중"],
  ],
  judges: [
    ["투자 심사역 AI", 74, "시장 규모 수치는 있으나 산출 근거가 약합니다. SAM·SOM을 구분해 주세요."],
    ["기술 전문가 AI", 81, "페이지–음성 매칭 방식이 명확합니다. 정확도 검증 데이터를 덧붙이면 좋겠습니다."],
    ["산업 전문가 AI", 79, "초기 고객을 대학 창업지원단으로 좁힌 점이 설득력 있습니다."],
  ],
  answer: [["논리성", 76], ["구체성", 68], ["자신감", 80], ["시간 관리", 64]],
  pace: [128, 135, 152, 141, 130, 137],
};

const STAGES = [
  ["먼저,", "자료와 음성을 올린다"],
  ["다음,", "넘기며 말한다"],
  ["그러면,", "숫자로 돌아온다"],
  ["끝으로,", "심사표를 받는다"],
];

const RETURNS = [
  ["발화", "var(--lilac)", [
    ["평균 발화 속도", "분당 어절, 권장 120–150"],
    ["추임새 횟수", "어, 그, 음, 이제"],
    ["문장별 공백", "초 단위"],
    ["화자별 발화 시간", "초, WPM"],
  ]],
  ["자료", "var(--honey)", [
    ["자료 반영률", "%"],
    ["자료 외 발화 비율", "%"],
    ["누락 키워드", "구간별 목록"],
    ["페이지별 체류시간", "분:초"],
    ["슬라이드별 피드백", "한 줄"],
  ]],
  ["심사", "#ffffff", [
    ["발표 흐름", "100점 만점"],
    ["내용 전달력", "100점 만점"],
    ["Q&A 대응", "100점 만점"],
    ["시간 관리", "100점 만점"],
    ["종합 점수와 등급", "예: 78점, B+"],
    ["발견된 문제점", "높음, 보통, 낮음"],
    ["보완 사항", "우선순위"],
  ]],
  ["질문", "var(--orange)", [
    ["투자 심사역 AI", "투자 매력도, ROI, Exit"],
    ["기술 전문가 AI", "실현 가능성, 특허, R&D"],
    ["산업 전문가 AI", "시장성, 경쟁, 진입 장벽"],
    ["답변 평가", "100점, 모범 답변"],
  ]],
  ["번역", "#8f86ff", [
    ["영어", "en"], ["일본어", "ja"], ["중국어 간체", "zh"], ["스페인어", "es"],
    ["프랑스어", "fr"], ["독일어", "de"], ["베트남어", "vi"], ["인도네시아어", "id"],
  ]],
];

/* ---------- shell ---------- */
function renderTopbar() {
  const onDark = state.view === "demo";
  const top = $("topbar");
  top.className = `topbar ${onDark ? "on-dark" : "plain"}`;
  top.innerHTML = `
    <div class="topbar-inner">
      <a class="brand" href="#" onclick="setView('home');return false;">${icon("mic")}<span>발표평가</span></a>
      <nav class="topnav" aria-label="주요 메뉴">
        ${NAV_LINKS.map(([id, label]) => `<button class="${onDark && state.tab === id ? "active" : ""}" onclick="setTab('${id}')">${label}</button>`).join("")}
      </nav>
      <div class="topbar-actions">
        <button class="btn lilac" onclick="setView('demo','upload')">사전심사 시작</button>
      </div>
    </div>`;
}

function renderFooter() {
  const foot = $("siteFooter");
  foot.className = "site-footer";
  foot.innerHTML = `
    <div class="foot-grid">
      <div class="foot-brand">
        <span class="foot-logo"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M8 21h8"/></svg>발표평가</span>
        <p>AI 심사위원 사전심사. 발표 음성과 자료를 올리면 전사문, 심사표, 예상 질문을 돌려줍니다.</p>
      </div>
      <nav class="foot-col" aria-label="바로가기"><span class="foot-k">바로가기</span>${NAV_LINKS.map(([id, label]) => `<button onclick="setTab('${id}')">${label}</button>`).join("")}</nav>
      <div class="foot-col"><span class="foot-k">결과물</span><span>문장별 전사문</span><span>심사표와 점수</span><span>예상 질문</span><span>PDF 리포트</span></div>
    </div>
    <div class="foot-line"><span>© 2026 STT Presentation Review</span><span>AI 발표 사전심사 도구</span></div>`;
}

/* ---------- interface fragments (data-ui: the product's own conventions) ---------- */
function uiBars(scores, cls = "") {
  return `<div class="bar ${cls}">${scores.map(([k, v]) => `<p>${html(k)}<b>${v}점</b></p><span><i class="${v >= 75 ? "" : v >= 50 ? "honey" : "orange"}" style="width:${v}%"></i></span>`).join("")}</div>`;
}

function uiTimeline(lines, id = "") {
  return `<ol class="tl" ${id ? `id="${id}"` : ""}>${lines.map(([t, text, meta]) => `<li><span class="t">${html(t)}</span><div><span class="m">${html(meta)}</span><p>${html(text)}</p></div></li>`).join("")}</ol>`;
}

function uiSpark(values, height = "100%") {
  const max = Math.max(...values);
  return `<span class="ui-spark" style="height:${height}">${values.map((v) => `<i class="${v > 150 ? "hi" : ""}" style="height:${Math.round(v / max * 100)}%"></i>`).join("")}</span>`;
}

function fragPractice() {
  return `<div class="frag-practice" data-ui>
    <div class="ui-head">
      <div><b>${SAMPLE.deck}</b><br><small>PPTX · 2/3 페이지</small></div>
      <div class="ui-clock"><strong>01:52</strong><small>전체</small><strong>00:40</strong><small>현재</small></div>
    </div>
    <div class="ui-slide"><span>Slide 2</span><b>해결책</b><p>자료 페이지와 음성 구간을 자동으로 매칭합니다.</p><ul><li>다음 페이지를 누르는 순간 체류시간이 저장됩니다</li><li>그 사이 말한 문장은 이 페이지의 전사 구간이 됩니다</li></ul></div>
    <div class="ui-foot"><div class="ui-dots"><i>1</i><i class="on">2</i><i>3</i></div><span class="ui-chip live">발표 중 · Page 2 · 00:42부터</span></div>
  </div>`;
}

function fragTranscript() {
  return `<div class="frag-transcript" data-ui>
    <div class="ui-head" style="padding:0 0 8px;border:0"><div><b>문장별 전사문</b><br><small>화자 1 · 42문장</small></div><span class="ui-chip">CLOVA Speech</span></div>
    ${uiTimeline(SAMPLE.lines.slice(0, 3))}
  </div>`;
}

function fragScore() {
  return `<div class="frag-sheet" data-ui>
    <div class="ui-head" style="grid-column:1/-1;padding:0 0 10px;border:0"><div><b>발표평가 심사표</b><br><small>${SAMPLE.audio} · ${SAMPLE.date}</small></div></div>
    ${uiBars(SAMPLE.scores)}
    <div class="side"><div class="ui-score"><b>${SAMPLE.total}</b><small>/100</small></div><span class="ui-grade">${SAMPLE.grade}</span><span class="ui-chip good">${SAMPLE.status}</span></div>
  </div>`;
}

function fragQuestion() {
  const [who, q, level] = SAMPLE.questions[0];
  return `<div class="frag-question" data-ui>
    <div class="m"><span class="ui-chip">${html(who)}</span><span>난이도 ${html(level)} · 권장 답변 90초</span></div>
    <p class="q">${html(q)}</p>
    <div class="a"><b>답변 평가 72점</b> · 강점: 수치를 언급함 · 개선: SAM/SOM 구분 필요</div>
  </div>`;
}

function fragUpload() {
  return `<div class="frag-upload" data-ui>
    <div class="ui-head" style="padding:0;border:0"><div><b>발표자료 등록</b><br><small>음성 파일과 PPT/PDF</small></div></div>
    <div class="two">
      <div class="ui-drop has"><b>발표 음성</b><small>${SAMPLE.audio}</small></div>
      <div class="ui-drop has"><b>발표자료</b><small>${SAMPLE.deck}</small></div>
    </div>
    <div style="display:flex;gap:8px"><button class="ui-btn" type="button" tabindex="-1">발표 연습으로 이동</button><button class="ui-btn orange" type="button" tabindex="-1">바로 분석하기</button></div>
  </div>`;
}

function fragClock() {
  return `<div class="frag-clock" data-ui>
    <div class="row"><div><b>${SAMPLE.deck}</b><br><small style="color:var(--muted)">PPTX · 2/3 페이지</small></div><span class="ui-chip live">발표 중</span></div>
    <div class="ui-clock"><strong>01:52</strong><small>전체 발표 시간</small><strong>00:40</strong><small>현재 페이지</small></div>
    <div class="row"><div class="ui-dots"><i>1</i><i class="on">2</i><i>3</i></div><button class="ui-btn quiet" type="button" tabindex="-1">다음 페이지</button></div>
    <div class="ui-record"><b>Page 1</b><span>00:00–00:42 · 42초</span><small>안녕하세요, 오늘 발표를 맡은 발표자입니다.</small></div>
  </div>`;
}

function fragMetrics() {
  return `<div class="frag-metrics" data-ui>
    <div class="three">
      <div class="ui-metric"><strong>78<small>/100</small></strong><small>종합 점수</small></div>
      <div class="ui-metric"><strong>138<small>WPM</small></strong><small>평균 발화 속도</small></div>
      <div class="ui-metric"><strong>14<small>회</small></strong><small>추임새</small></div>
    </div>
    <div class="chart">${uiSpark(SAMPLE.pace)}</div>
    <div class="ui-counts"><span>구간별 WPM</span><span>권장 120–150</span><span style="color:var(--warn)">2:00 구간 152, 빠름</span></div>
  </div>`;
}

function fragReport() {
  return `<div class="frag-report" data-ui>
    <div class="top"><div><b>발표평가 심사표</b><br><small style="color:var(--muted)">${SAMPLE.audio} · ${SAMPLE.date}</small></div><span class="ui-grade">${SAMPLE.grade}</span></div>
    ${uiBars(SAMPLE.scores)}
    <div class="row" style="display:flex;justify-content:space-between;align-items:center;gap:10px"><div class="ui-score"><b>${SAMPLE.total}</b><small>/100 · ${SAMPLE.status}</small></div><button class="ui-btn" type="button" tabindex="-1">${icon("download")}PDF 리포트</button></div>
  </div>`;
}

function fragDialog() {
  return `<form class="frag-dialog" data-ui onsubmit="ctaStart(event)">
    <h3>발표자료 등록</h3>
    <div class="ui-field"><label for="ctaTitle">발표 제목</label><input id="ctaTitle" type="text" value="2026 예비창업패키지 IR 발표" autocomplete="off"></div>
    <div class="ui-seg" role="group" aria-label="시작 방법">
      <button type="button" aria-pressed="true" onclick="ctaChoose(this,'upload')">음성 파일 올리기</button>
      <button type="button" aria-pressed="false" onclick="ctaChoose(this,'record')">지금 녹음하기</button>
    </div>
    <button class="ui-btn" type="submit">사전심사 시작</button>
  </form>`;
}

/* ---------- the output sheets ---------- */
function sheetHead(title, meta, chip = "") {
  return `<div class="sh-head"><div><b>${title}</b><small>${meta}</small></div>${chip}</div>`;
}

function sheetScore() {
  return `<div class="sheet is-on" data-out="score" data-ui>
    ${sheetHead("발표평가 심사표", `${SAMPLE.audio} · ${SAMPLE.date} · ${SAMPLE.length}`, `<span class="ui-chip good">${SAMPLE.status}</span>`)}
    <div class="sh-body cols">
      <div class="col">
        ${uiBars(SAMPLE.scores)}
        <div class="sh-total"><div class="ui-score"><b>${SAMPLE.total}</b><small>/100</small></div><p>발표 흐름 · 내용 전달력 · Q&A 대응 · 시간 관리 점수에 자료 반영률을 더한 종합 점수입니다.</p><span class="ui-grade">${SAMPLE.grade}</span></div>
        <table>
          <thead><tr><th>항목</th><th>측정값</th><th>판정</th></tr></thead>
          <tbody>
            <tr><td>평균 발화 속도</td><td class="n">138 WPM</td><td><span class="ui-chip good">권장 범위</span></td></tr>
            <tr><td>추임새</td><td class="n">14회</td><td><span class="ui-chip warn">보통</span></td></tr>
            <tr><td>자료 반영률</td><td class="n">71%</td><td><span class="ui-chip warn">보완</span></td></tr>
            <tr><td>자료 외 발화</td><td class="n">18%</td><td><span class="ui-chip good">양호</span></td></tr>
          </tbody>
        </table>
      </div>
      <div class="col">
        <p class="sh-k">심사위원 AI 의견</p>
        ${SAMPLE.judges.map(([who, score, text]) => `<div class="ui-record"><b>${html(who)} · ${score}점</b><small>${html(text)}</small></div>`).join("")}
        <p class="sh-k">종합 의견</p>
        <p class="sh-p">${SAMPLE.summary}</p>
        <div class="ui-counts"><span>문제점 <b>3건</b></span><span>보완 사항 <b>2건</b></span><span>예상 질문 <b>10개</b></span></div>
      </div>
    </div>
  </div>`;
}

function sheetTranscript() {
  return `<div class="sheet" data-out="transcript" data-ui>
    ${sheetHead("문장별 전사문", `화자 1 · 42문장 · ${SAMPLE.length}`, `<span class="ui-chip">CLOVA Speech</span>`)}
    <div class="sh-body cols">
      <div class="col">${uiTimeline(SAMPLE.lines, "liveLines")}</div>
      <div class="col">
        <div class="three">
          <div class="ui-metric"><strong>138<small>WPM</small></strong><small>평균 발화 속도</small></div>
          <div class="ui-metric"><strong>14<small>회</small></strong><small>추임새</small></div>
          <div class="ui-metric"><strong>0.7<small>초</small></strong><small>평균 공백</small></div>
        </div>
        <p class="sh-k">추임새 단어</p>
        <div class="ui-counts">${SAMPLE.fillers.map(([w, n]) => `<span>“${html(w)}” <b>${n}회</b></span>`).join("")}</div>
        <p class="sh-k">구간별 발화 속도</p>
        <div class="sh-chart">${uiSpark(SAMPLE.pace)}</div>
        <div class="ui-counts"><span>권장 <b>120–150</b></span><span style="color:var(--warn)">2:00 구간 152, 빠름</span></div>
        <div class="live-ctl">
          <div class="row">
            <button class="ui-btn" id="liveBtn" type="button" aria-pressed="false" onclick="homeLiveToggle()">${icon("mic")}마이크로 말해보기</button>
            <span class="st" id="liveStatus">버튼을 누르고 한두 문장을 말하면 이 전사문에 바로 붙습니다.</span>
          </div>
          <div class="ui-counts"><span>어절 <b id="liveWords">0</b></span><span>추임새 <b id="liveFillers">0</b></span><span>분당 어절 <b id="liveWpm">–</b></span></div>
          <details id="liveDetails"><summary>마이크 없이 직접 입력</summary>
            <div class="fb"><textarea id="liveText" placeholder="문장을 붙여 넣고 세어보기를 누르세요."></textarea><button class="ui-btn quiet" type="button" onclick="homeLiveFromText()">세어보기</button></div>
          </details>
        </div>
      </div>
    </div>
  </div>`;
}

function sheetPages() {
  const longest = Math.max(...SAMPLE.pages.map((p) => p[4]));
  return `<div class="sheet" data-out="pages" data-ui>
    ${sheetHead("페이지별 발표 기록", `${SAMPLE.deck} · 3페이지 · 2분 31초`, `<span class="ui-chip live">발표 중 · Page 3</span>`)}
    <div class="sh-body cols">
      <div class="col">
        <table>
          <thead><tr><th>페이지</th><th>구간</th><th>체류</th><th>전사 구간</th></tr></thead>
          <tbody>${SAMPLE.pages.map(([p, span, dur, text]) => `<tr><td><span class="ui-chip">Page ${p}</span></td><td class="n">${span}</td><td class="n">${dur}</td><td>${html(text)}</td></tr>`).join("")}</tbody>
        </table>
        <div class="ui-counts"><span>가장 긴 페이지 <b>Page 2 · 1분 10초</b></span><span>권장 <b>장당 약 50초</b></span></div>
        <div class="ui-record live"><b>Page 3 · 진행 중</b><span>01:52부터 · 39초</span><small>저희 기술은 자료 페이지와 음성 구간을 자동으로 매칭합니다.</small></div>
      </div>
      <div class="col">
        <p class="sh-k">페이지별 체류시간</p>
        <div class="bar">${SAMPLE.pages.map(([p, , dur, , sec]) => `<p>Page ${p}<b>${dur}</b></p><span><i class="${sec > 60 ? "orange" : ""}" style="width:${Math.round(sec / longest * 100)}%"></i></span>`).join("")}</div>
        <p class="sh-k">페이지별 자료 반영률</p>
        <div class="bar">${SAMPLE.pages.map(([p, , , , , match]) => `<p>Page ${p}<b>${match}%</b></p><span><i class="${match >= 75 ? "" : "honey"}" style="width:${match}%"></i></span>`).join("")}</div>
        <div class="ui-counts"><span>평균 반영률 <b>72%</b></span><span>누락 키워드 <b>SAM, SOM, 재구매율</b></span></div>
      </div>
    </div>
  </div>`;
}

function sheetQuestions() {
  return `<div class="sheet" data-out="questions" data-ui>
    ${sheetHead("AI 심사위원 예상 질문", "3인 · 10개 · 권장 답변 90초", `<span class="ui-chip">답변 평가 1/10</span>`)}
    <div class="sh-body cols">
      <div class="col">
        ${SAMPLE.questions.map(([who, q, level], i) => `<div class="q-item ${i === 0 ? "is-on" : ""}"><div class="m"><span class="ui-chip">${html(who)}</span><span>난이도 ${html(level)}</span>${i === 0 ? `<span class="ui-chip good">답변 평가 72점</span>` : ""}</div><p>${html(q)}</p></div>`).join("")}
        <div class="ui-counts"><span>투자 심사역 <b>4개</b></span><span>기술 전문가 <b>3개</b></span><span>산업 전문가 <b>3개</b></span></div>
      </div>
      <div class="col">
        <p class="sh-k">답변 평가 · 질문 1</p>
        ${uiBars(SAMPLE.answer)}
        <div class="ui-record"><b>강점</b><small>시장 규모를 수치로 언급했고 출처를 밝혔습니다.</small></div>
        <div class="ui-record live"><b>개선</b><small>TAM·SAM·SOM을 구분하고 초기 진입 시장을 먼저 말하세요.</small></div>
        <p class="sh-k">모범 답변</p>
        <p class="sh-p">“국내 대학 창업지원단 420곳을 초기 시장으로 보고 있으며, 연 1,200억 원 규모의 TAM 중 3년 내 5%를 목표로 합니다.”</p>
      </div>
    </div>
  </div>`;
}

/* ---------- the page ---------- */
function renderHome() {
  $("homeView").className = "view active home";
  $("homeView").innerHTML = `
    <section class="hero-reel" id="heroReel" aria-label="소개">
      <div class="hero-stage">
        <h1 class="hero-split">
          <span class="half left" data-rise style="--i:0">연습한 발표를</span>
          <span class="half right" data-rise style="--i:1">심사표로 받는다</span>
        </h1>
        <div class="reel-col"><div class="reel-track" id="reelTrack" data-rise style="--i:2">
          <figure class="reel-frame">${fragPractice()}</figure>
          <figure class="reel-frame">${fragTranscript()}</figure>
          <figure class="reel-frame">${fragScore()}</figure>
          <figure class="reel-frame">${fragQuestion()}</figure>
        </div></div>
        <p class="hero-support" data-rise style="--i:3">자료를 넘기며 말하면 페이지별 체류시간과 문장 단위 전사문이 기록되고, AI 심사위원 셋이 점수와 질문을 돌려줍니다.</p>
      </div>
    </section>

    <section class="outputs" aria-labelledby="outputsTitle">
      <h2 id="outputsTitle" class="sr-only">네 가지 결과물</h2>
      <div class="out-names" data-reveal>
        <button class="is-on" data-out="score" onclick="selectOutput('score')">심사표</button>
        <button data-out="transcript" onclick="selectOutput('transcript')">전사문</button>
        <button data-out="pages" onclick="selectOutput('pages')">페이지 기록</button>
        <button data-out="questions" onclick="selectOutput('questions')">예상 질문</button>
      </div>
      <div class="out-stage" data-reveal="scale" style="--i:1">${sheetScore()}${sheetTranscript()}${sheetPages()}${sheetQuestions()}</div>
    </section>

    <section class="picture-words" aria-labelledby="pwTitle">
      <h2 id="pwTitle" class="sr-only">측정하는 것</h2>
      <p class="pw" data-reveal>말한 문장은 시각과 함께 전사되고, 발화 속도는 분당 어절 수로 돌아옵니다. 추임새는 단어별로 세고, 발표자료를 올리면 페이지별 반영률까지 비교합니다.</p>
      <div class="pw-after"><div data-reveal style="--i:2">
        <p class="lead">음성 파일을 올리거나 브라우저 마이크로 바로 녹음할 수 있고, 결과는 PDF 리포트로 내려받습니다.</p>
        <button class="btn lilac lg" onclick="setView('demo','upload')">사전심사 시작</button>
      </div></div>
    </section>

    <section class="hall" aria-label="강의실">
      <figure>
        <div class="pic" data-reveal="scale"><img src="assets/lecture-hall-presentation-2.jpg" width="1024" height="572" alt="강당에서 발표자가 화면 앞에서 설명하고, 청중이 노트북을 펴고 듣고 있다." loading="lazy" decoding="async" onerror="this.closest('.hall').hidden = true"></div>
      </figure>
    </section>

    <section class="stages" id="stages" aria-labelledby="stageClause">
      <div class="stage-left" data-reveal><h2 id="stageClause" aria-live="polite"><span class="w">${STAGES[0][0]}</span><span class="w">${STAGES[0][1]}</span></h2></div>
      <div class="stage-right" data-reveal style="--i:1"><div class="stage-frag" id="stageFrag">
        ${fragUpload().replace("data-ui", 'data-ui class="is-on"')}${fragClock()}${fragMetrics()}${fragReport()}
      </div></div>
      <div class="stage-slider">
        <div class="track"><div class="passed" id="stagePassed"></div><input type="range" id="stageRange" min="0" max="3" step="1" value="0" aria-label="단계" aria-valuetext="${STAGES[0][1]}" oninput="setStage(this.value)"></div>
      </div>
      <ol class="stage-names" id="stageNames"><li class="is-on" onclick="setStage(0)">등록</li><li onclick="setStage(1)">연습</li><li onclick="setStage(2)">분석</li><li onclick="setStage(3)">심사표</li></ol>
    </section>

    <section class="returns" aria-labelledby="returnsTitle">
      <div class="col">
        <h2 id="returnsTitle" data-reveal>분석 지표</h2>
        <div class="grid">
          ${RETURNS.map(([group, color, rows]) => `<div class="grp-block"><p class="grp" data-reveal>${group}</p>${rows.map(([name, val], r) => `<div class="row" data-reveal style="--i:${Math.min(r + 1, 4)}"><i style="--c:${color}"></i><span class="name">${html(name)}</span><span class="val">${html(val)}</span></div>`).join("")}</div>`).join("")}
        </div>
      </div>
    </section>

    <section class="figure" aria-labelledby="figureTitle">
      <h2 id="figureTitle" data-reveal>발표가 몇 분인가요?</h2>
      <div class="slider-ui" data-ui data-reveal style="--i:1">
        <label for="figureRange">발표 시간 <output id="figureOut" for="figureRange">7분</output></label>
        <input class="ui-range" type="range" id="figureRange" min="1" max="20" step="1" value="7" oninput="setFigure(this.value)">
      </div>
      <div></div>
      <div class="bottom">
        <div class="figure-num" data-reveal style="--i:2"><b id="figureVal">945</b><span class="unit">어절</span></div>
        <p class="figure-how" data-reveal style="--i:3">권장 발화 속도 120–150 WPM의 중간값 135에 발표 시간을 곱한 어절 수입니다. 원고가 이보다 길면 그만큼 빨라집니다.</p>
      </div>
    </section>

    <section class="cta-open" aria-labelledby="ctaTitle">
      <div class="close" data-reveal>
        <h2 id="ctaTitle"><span class="w">먼저 심사받고</span><span class="w">무대에 선다</span></h2>
        <p>버튼을 누르면 자료 등록 화면이 열립니다. 음성 파일이 없어도 바로 녹음할 수 있습니다.</p>
      </div>
      <div class="dialog-wrap" data-reveal="scale" style="--i:1">${fragDialog()}</div>
    </section>`;
  initHome();
}

/* ---------- interactions ---------- */
const home = { scroll: null, observer: null, ctaMode: "upload" };
const homeLive = { rec: null, on: false, startMs: 0, lines: [], words: 0, fillers: 0 };
const FILLER_WORDS = new Set(["어", "아", "음", "그", "이제", "일단", "뭐", "저", "막"]);

function initHome() {
  teardownHome();
  initHomeReel();
  initHomeReveal();
  setStage(0);
  setFigure(7);
  // the mouse wheel over the slider card moves the minutes too (the page keeps still while the pointer is on it)
  const sliderUi = document.querySelector(".figure .slider-ui");
  if (sliderUi) sliderUi.addEventListener("wheel", (e) => { e.preventDefault(); const r = $("figureRange"); r.value = Number(r.value) + (e.deltaY < 0 ? 1 : -1); setFigure(r.value); }, { passive: false });
}

function teardownHome() {
  if (home.scroll) {
    window.removeEventListener("scroll", home.scroll);
    window.removeEventListener("resize", home.scroll);
    home.scroll = null;
  }
  if (home.observer) {
    home.observer.disconnect();
    home.observer = null;
  }
  if (homeLive.on && homeLive.rec) homeLive.rec.stop();
}

function initHomeReel() {
  const section = $("heroReel");
  const track = $("reelTrack");
  if (!section || !track) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const stage = section.querySelector(".hero-stage");
  const frames = track.children.length;
  let ticking = false;
  const update = () => {
    const rect = section.getBoundingClientRect();
    const total = section.offsetHeight - (stage ? stage.offsetHeight : window.innerHeight);
    const progress = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 0;
    const step = track.children[0].offsetHeight + 24;
    track.style.transform = `translateY(${(-progress * (frames - 1) * step).toFixed(1)}px)`;
  };
  home.scroll = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => { update(); ticking = false; });
  };
  window.addEventListener("scroll", home.scroll, { passive: true });
  window.addEventListener("resize", home.scroll);
  update();
}

function initHomeReveal() {
  const targets = document.querySelectorAll("#homeView [data-reveal]");
  if (!("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("is-in"));
    return;
  }
  home.observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-in");
        home.observer.unobserve(entry.target);
      }
    }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.05 });
  targets.forEach((el) => home.observer.observe(el));
}

function selectOutput(id) {
  document.querySelectorAll(".out-names button").forEach((b) => b.classList.toggle("is-on", b.dataset.out === id));
  document.querySelectorAll(".out-stage .sheet").forEach((s) => s.classList.toggle("is-on", s.dataset.out === id));
}

function setStage(value) {
  const i = Math.max(0, Math.min(STAGES.length - 1, Number(value) || 0));
  const clause = $("stageClause");
  const range = $("stageRange");
  const passed = $("stagePassed");
  if (!clause || !range) return;
  range.value = String(i);
  range.setAttribute("aria-valuetext", STAGES[i].join(" "));
  clause.innerHTML = `<span class="w">${STAGES[i][0]}</span><span class="w">${STAGES[i][1]}</span>`;
  if (passed) passed.style.width = `${(i / (STAGES.length - 1)) * 100}%`;
  Array.from($("stageNames").children).forEach((li, n) => li.classList.toggle("is-on", n === i));
  Array.from($("stageFrag").children).forEach((frag, n) => frag.classList.toggle("is-on", n === i));
}

function setFigure(minutes) {
  const m = Math.max(1, Math.min(20, Number(minutes) || 7));
  const out = $("figureOut");
  const val = $("figureVal");
  if (out) out.textContent = `${m}분`;
  if (val) val.textContent = (m * 135).toLocaleString("ko-KR");
}

function ctaChoose(button, mode) {
  home.ctaMode = mode;
  button.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
}

function ctaStart(event) {
  if (event) event.preventDefault();
  setView("demo", home.ctaMode === "record" ? "practice" : "upload");
}

/* the live thing: the transcript sheet listens */
function liveTokens(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean);
}

function liveFillerCount(tokens) {
  return tokens.filter((t) => FILLER_WORDS.has(t.replace(/[,.!?…]/g, ""))).length;
}

function liveStatus(text) {
  const el = $("liveStatus");
  if (el) el.textContent = text;
}

function liveRender(withRate) {
  const list = $("liveLines");
  if (!list) return;
  list.querySelectorAll("li.is-live").forEach((li) => li.remove());
  for (const line of homeLive.lines) {
    const li = document.createElement("li");
    li.className = "is-live";
    li.innerHTML = `<span class="t">${html(line.t)}</span><div><span class="m">${html(line.meta)}</span><p>${html(line.text)}</p></div>`;
    list.appendChild(li);
  }
  const tokens = homeLive.lines.flatMap((line) => liveTokens(line.text));
  homeLive.words = tokens.length;
  homeLive.fillers = liveFillerCount(tokens);
  const minutes = homeLive.startMs ? (nowMs() - homeLive.startMs) / 60000 : 0;
  const wpm = withRate && minutes > 0.05 ? Math.round(homeLive.words / minutes) : null;
  if ($("liveWords")) $("liveWords").textContent = String(homeLive.words);
  if ($("liveFillers")) $("liveFillers").textContent = String(homeLive.fillers);
  if ($("liveWpm")) $("liveWpm").textContent = wpm === null ? "–" : String(wpm);
  if (homeLive.lines.length) list.lastElementChild.scrollIntoView({ block: "nearest" });
}

function homeLiveToggle() {
  if (homeLive.on && homeLive.rec) {
    homeLive.rec.stop();
    return;
  }
  if (!SpeechRecognition) {
    liveStatus("이 브라우저는 실시간 음성 인식을 지원하지 않습니다. 아래에 문장을 직접 입력해 세어볼 수 있습니다.");
    if ($("liveDetails")) $("liveDetails").open = true;
    return;
  }
  const rec = new SpeechRecognition();
  rec.lang = "ko-KR";
  rec.continuous = true;
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onstart = () => {
    homeLive.on = true;
    homeLive.startMs = nowMs();
    homeLive.lines = [];
    liveRender(true);
    if ($("liveBtn")) $("liveBtn").setAttribute("aria-pressed", "true");
    liveStatus("듣는 중입니다. 한두 문장을 말하고 다시 누르면 멈춥니다.");
  };
  rec.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript.trim();
      if (!event.results[i].isFinal || !text) continue;
      const tokens = liveTokens(text);
      homeLive.lines.push({ t: formatClock((nowMs() - homeLive.startMs) / 1000), text, meta: `지금 말한 문장 · 어절 ${tokens.length} · 추임새 ${liveFillerCount(tokens)}` });
    }
    liveRender(true);
  };
  rec.onerror = () => {
    homeLive.on = false;
    if ($("liveBtn")) $("liveBtn").setAttribute("aria-pressed", "false");
    liveStatus("마이크를 사용할 수 없습니다. 브라우저의 마이크 권한을 확인하거나 아래에 직접 입력하세요.");
  };
  rec.onend = () => {
    homeLive.on = false;
    if ($("liveBtn")) $("liveBtn").setAttribute("aria-pressed", "false");
    liveRender(true);
    liveStatus(homeLive.lines.length ? `${homeLive.lines.length}문장을 기록했습니다. 실제 분석은 사전심사에서 CLOVA Speech로 다시 전사합니다.` : "들린 문장이 없습니다. 다시 눌러 말해 보세요.");
  };
  homeLive.rec = rec;
  try {
    rec.start();
  } catch (err) {
    liveStatus("음성 인식을 시작하지 못했습니다. 아래에 직접 입력하세요.");
  }
}

function homeLiveFromText() {
  const text = $("liveText") ? $("liveText").value.trim() : "";
  if (!text) {
    liveStatus("세어볼 문장을 먼저 입력하세요.");
    return;
  }
  const tokens = liveTokens(text);
  homeLive.startMs = 0;
  homeLive.lines = [{ t: "직접", text, meta: `직접 입력 · 어절 ${tokens.length} · 추임새 ${liveFillerCount(tokens)}` }];
  liveRender(false);
  liveStatus("직접 입력한 문장은 시간이 없어 분당 어절은 계산하지 않습니다.");
}

const TAB_ITEMS = [
  ["upload", "발표자료 등록", "upload", "발표 음성과 PPT/PDF 자료를 등록하고 바로 분석하거나 발표 연습으로 이어갑니다."],
  ["practice", "발표 연습", "play", "자료를 넘기며 발표하면 페이지별 체류시간과 음성 구간이 기록됩니다."],
  ["questions", "예상 질문 준비", "message", "AI 심사위원의 예상 질문에 답하고 답변 평가를 받습니다."],
  ["analysis", "분석 결과", "chart", "발화 속도, 추임새, 어휘, 자료 일치율을 정량 지표로 확인합니다."],
  ["summary", "종합 결과", "award", "문제점과 보완 사항, AI 종합 의견을 한눈에 봅니다."],
  ["translate", "실시간 번역", "translate", "마이크로 말하면 한국어로 전사되고, 선택한 언어로 바로 번역됩니다."],
];

function tabs() {
  return `<div class="tabs" role="tablist">${TAB_ITEMS.map(([id, label, ic]) => `<button role="tab" aria-selected="${state.tab === id}" class="${state.tab === id ? "active" : ""}" onclick="setTab('${id}')">${icon(ic)}${label}</button>`).join("")}</div>`;
}

function renderDemo() {
  const current = TAB_ITEMS.find(([id]) => id === state.tab) || TAB_ITEMS[0];
  $("demoView").innerHTML = `
    <header class="page-band">
      <div class="band-bg">${deco("deco-blob")}${deco("deco-star")}</div>
      <div class="container page-band-inner">
        <div class="crumb"><button onclick="setView('home')">${icon("home")} 홈</button><span>/</span><span>AI 사전심사</span><span>/</span><span>${current[1]}</span></div>
        <div class="page-title">
          <div><h2>${current[1]}</h2><p>${current[3]}</p></div>
          <div class="page-actions">
            <button class="btn outline-light" onclick="setView('home')">${icon("arrowLeft")}발표평가 홈</button>
            <button class="btn lilac" onclick="downloadReport()">${icon("download")}리포트 다운로드</button>
          </div>
        </div>
        ${tabs()}
      </div>
    </header>
    <div class="demo-body"><div id="tabBody" class="container"></div></div>`;
  renderTab();
}

function renderTab() {
  if (state.tab === "upload") renderUpload();
  if (state.tab === "practice") renderPractice();
  if (state.tab === "questions") renderQuestions();
  if (state.tab === "analysis") renderAnalysis();
  if (state.tab === "summary") renderSummary();
  if (state.tab === "translate") renderTranslate();
}

function renderUpload() {
  const a = state.analysis;
  const transcriptLength = state.streamingTranscript.replace(/\s/g, "").length;
  const sidePanel = a ? `
      <aside class="side-panel on-dark">
        <h3>${icon("award")}분석 완료</h3>
        <p class="sub">${html(a.audio_name || "실시간 전사문 기반 분석")}</p>
        <div class="tiles c3">
          <div class="tile"><b>${html(a.score)}</b><small>종합점수</small></div>
          <div class="tile"><b>${html(a.wpm)}</b><small>WPM</small></div>
          <div class="tile"><b>${a.document_match?.available ? html(a.document_match.score) + "%" : "–"}</b><small>자료 일치율</small></div>
        </div>
        ${Object.entries(displayVoiceScores(a)).map(([k, v]) => bar(k, v)).join("")}
        <button class="btn tint wide" style="margin-top:14px" onclick="setTab('analysis')">${icon("chart")}분석 결과 보기</button>
      </aside>` : `
      <aside class="side-panel">
        <h3>${icon("list")}준비 체크리스트</h3>
        <p class="sub">음성 또는 전사문 하나만 있어도 분석할 수 있습니다.</p>
        <div class="checklist">
          <div class="check-row ${state.selectedFile ? "done" : ""}"><span class="dot">${icon("check")}</span><div><b>발표 음성</b><small>${state.selectedFile ? html(state.selectedFile.name) : "M4A · MP3 · WAV 파일 또는 실시간 STT"}</small></div></div>
          <div class="check-row ${state.selectedMaterial ? "done" : ""}"><span class="dot">${icon("check")}</span><div><b>발표자료</b><small>${state.selectedMaterial ? html(state.selectedMaterial.name) : "PPTX 또는 PDF (선택)"}</small></div></div>
          <div class="check-row ${transcriptLength ? "done" : ""}"><span class="dot">${icon("check")}</span><div><b>실시간 전사문</b><small>${transcriptLength ? `${transcriptLength}자 입력됨` : "발표 연습 탭에서 녹음하면 채워집니다 (선택)"}</small></div></div>
        </div>
        <p class="muted" style="margin:14px 0 0;font-size:13px">발표자료를 업로드하고 발표 연습을 시작하면 페이지별 체류시간과 음성 구간이 함께 기록됩니다.</p>
      </aside>`;
  $("tabBody").innerHTML = `
    <section class="upload-layout">
      <div class="card panel-hero">
        ${deco("deco-star", "a")}${deco("deco-dot", "a")}${deco("deco-dot", "b")}
        <span class="circle-icon lg brain">${icon("mic")}</span>
        <h1>발표자료 등록</h1>
        <p>음성 파일 없이도 발표 연습 탭에서 실시간 STT로 녹음하고 전사할 수 있습니다. PPT/PDF를 함께 올리면 페이지별 발표 구간을 기록합니다.</p>
        <div class="upload-duo">
          <label class="upload-box ${state.selectedFile ? "has-file" : ""}" for="audioInput" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handleAudioDrop(event)">
            <input id="audioInput" type="file" accept=".mp3,.wav,.m4a,.aac,.flac,audio/*" onchange="handleAudioSelected(this)">
            ${icon("volume")}<span>발표 음성 업로드</span>${fileChip(state.selectedFile, "M4A, MP3, WAV 파일을 선택하거나 끌어다 놓으세요")}
          </label>
          <label class="upload-box ${state.selectedMaterial ? "has-file" : ""}" for="materialInput" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handleMaterialDrop(event)">
            <input id="materialInput" type="file" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onchange="handleMaterialSelected(this)">
            ${icon("slides")}<span>PPT/PDF 발표자료 업로드</span>${fileChip(state.selectedMaterial, "PPTX 또는 PDF 파일을 선택하거나 끌어다 놓으세요")}
          </label>
        </div>
        <div class="action-row center">
          <button class="btn lilac" onclick="setTab('practice')">${icon("play")}발표 연습으로 이동</button>
          <button class="btn orange" onclick="analyzePresentation()" ${state.busy ? "disabled" : ""}>${icon("sparkle")}${state.busy ? "분석 중..." : "바로 분석하기"}</button>
        </div>
      </div>
      ${sidePanel}
    </section>`;
}

function renderTranslate() {
  $("tabBody").innerHTML = renderUploadTranslatePanel();
}

function handleAudioSelected(input) {
  applyAudioFile(input.files && input.files.length ? input.files[0] : null);
}

function applyAudioFile(file) {
  state.selectedFile = file;
  renderUpload();
}

function handleMaterialSelected(input) {
  applyMaterialFile(input.files && input.files.length ? input.files[0] : null);
}

function applyMaterialFile(file) {
  state.selectedMaterial = file;
  state.materialPreview = null;
  if (state.materialObjectUrl) URL.revokeObjectURL(state.materialObjectUrl);
  state.materialObjectUrl = state.selectedMaterial ? URL.createObjectURL(state.selectedMaterial) : "";
  renderUpload();
}

function handlePracticeMaterialSelected(input) {
  applyPracticeMaterialFile(input.files && input.files.length ? input.files[0] : null);
}

function applyPracticeMaterialFile(file) {
  state.practiceMaterial = file;
  state.practicePreview = null;
  state.practicePdfDoc = null;
  state.practicePdfRenderKey = "";
  if (state.practiceObjectUrl) URL.revokeObjectURL(state.practiceObjectUrl);
  state.practiceObjectUrl = state.practiceMaterial ? URL.createObjectURL(state.practiceMaterial) : "";
  state.practice.currentPage = 1;
  state.practice.records = [];
  renderPractice();
}

const AUDIO_DROP_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".flac"];
const MATERIAL_DROP_EXTENSIONS = [".pptx", ".pdf"];

function droppedFile(event) {
  const files = event.dataTransfer && event.dataTransfer.files;
  return files && files.length ? files[0] : null;
}

function matchesDropType(file, extensions, mimePrefix) {
  const name = (file.name || "").toLowerCase();
  if (extensions.some((ext) => name.endsWith(ext))) return true;
  return Boolean(mimePrefix && file.type && file.type.startsWith(mimePrefix));
}

function handleUploadDragOver(event) {
  event.preventDefault();
  event.currentTarget.classList.add("drag-over");
}

function handleUploadDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove("drag-over");
}

function handleAudioDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");
  const file = droppedFile(event);
  if (!file) return;
  if (!matchesDropType(file, AUDIO_DROP_EXTENSIONS, "audio/")) {
    alert("지원하지 않는 파일 형식입니다. M4A, MP3, WAV, AAC, FLAC 음성 파일을 올려 주세요.");
    return;
  }
  applyAudioFile(file);
}

function handleMaterialDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");
  const file = droppedFile(event);
  if (!file) return;
  if (!matchesDropType(file, MATERIAL_DROP_EXTENSIONS)) {
    alert("지원하지 않는 파일 형식입니다. PPTX 또는 PDF 발표자료를 올려 주세요.");
    return;
  }
  applyMaterialFile(file);
}

function handlePracticeMaterialDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");
  const file = droppedFile(event);
  if (!file) return;
  if (!matchesDropType(file, MATERIAL_DROP_EXTENSIONS)) {
    alert("지원하지 않는 파일 형식입니다. PPTX 또는 PDF 발표자료를 올려 주세요.");
    return;
  }
  applyPracticeMaterialFile(file);
}

async function fetchMaterialPreview(file) {
  const form = new FormData();
  form.append("material", file);
  const res = await fetch("/api/material-preview", { method: "POST", body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "발표자료 미리보기를 만들 수 없습니다.");
  return data;
}

async function prepareMaterialPreview() {
  if (!state.selectedMaterial) return null;
  if (state.materialPreview) return state.materialPreview;
  const data = await fetchMaterialPreview(state.selectedMaterial);
  state.materialPreview = data;
  return data;
}

async function preparePracticePreview() {
  if (!state.practiceMaterial) return null;
  if (state.practicePreview) return state.practicePreview;
  const data = await fetchMaterialPreview(state.practiceMaterial);
  if (String(data.type || "").toUpperCase() === "PDF") {
    const pdfDoc = await loadPracticePdfDocument();
    if (pdfDoc?.numPages) data.page_count = pdfDoc.numPages;
  }
  state.practicePreview = data;
  return data;
}

function isPracticePdf() {
  return String(state.practicePreview?.type || "").toUpperCase() === "PDF";
}

async function loadPracticePdfDocument() {
  if (state.practicePdfDoc) return state.practicePdfDoc;
  if (!state.practiceMaterial || !window.pdfjsLib) return null;
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    window.pdfjsLib.GlobalWorkerOptions.workerSrc ||
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const data = await state.practiceMaterial.arrayBuffer();
  state.practicePdfDoc = await window.pdfjsLib.getDocument({ data }).promise;
  return state.practicePdfDoc;
}

async function renderPractice() {
  if (!state.practiceMaterial) {
    $("tabBody").innerHTML = `
      <section class="practice-setup">
        ${deco("deco-star", "a")}${deco("deco-dot", "a")}
        <span class="circle-icon lg brain">${icon("slides")}</span>
        <h2>발표 연습 자료 첨부</h2>
        <p>이 탭에서 사용할 PPT/PDF를 별도로 첨부하세요. 발표자료 등록 탭의 파일과는 독립적으로 관리됩니다.</p>
        <label class="upload-box practice-upload" for="practiceMaterialInput" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handlePracticeMaterialDrop(event)">
          <input id="practiceMaterialInput" type="file" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onchange="handlePracticeMaterialSelected(this)">
          ${icon("upload")}<span>PPT/PDF 발표자료 첨부</span><small>발표 연습에서만 사용하는 자료입니다. 파일을 끌어다 놓아도 됩니다.</small>
        </label>
      </section>`;
    return;
  }
  if (!state.practicePreview) {
    $("tabBody").innerHTML = emptyState("발표자료를 불러오는 중입니다", "페이지를 준비하고 있습니다. 잠시만 기다려 주세요.", "refresh");
    try {
      await preparePracticePreview();
    } catch (err) {
      $("tabBody").innerHTML = emptyState("발표자료를 불러오지 못했습니다", userErrorMessage(err, "파일 형식을 확인해 주세요."), "alert");
      return;
    }
  }

  const preview = state.practicePreview || {};
  const total = Math.max(1, Number(preview.page_count || preview.sections?.length || 1));
  const current = Math.min(Math.max(1, state.practice.currentPage), total);
  state.practice.currentPage = current;
  const active = state.practice.active;
  $("tabBody").innerHTML = `
    <section class="practice-layout">
      <article class="practice-stage">
        <div class="practice-toolbar">
          <div class="file-title">
            <span class="circle-icon soft">${icon("slides")}</span>
            <div>
              <b title="${html(state.practiceMaterial.name)}">${html(state.practiceMaterial.name)}</b>
              <span>${html(preview.type || "")} · ${current}/${total} 페이지${active ? ` <span class="badge orange">발표 중</span>` : ""}</span>
            </div>
          </div>
          <div class="practice-clock">
            <strong id="practiceTotalClock">${formatClock(practiceElapsedSec())}</strong>
            <small>전체 발표 시간</small>
            <strong id="practicePageClock">${formatClock(currentPageElapsedSec())}</strong>
            <small>현재 페이지</small>
          </div>
        </div>
        ${renderMaterialPage(preview, current)}
        <div class="practice-nav">
          <button id="practicePrevBtn" class="btn outline" onclick="prevPracticePage()" ${current <= 1 || active ? "disabled" : ""}>${icon("arrowLeft")}이전 페이지</button>
          <div class="page-dots">${Array.from({ length: total }, (_, i) => `<button class="${i + 1 === current ? "active" : ""}" onclick="jumpPracticePage(${i + 1})" ${active ? "disabled" : ""}>${i + 1}</button>`).join("")}</div>
          <button id="practiceNextBtn" class="btn outline" onclick="nextPracticePage()" ${!active && current >= total ? "disabled" : ""}>다음 페이지${icon("arrowRight")}</button>
        </div>
      </article>
      <aside class="practice-side">
        <h3>${icon("mic")}실시간 발표 기록</h3>
        <p class="sub">발표 시작을 누르면 마이크 녹음과 전사가 함께 시작됩니다.</p>
        <div class="tiles c2">
          <div class="tile"><b id="practiceSideClock">${formatClock(practiceElapsedSec())}</b><small>녹음/전사 시간</small></div>
          <div class="tile"><b id="practiceSegmentCount">${state.streamingTimeline.length}</b><small>전사 구간</small></div>
        </div>
        <div class="action-row">
          <button id="practiceStartBtn" class="btn lilac" onclick="startPractice()" ${active ? "disabled" : ""}>${icon("play")}발표 시작</button>
          <button id="practiceFinishBtn" class="btn outline" onclick="finishPractice()" ${!active ? "disabled" : ""}>${icon("stop")}발표 종료</button>
          <button id="practiceAnalyzeBtn" class="btn orange" onclick="analyzePractice()" ${state.busy || active || !practiceTranscript().trim() ? "disabled" : ""}>${state.busy ? "분석 중..." : "연습 분석하기"}</button>
        </div>
        <p class="muted" style="font-size:13px;margin:12px 0 0">다음 페이지를 누를 때마다 해당 페이지 체류시간과 음성 구간이 저장됩니다.</p>
        ${renderPracticeRecords()}
      </aside>
    </section>`;
  if (isPracticePdf()) {
    renderPracticePdfPage(current);
  }
}

function updatePracticeClocks() {
  const total = $("practiceTotalClock");
  const page = $("practicePageClock");
  const side = $("practiceSideClock");
  if (total) total.textContent = formatClock(practiceElapsedSec());
  if (page) page.textContent = formatClock(currentPageElapsedSec());
  if (side) side.textContent = formatClock(practiceElapsedSec());
}

function updatePracticeControls() {
  const total = Math.max(1, Number(state.practicePreview?.page_count || state.practicePreview?.sections?.length || 1));
  const start = $("practiceStartBtn");
  const finish = $("practiceFinishBtn");
  const analyze = $("practiceAnalyzeBtn");
  const prev = $("practicePrevBtn");
  const next = $("practiceNextBtn");
  const count = $("practiceSegmentCount");
  if (start) start.disabled = state.practice.active;
  if (finish) finish.disabled = !state.practice.active;
  if (analyze) {
    analyze.disabled = state.busy || state.practice.active || !practiceTranscript().trim();
    analyze.textContent = state.busy ? "분석 중..." : "연습 분석하기";
  }
  if (prev) prev.disabled = state.practice.active || state.practice.currentPage <= 1;
  if (next) next.disabled = !state.practice.active && state.practice.currentPage >= total;
  if (count) count.textContent = String(state.streamingTimeline.length);
}

function renderMaterialPage(preview, page) {
  const type = String(preview.type || "").toUpperCase();
  if (type === "PDF" && state.practiceObjectUrl) {
    if (window.pdfjsLib) {
      return `
        <div id="practicePdfShell" class="pdf-page-shell">
          <div class="pdf-zoom-tools">
            <button class="btn outline sm" onclick="setPracticePdfZoom(-0.15)">${icon("minus")}축소</button>
            <span>${Math.round(state.practicePdfZoom * 100)}%</span>
            <button class="btn outline sm" onclick="setPracticePdfZoom(0.15)">${icon("plus")}확대</button>
            <button class="btn outline sm" onclick="resetPracticePdfZoom()">${icon("fit")}맞춤</button>
          </div>
          <canvas id="practicePdfCanvas"></canvas>
          <p class="muted">PDF ${page}페이지를 불러오는 중입니다.</p>
        </div>`;
    }
    return `<iframe class="pdf-frame" src="${state.practiceObjectUrl}#page=${page}&zoom=page-fit&toolbar=0&navpanes=0&scrollbar=0"></iframe>`;
  }
  const section = (preview.sections || []).find((item) => Number(item.page) === page) || {};
  return `
    <div class="pptx-page">
      <span>Slide ${page}</span>
      <h2>${html(section.title || `발표자료 ${page}`)}</h2>
      <p>${html(section.text || "이 슬라이드는 이미지 중심이거나 텍스트를 추출할 수 없습니다. PDF로 변환하면 실제 페이지 형태로 확인할 수 있습니다.")}</p>
    </div>`;
}

async function renderPracticePdfPage(pageNumber) {
  const shell = $("practicePdfShell");
  const canvas = $("practicePdfCanvas");
  if (!shell || !canvas) return;
  try {
    const doc = await loadPracticePdfDocument();
    if (!doc) return;
    const page = await doc.getPage(Math.max(1, Math.min(pageNumber, doc.numPages)));
    const baseViewport = page.getViewport({ scale: 1 });
    const availableWidth = Math.max(520, shell.clientWidth - 32);
    const cssWidth = availableWidth * state.practicePdfZoom;
    const viewport = page.getViewport({ scale: cssWidth / baseViewport.width });
    const outputScale = Math.min(window.devicePixelRatio || 1, 3);
    const context = canvas.getContext("2d");
    const key = `${pageNumber}-${Math.round(viewport.width)}x${Math.round(viewport.height)}-${outputScale}`;
    if (canvas.dataset.renderKey === key) return;
    state.practicePdfRenderKey = key;
    canvas.dataset.renderKey = key;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;
    context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
    context.clearRect(0, 0, viewport.width, viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    const note = shell.querySelector("p");
    if (note) note.remove();
  } catch (err) {
    shell.innerHTML = `<iframe class="pdf-frame" src="${state.practiceObjectUrl}#page=${pageNumber}&zoom=page-fit&toolbar=0&navpanes=0&scrollbar=0"></iframe>`;
  }
}

function setPracticePdfZoom(delta) {
  state.practicePdfZoom = Math.max(0.9, Math.min(2.4, Number((state.practicePdfZoom + delta).toFixed(2))));
  state.practicePdfRenderKey = "";
  renderPractice();
}

function resetPracticePdfZoom() {
  state.practicePdfZoom = 1;
  state.practicePdfRenderKey = "";
  renderPractice();
}

function renderPracticeRecords() {
  return `<div id="practiceRecords" class="practice-records">${practiceRecordsHtml()}</div>`;
}

function practiceRecordsHtml() {
  const rows = state.practice.records || [];
  const live = livePracticeRecord();
  const allRows = live ? [...rows, live] : rows;
  if (!allRows.length) return `<p class="muted" style="font-size:13px">아직 기록된 페이지 구간이 없습니다. 발표 시작 후 실시간 로그가 표시됩니다.</p>`;
  return allRows.map((r) => `
    <div class="practice-record ${r.live ? "live" : ""}">
      <b>Page ${html(r.page)}${r.live ? " · 진행 중" : ""}</b>
      <span>${html(formatClock(r.start))}–${html(formatClock(r.end))} · ${html(formatDuration(r.duration))}</span>
      <small>${html(r.transcript || "해당 구간 전사문 없음")}</small>
    </div>`).join("");
}

function livePracticeRecord() {
  if (!state.practice.active || !state.practice.pageStartedAtMs || !state.practice.startedAtMs) return null;
  const start = (state.practice.pageStartedAtMs - state.practice.startedAtMs) / 1000;
  const end = practiceElapsedSec();
  const transcript = transcriptForRange(start, end) || state.streamingInterim;
  return {
    page: state.practice.currentPage,
    start,
    end,
    duration: Math.max(0, end - start),
    transcript,
    live: true,
  };
}

function practiceTranscript() {
  const parts = [];
  if (state.streamingTranscript.trim()) parts.push(state.streamingTranscript.trim());
  const recordText = (state.practice.records || [])
    .map((record) => record.transcript || "")
    .join("\n")
    .trim();
  if (recordText && !parts.includes(recordText)) parts.push(recordText);
  if (state.streamingInterim.trim()) parts.push(state.streamingInterim.trim());
  return parts.join("\n").trim();
}

function updatePracticeRecordsLive() {
  const records = $("practiceRecords");
  if (records) records.innerHTML = practiceRecordsHtml();
}

async function startPractice() {
  if (!state.practiceMaterial) {
    alert("먼저 PPT/PDF 발표자료를 업로드하세요.");
    return;
  }
  await preparePracticePreview();
  clearStreaming(false);
  state.practice.active = true;
  state.practice.startedAtMs = nowMs();
  state.practice.pageStartedAtMs = nowMs();
  state.practice.currentPage = 1;
  state.practice.records = [];
  state.practice.tick = window.setInterval(() => {
    if (state.tab === "practice") {
      updatePracticeClocks();
      updatePracticeRecordsLive();
    }
  }, 1000);
  updatePracticeControls();
  await startStreaming({ renderAfterStart: false });
  updatePracticeControls();
}

function transcriptForRange(start, end) {
  return (state.streamingTimeline || [])
    .filter((item) => Number(item.end || 0) >= start && Number(item.start || 0) <= end)
    .map((item) => item.text)
    .join(" ")
    .trim();
}

function recordCurrentPracticePage() {
  if (!state.practice.active || !state.practice.pageStartedAtMs || !state.practice.startedAtMs) return;
  const start = (state.practice.pageStartedAtMs - state.practice.startedAtMs) / 1000;
  const end = practiceElapsedSec();
  const duration = Math.max(0, end - start);
  if (duration < 0.3) return;
  state.practice.records.push({
    page: state.practice.currentPage,
    start,
    end,
    duration,
    transcript: transcriptForRange(start, end),
  });
  state.practice.pageStartedAtMs = nowMs();
}

function nextPracticePage() {
  const total = Math.max(1, Number(state.practicePreview?.page_count || state.practicePreview?.sections?.length || 1));
  if (state.practice.active) recordCurrentPracticePage();
  if (state.practice.currentPage < total) {
    state.practice.currentPage += 1;
    state.practicePdfRenderKey = "";
  } else if (state.practice.active) {
    finishPractice();
    return;
  }
  renderPractice();
}

function prevPracticePage() {
  if (state.practice.active) return;
  state.practice.currentPage = Math.max(1, state.practice.currentPage - 1);
  state.practicePdfRenderKey = "";
  renderPractice();
}

function jumpPracticePage(page) {
  if (state.practice.active) return;
  state.practice.currentPage = Math.max(1, Number(page || 1));
  state.practicePdfRenderKey = "";
  renderPractice();
}

function finishPractice() {
  if (state.practice.active) recordCurrentPracticePage();
  state.practice.active = false;
  state.practice.startedAtMs = null;
  state.practice.pageStartedAtMs = null;
  if (state.practice.tick) window.clearInterval(state.practice.tick);
  state.practice.tick = 0;
  stopStreaming();
  updatePracticeControls();
  renderPractice();
}

const TARGET_LANGS = [
  ["en", "영어"], ["ja", "일본어"], ["zh", "중국어 간체"], ["es", "스페인어"],
  ["fr", "프랑스어"], ["de", "독일어"], ["vi", "베트남어"], ["id", "인도네시아어"],
];

function langSelect() {
  return `<label class="streaming-select">${icon("translate")}번역 언어
    <select onchange="setTargetLang(this.value)">
      ${TARGET_LANGS.map(([value, label]) => `<option value="${value}" ${state.targetLang === value ? "selected" : ""}>${label}</option>`).join("")}
    </select>
  </label>`;
}

function statusPill(status, listening = false) {
  if (listening) return `<span class="status-pill live">전사 중</span>`;
  const text = String(status || "대기");
  const cls = text === "완료" ? "done" : text === "오류" ? "error" : text === "번역 중" ? "live" : "";
  return `<span class="status-pill ${cls}">${html(text)}</span>`;
}

function timelineItems(timeline, withPage, emptyText) {
  if (!timeline.length) return `<p class="muted">${html(emptyText)}</p>`;
  return timeline.map((item, index) => `
    <div class="stream-timeline-item">
      <b>${html(item.time)}</b>
      <span>구간 ${index + 1}${withPage && item.page ? ` · Page ${html(item.page)}` : ""}</span>
      <p>${html(item.text)}</p>
    </div>`).join("");
}

function interimItem() {
  if (!state.streamingInterim) return "";
  return `<div class="stream-timeline-item interim"><b>${html(formatClock(streamingElapsedSec()))}</b><span>인식 중</span><p>${html(state.streamingInterim)}</p></div>`;
}

function renderUploadTranslatePanel() {
  const timeline = state.streamingTimeline || [];
  const sourceText = uploadTranslationSourceText();
  return `
    <section class="streaming-panel translate-only-panel">
      <div class="panel-head">
        <h2>${icon("mic")}실시간 한국어 STT / 번역</h2>
        ${statusPill(state.uploadTranslationStatus, state.listening)}
      </div>
      <p class="muted">마이크로 말하면 한국어 전사문이 쌓이고, 번역 언어를 고른 뒤 번역하기를 누르면 됩니다. 녹음 파일 저장과 발표 구간 분석은 발표 연습 탭에서 하세요.</p>
      <div class="streaming-actions">
        <button class="btn lilac" onclick="startUploadStt()" ${state.listening ? "disabled" : ""}>${icon("mic")}실시간 STT 시작</button>
        <button class="btn outline" onclick="stopStreaming()" ${!state.listening ? "disabled" : ""}>${icon("stop")}중지</button>
        ${langSelect()}
        <button class="btn dark" onclick="translateUploadText()">${icon("translate")}번역하기</button>
        <button class="btn outline" onclick="clearUploadTranslation()">${icon("trash")}지우기</button>
      </div>
      <div class="streaming-grid">
        <article class="stream-box">
          <h3>한국어 전사문 <span class="badge">${timeline.length}개 구간</span></h3>
          <div class="stream-timeline">
            ${timelineItems(timeline, false, "실시간 STT 시작을 누르면 전사문이 표시됩니다. 아래 입력란에 직접 붙여넣기도 가능합니다.")}
            ${interimItem()}
          </div>
          <textarea class="manual-transcript" oninput="updateUploadTranslationText(this.value)" placeholder="번역할 전사문을 직접 수정하거나 붙여 넣을 수 있습니다.">${html(sourceText)}</textarea>
          <p class="meta">${sourceText.replace(/\s/g, "").length}자 · 음성 파일 저장 없음</p>
        </article>
        <article class="stream-box">
          <h3>번역 결과 ${statusPill(state.uploadTranslationStatus)}</h3>
          <div class="translation-box">${html(state.uploadTranslation) || `<span class="muted">번역하기를 누르면 결과가 표시됩니다.</span>`}</div>
        </article>
      </div>
    </section>`;
}

async function startUploadStt() {
  clearStreaming(false);
  await startStreaming({ record: false });
  renderTab();
}

function renderStreamingPanel(compact = false) {
  const timeline = state.streamingTimeline || [];
  const recordingStatus = state.listening ? "녹음 중" : state.recordedBlob ? "녹음 완료" : "녹음 대기";
  return `
    <section id="streamingPanel" class="streaming-panel ${compact ? "compact" : ""}">
      <div class="panel-head">
        <h2>${icon("mic")}실시간 한국어 STT</h2>
        ${statusPill(state.listening ? "전사/녹음 중" : "대기 중", state.listening)}
      </div>
      <div class="streaming-actions">
        <button class="btn lilac" onclick="startStreaming()" ${state.listening ? "disabled" : ""}>${icon("mic")}실시간 STT 시작</button>
        <button class="btn outline" onclick="stopStreaming()" ${!state.listening ? "disabled" : ""}>${icon("stop")}중지</button>
        <button class="btn outline" onclick="clearStreaming()">${icon("trash")}전사문 지우기</button>
        ${state.recordedBlob ? `<button class="btn outline" onclick="downloadStreamingAudio()">${icon("download")}녹음 파일 다운로드</button>` : ""}
        ${langSelect()}
        <button class="btn dark" onclick="translateStreaming()">${icon("translate")}번역하기</button>
      </div>
      <div class="streaming-grid">
        <article class="stream-box">
          <h3>한국어 전사문 <span class="badge">${timeline.length}개 구간</span></h3>
          <div class="stream-timeline">
            ${timelineItems(timeline, true, "실시간 STT 시작을 누르면 타임라인별 전사문이 표시됩니다.")}
            ${interimItem()}
          </div>
          <textarea id="streamingText" class="manual-transcript" oninput="updateStreamingText(this.value)" placeholder="필요하면 전사문을 직접 수정할 수 있습니다.">${html(state.streamingTranscript)}</textarea>
          <p class="meta">${state.streamingTranscript.replace(/\s/g, "").length}자 · ${recordingStatus}${state.recordingSavedPath ? ` · 서버 저장 완료: ${html(state.recordingSavedPath)}` : ""}</p>
          ${state.recordedAudioUrl ? `<audio class="recorded-audio" controls src="${state.recordedAudioUrl}"></audio>` : ""}
        </article>
        <article class="stream-box">
          <h3>번역 결과 ${statusPill(state.translationStatus)}</h3>
          <div class="translation-box">${html(state.translation) || `<span class="muted">번역하기를 누르면 결과가 표시됩니다.</span>`}</div>
        </article>
      </div>
    </section>`;
}

function createRecognition() {
  if (!SpeechRecognition) {
    alert("이 브라우저는 실시간 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.");
    return null;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "ko-KR";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    state.listening = true;
    if (!state.streamingStartMs) state.streamingStartMs = nowMs();
    renderCurrent();
  };
  recognition.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const text = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal && text) addStreamingTimelineItem(text);
      else interim += text;
    }
    state.streamingInterim = interim;
    renderCurrent();
  };
  recognition.onerror = (event) => {
    state.listening = false;
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
    alert("실시간 음성 인식 오류가 발생했습니다. 브라우저 권한과 마이크 상태를 확인해 주세요.");
    renderCurrent();
  };
  recognition.onend = () => {
    state.listening = false;
    state.streamingInterim = "";
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
    renderCurrent();
  };
  return recognition;
}

function rebuildStreamingTranscript() {
  state.streamingTranscript = state.streamingTimeline.map((item) => item.text).join("\n");
}

function addStreamingTimelineItem(text) {
  const end = Math.max(streamingElapsedSec(), state.streamingLastFinalSec + 0.2);
  const estimated = Math.max(1.2, Math.min(8, text.length / 7));
  const start = Math.max(state.streamingLastFinalSec, end - estimated);
  const item = {
    start,
    end,
    page: state.practice.active ? state.practice.currentPage : null,
    time: `${formatClock(start)}-${formatClock(end)}`,
    text,
  };
  state.streamingTimeline.push(item);
  state.streamingLastFinalSec = end;
  rebuildStreamingTranscript();
}

function preferredRecordingMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)) || "";
}

function streamingFileName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const ext = state.recordingMime.includes("mp4") ? "m4a" : state.recordingMime.includes("ogg") ? "ogg" : "webm";
  return `streaming-stt-${stamp}.${ext}`;
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    alert("이 브라우저는 마이크 녹음을 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.");
    return false;
  }
  state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  state.mediaChunks = [];
  state.recordedBlob = null;
  state.recordedAudioName = "";
  state.recordingSavedPath = "";
  if (state.recordedAudioUrl) URL.revokeObjectURL(state.recordedAudioUrl);
  state.recordedAudioUrl = "";
  state.recordingMime = preferredRecordingMime() || "audio/webm";
  state.mediaRecorder = new MediaRecorder(state.mediaStream, state.recordingMime ? { mimeType: state.recordingMime } : undefined);
  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) state.mediaChunks.push(event.data);
  };
  state.mediaRecorder.onstop = async () => {
    state.recordedBlob = new Blob(state.mediaChunks, { type: state.recordingMime || "audio/webm" });
    state.recordedAudioName = streamingFileName();
    state.recordedAudioUrl = URL.createObjectURL(state.recordedBlob);
    state.mediaStream?.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
    await saveStreamingAudio();
    renderCurrent();
  };
  state.mediaRecorder.start(1000);
  return true;
}

async function saveStreamingAudio() {
  if (!state.recordedBlob) return;
  try {
    const form = new FormData();
    form.append("audio", state.recordedBlob, state.recordedAudioName || streamingFileName());
    form.append("transcript", state.streamingTranscript || "");
    form.append("timeline", JSON.stringify(state.streamingTimeline || []));
    const res = await fetch("/api/save-recording", { method: "POST", body: form });
    const data = await res.json();
    if (data.ok) state.recordingSavedPath = data.path || "";
  } catch (err) {
    state.recordingSavedPath = "서버 저장 실패";
  }
}

function downloadStreamingAudio() {
  if (!state.recordedBlob || !state.recordedAudioUrl) return;
  const link = document.createElement("a");
  link.href = state.recordedAudioUrl;
  link.download = state.recordedAudioName || streamingFileName();
  link.click();
}

async function startStreaming(options = {}) {
  if (!state.recognition) state.recognition = createRecognition();
  if (!state.recognition || state.listening) return;
  state.streamingStartMs = nowMs();
  state.streamingLastFinalSec = 0;
  try {
    if (options.record !== false) {
      const recordingReady = await startRecording();
      if (!recordingReady) return;
    }
    state.recognition.start();
  } catch (err) {
    state.mediaStream?.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
    alert(userErrorMessage(err, "실시간 STT/녹음을 시작하지 못했습니다. 브라우저 권한을 확인해 주세요."));
  }
  if (options.renderAfterStart !== false) renderCurrent();
}

function stopStreaming() {
  if (state.recognition && state.listening) state.recognition.stop();
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
}

function clearStreaming(renderIt = true) {
  state.streamingTranscript = "";
  state.streamingInterim = "";
  state.streamingTimeline = [];
  state.streamingStartMs = null;
  state.streamingLastFinalSec = 0;
  state.translation = "";
  state.translationStatus = "대기";
  state.recordedBlob = null;
  state.recordedAudioName = "";
  state.recordingSavedPath = "";
  if (state.recordedAudioUrl) URL.revokeObjectURL(state.recordedAudioUrl);
  state.recordedAudioUrl = "";
  if (renderIt) renderCurrent();
}

function updateStreamingText(value) {
  state.streamingTranscript = value;
}

function updateUploadTranslationText(value) {
  state.uploadTranslationText = value;
}

function uploadTranslationSourceText() {
  return state.uploadTranslationText.trim() || state.streamingTranscript.trim();
}

function setTargetLang(value) {
  state.targetLang = value;
}

async function translateStreaming() {
  const text = state.streamingTranscript.trim();
  if (!text) {
    alert("번역할 한국어 전사문이 없습니다.");
    return;
  }
  state.translationStatus = "번역 중";
  renderCurrent();
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target: state.targetLang }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "번역 실패");
    state.translation = data.translation;
    state.translationStatus = "완료";
  } catch (err) {
    state.translation = userErrorMessage(err, "번역을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    state.translationStatus = "오류";
  }
  renderCurrent();
}

async function translateUploadText() {
  const text = uploadTranslationSourceText();
  if (!text) {
    alert("번역할 한국어 전사문이 없습니다.");
    return;
  }
  state.uploadTranslationStatus = "번역 중";
  renderTab();
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target: state.targetLang }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "번역 실패");
    state.uploadTranslation = data.translation;
    state.uploadTranslationStatus = "완료";
  } catch (err) {
    state.uploadTranslation = userErrorMessage(err, "번역을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    state.uploadTranslationStatus = "오류";
  }
  renderTab();
}

function clearUploadTranslation() {
  state.uploadTranslationText = "";
  state.uploadTranslation = "";
  state.uploadTranslationStatus = "대기";
  renderTab();
}

function practiceSlideRows() {
  return (state.practice.records || []).map((record) => {
    const words = (record.transcript || "").split(/\s+/).filter(Boolean).length;
    const wpm = record.duration > 0 ? Math.round(words / record.duration * 60) : 0;
    const fillerCount = ((record.transcript || "").match(/\b(어|아|음|그|이제|일단|뭐)\b/g) || []).length;
    return {
      slide: `Page ${record.page}`,
      duration: `약 ${Math.round(record.duration)}초`,
      recommended: "문장 단위 검토",
      wpm: `${wpm} WPM`,
      fillers: `${fillerCount}회`,
      feedback: wpm > 150 ? "빠른 구간입니다. 핵심 문장 뒤에 멈춤을 넣어보세요." : wpm < 90 ? "느린 구간입니다. 불필요한 공백을 줄여보세요." : "속도와 흐름이 비교적 안정적입니다.",
    };
  });
}

function numericWpm(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 0;
}

function practiceAverageWpm(rows = practiceSlideRows()) {
  const values = rows.map((row) => numericWpm(row.wpm)).filter((value) => value > 0);
  if (!values.length) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function practicePaceSeries(rows = practiceSlideRows()) {
  let cursor = 0;
  return rows.map((row) => {
    const seconds = Math.max(1, numericWpm(row.duration));
    const start = cursor;
    cursor += seconds;
    const wpm = numericWpm(row.wpm);
    return {
      time: `${formatClock(start)}-${formatClock(cursor)}`,
      wpm,
      seconds,
      words: Math.round(wpm * seconds / 60),
    };
  });
}

function applyPracticeMetrics(analysis) {
  const rows = practiceSlideRows();
  if (!rows.length) return analysis;
  analysis.practice_segments = state.practice.records || [];
  analysis.slide_rows = rows;
  analysis.wpm = practiceAverageWpm(rows);
  analysis.pace_series = practicePaceSeries(rows);
  analysis.practice_summary = `${state.practice.records.length}개 페이지 구간 기준으로 실시간 음성과 발표자료 페이지를 매칭했습니다.`;
  return analysis;
}

/* ---------- analysis loading screen (full-screen while /api/analyze runs) ---------- */
const ANALYZE_STEPS = [
  ["음성 전사", "CLOVA Speech가 문장 단위 전사문과 시각을 만듭니다"],
  ["자료 비교", "발표자료 키워드와 전사문을 페이지별로 맞춰 봅니다"],
  ["AI 심사위원 평가", "심사위원 AI 셋이 점수와 문제점, 예상 질문을 작성합니다"],
];
let analyzeTimer = null;

function showAnalyzeOverlay(meta) {
  hideAnalyzeOverlay();
  const el = document.createElement("div");
  el.id = "analyzeOverlay";
  el.className = "analyze-overlay";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="analyze-card">
      <div class="analyze-ring"></div>
      <h2>분석 중입니다</h2>
      <p class="analyze-meta">${html(meta)}</p>
      <ol class="analyze-steps">${ANALYZE_STEPS.map(([t, d], i) => `<li class="${i === 0 ? "active" : ""}"><b>${t}</b><small>${d}</small></li>`).join("")}</ol>
      <p class="analyze-foot"><b id="analyzeClock">00:00</b> 경과 · 9분 발표 기준 약 1분, 발표 길이에 따라 달라집니다</p>
    </div>`;
  document.body.appendChild(el);
  const t0 = Date.now();
  const stepAt = window.ANALYZE_STEP_SECONDS || [10, 16]; // when the 2nd and 3rd steps light up (typical timing)
  analyzeTimer = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    const clock = $("analyzeClock");
    if (clock) clock.textContent = formatClock(s);
    const idx = s >= stepAt[1] ? 2 : s >= stepAt[0] ? 1 : 0;
    el.querySelectorAll(".analyze-steps li").forEach((li, i) => { li.className = i < idx ? "done" : i === idx ? "active" : ""; });
  }, 250);
}

function hideAnalyzeOverlay() {
  if (analyzeTimer) { clearInterval(analyzeTimer); analyzeTimer = null; }
  const el = $("analyzeOverlay");
  if (el) el.remove();
}

async function analyzePresentation() {
  const transcript = state.streamingTranscript.trim();
  if (!state.selectedFile && !transcript) {
    alert("발표 음성 파일을 선택하거나 발표 연습/실시간 STT 전사문을 생성하세요.");
    return;
  }
  state.busy = true;
  renderTab();
  showAnalyzeOverlay(`${state.selectedFile ? state.selectedFile.name : "실시간 전사문"}${state.selectedMaterial ? " + " + state.selectedMaterial.name : ""}`);
  try {
    const form = new FormData();
    if (state.selectedFile) form.append("audio", state.selectedFile);
    if (state.selectedMaterial) form.append("material", state.selectedMaterial);
    if (transcript) form.append("streaming_transcript", transcript);
    if (state.streamingTimeline.length) form.append("streaming_timeline", JSON.stringify(state.streamingTimeline));
    const res = await fetch("/api/analyze", { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "분석 실패");
    const analysis = data.analysis || {};
    if (state.practice.records.length) {
      applyPracticeMetrics(analysis);
    }
    state.analysis = analysis;
    state.tab = "analysis";
  } catch (err) {
    alert(userErrorMessage(err, "분석을 완료하지 못했습니다. 입력 파일과 전사문을 확인해 주세요."));
  } finally {
    state.busy = false;
    hideAnalyzeOverlay();
    render();
  }
}

async function analyzePractice() {
  const transcript = practiceTranscript();
  if (!transcript) {
    alert("발표 연습 전사문이 없습니다. 발표 시작 후 실시간 STT를 먼저 진행하세요.");
    return;
  }
  state.busy = true;
  updatePracticeControls();
  showAnalyzeOverlay(`발표 연습 전사문${state.practiceMaterial ? " + " + state.practiceMaterial.name : ""}`);
  try {
    const form = new FormData();
    if (state.practiceMaterial) form.append("material", state.practiceMaterial);
    form.append("streaming_transcript", transcript);
    form.append("streaming_timeline", JSON.stringify(state.streamingTimeline));
    const res = await fetch("/api/analyze", { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "분석 실패");
    const analysis = data.analysis || {};
    if (state.practice.records.length) {
      applyPracticeMetrics(analysis);
    }
    state.analysis = analysis;
    state.tab = "analysis";
  } catch (err) {
    alert(userErrorMessage(err, "분석을 완료하지 못했습니다. 입력 파일과 전사문을 확인해 주세요."));
  } finally {
    state.busy = false;
    hideAnalyzeOverlay();
    render();
  }
}

function questions() {
  const q = cleanQuestions(state.analysis?.questions || []);
  if (q.length) return q;
  const waiting = state.analysis?.llm_error
    ? `AI 평가 실패로 예상 질문을 생성하지 못했습니다. (${state.analysis.llm_error})`
    : "발표 음성 또는 전사문을 분석하면 예상 질문이 생성됩니다.";
  return [{ category: "대기", question: waiting, level: "-" }];
}

function goQuestion(index) {
  const list = questions();
  state.qaIndex = Math.max(0, Math.min(list.length - 1, index));
  renderQuestions();
}

function moveQuestion(delta) {
  goQuestion(state.qaIndex + delta);
}

async function evaluateAnswer() {
  if (!ready()) {
    alert("먼저 발표를 분석해 주세요.");
    return;
  }
  const answer = $("answerText").value.trim();
  if (!answer) {
    alert("답변을 입력해 주세요.");
    return;
  }
  const idx = state.qaIndex;
  state.qaAnswers[idx] = answer;
  try {
    const res = await fetch("/api/evaluate-answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: questions()[idx], answer, transcript: state.analysis.transcript || "" }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "답변 평가 실패");
    state.qaResults[idx] = data.result || {};
    renderQuestions();
  } catch (err) {
    alert(userErrorMessage(err, "답변 평가를 완료하지 못했습니다."));
  }
}

function renderAnswerResult(r) {
  const li = (items) => (items || []).map((x) => `<li>${html(x)}</li>`).join("") || "<li>분석 결과 없음</li>";
  return `<article class="answer-card">
    <h3><b>${icon("sparkle")}AI 답변 평가</b><span>${scoreOf(r.score)}점</span></h3>
    <div class="two">
      <div><b>${icon("check")}강점</b><ul>${li(r.strengths)}</ul></div>
      <div><b>${icon("trending")}개선점</b><ul>${li(r.improvements)}</ul></div>
    </div>
    <div class="model-answer"><b>모범 답변 예시</b>${html(r.model_answer || "")}</div>
  </article>`;
}

function renderQuestions() {
  const list = questions();
  const idx = Math.min(state.qaIndex, list.length - 1);
  const item = list[idx];
  const result = state.qaResults[idx];
  const done = Object.keys(state.qaResults).length;
  $("tabBody").innerHTML = `
    <section class="qa-layout">
      <div>
        <div class="question-stage">
          ${deco("deco-blob")}${deco("deco-star", "a")}${deco("deco-star", "b")}${deco("deco-dot", "a")}${deco("deco-dot", "b")}
          <span class="q-index">예상 질문 ${idx + 1}</span>
          <div class="qicon">Q</div>
          <span class="q-cat">${html(item.category)}</span>
          <h1>${html(item.question)}</h1>
          <small>권장 답변 시간 90초 · 난이도 ${html(item.level)}</small>
        </div>
        <div class="question-nav">
          <button class="btn outline" onclick="moveQuestion(-1)" ${idx <= 0 ? "disabled" : ""}>${icon("arrowLeft")}이전 질문</button>
          <div class="dot-nav">${list.map((_, i) => `<button class="dot-btn ${i === idx ? "active" : ""}" onclick="goQuestion(${i})">${i + 1}</button>`).join("")}</div>
          <button class="btn outline" onclick="moveQuestion(1)" ${idx >= list.length - 1 ? "disabled" : ""}>다음 질문${icon("arrowRight")}</button>
        </div>
        <div class="answer-section">
          <h2>${icon("message")}내 답변 및 AI 분석</h2>
          <textarea id="answerText" placeholder="질문에 대한 답변을 입력하세요.">${html(state.qaAnswers[idx] || "")}</textarea>
          <button class="btn lilac" onclick="evaluateAnswer()">${icon("sparkle")}답변 평가하기</button>
          ${result ? renderAnswerResult(result) : ""}
        </div>
      </div>
      <aside class="side-panel">
        <h3>${icon("target")}예상질문 연습</h3>
        <p class="sub">질문별 답변을 평가하면 점수가 누적됩니다.</p>
        <div class="tiles c2">
          <div class="tile"><b>${done}/${list.length}</b><small>완료한 질문</small></div>
          <div class="tile"><b>${result ? scoreOf(result.score) : "–"}</b><small>현재 점수</small></div>
        </div>
        ${["논리성", "구체성", "자신감", "시간 관리"].map((k) => bar(k, result ? scoreOf(result[k] || result.score || 0) : 0, result ? "" : "lilac")).join("")}
      </aside>
    </section>`;
}

function metricCard(iconName, value, unit, label, failed = false) {
  const body = failed
    ? `<strong>–</strong><small>AI 평가 실패</small>`
    : `<strong>${html(value)}<small>${html(unit)}</small></strong><small>${html(label)}</small>`;
  return `<article class="metric ${failed ? "failed" : ""}"><span class="circle-icon">${icon(iconName)}</span><div>${body}</div></article>`;
}

function renderAnalysis() {
  const a = state.analysis;
  if (!a) {
    $("tabBody").innerHTML = emptyState("아직 분석 결과가 없습니다", "발표 음성을 업로드하거나 발표 연습 탭에서 실시간 전사를 분석하면 결과가 표시됩니다.", "chart");
    return;
  }
  const llmFailed = Boolean(a.llm_error);
  const matchCard = a.document_match?.available ? card("자료–음성 일치율", renderDocumentMatch(a.document_match), "full", "layers") : "";
  const llmErrorBox = llmFailed ? alertBox("AI 종합평가 실패", `${html(a.llm_error)} 아래 내용은 CLOVA 전사문과 Python 측정 지표만으로 표시된 결과입니다.`) : "";
  const chartBody = `<canvas id="paceChart"></canvas><div class="chart-legend"><span><i style="background:var(--lilac)"></i>구간별 WPM</span><span><i style="background:rgba(248,213,126,.7)"></i>권장 범위 120–150 WPM</span></div>`;
  $("tabBody").innerHTML = `
    ${llmErrorBox}
    <section class="metric-cards">
      ${metricCard("award", a.score, "/100", "종합 점수", llmFailed)}
      ${metricCard("activity", a.wpm, " WPM", "평균 발화속도")}
      ${metricCard("volume", a.filler_total, "회", "추임새 단어")}
      ${metricCard("text", metricCount(a.vocab_issues, a.vocab_suggestions), "건", "어휘 개선 항목", llmFailed)}
    </section>
    ${matchCard}
    ${a.practice_summary ? card("발표 연습 구간 매칭", `<p>${html(a.practice_summary)}</p>${renderPracticeAnalysisTable(a.practice_segments || [])}`, "full", "slides") : ""}
    <section class="analysis-grid">
      ${card("발화 속도 분석", chartBody, "chart-card", "trending")}
      ${card("음성 품질 분석", llmFailed ? `<p class="muted">AI 평가 실패로 음성 품질 점수를 제공할 수 없습니다.</p>` : Object.entries(displayVoiceScores(a)).map(([k, v]) => bar(k, v)).join(""), "", "target")}
      ${card("추임새 단어 분석", renderFillers(a.filler_words || []), "", "volume")}
      ${card("어휘 개선 제안", llmFailed ? `<p class="muted">AI 평가 실패로 어휘 개선 제안을 제공할 수 없습니다.</p>` : renderVocab(a.vocab_suggestions || []), "", "bulb")}
    </section>
    <section class="analysis-grid">
      ${card("화자별 분석", renderSpeakers(a.speaker_stats || []), "", "users")}
      ${card("문장별 타임라인", renderTimeline(a.sentence_segments || []), "", "clock")}
    </section>
    ${card("슬라이드별 분석", renderSlideRows(a.slide_rows || []), "full", "slides")}`;
  drawPaceChart(a.pace_series || [], a.wpm || 140);
}

function renderPracticeAnalysisTable(rows) {
  if (!rows.length) return "";
  return `<div class="table-wrap"><table><thead><tr><th>페이지</th><th class="num">시작</th><th class="num">종료</th><th>체류시간</th><th>전사 구간</th></tr></thead><tbody>${rows.map((r) => `<tr><td><span class="badge">Page ${html(r.page)}</span></td><td class="num">${html(formatClock(r.start))}</td><td class="num">${html(formatClock(r.end))}</td><td>${html(formatDuration(r.duration))}</td><td>${html(r.transcript || "-")}</td></tr>`).join("")}</tbody></table></div>`;
}

function keywordList(list) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!items.length) return `<span class="kw none">없음</span>`;
  return `<div class="kw-list">${items.map((t) => `<span class="kw">${html(t)}</span>`).join("")}</div>`;
}

function renderDocumentMatch(match) {
  return `
    <div class="match-hero">
      <div class="ring"><svg viewBox="0 0 104 104" aria-hidden="true"><circle class="track" cx="52" cy="52" r="46"/><circle class="fill" cx="52" cy="52" r="46" stroke-dasharray="${(289 * scoreOf(match.score) / 100).toFixed(1)} 289"/></svg><b>${html(match.score)}<small>%</small></b></div>
      <div>
        <div class="match-flow">${icon("file")}발표자료 ${icon("arrowRight")} 발표 음성 ${icon("mic")}</div>
        <p>${html(match.summary || "")}</p>
      </div>
    </div>
    <div class="tiles c3">
      <div class="tile"><b>${html(match.document_coverage)}%</b><small>자료 반영률</small></div>
      <div class="tile"><b>${html(match.speech_extra_ratio)}%</b><small>자료 외 발화 추정</small></div>
      <div class="tile"><b>${html(match.sections?.length || 0)}</b><small>페이지/슬라이드</small></div>
    </div>
    <div class="keyword-duo">
      <div><b>자료에는 있지만 발표에서 약한 키워드</b>${keywordList(match.missing_terms)}</div>
      <div><b>발표에는 있지만 자료에 약한 키워드</b>${keywordList(match.extra_terms)}</div>
    </div>
    ${renderDocumentSections(match.sections || [])}`;
}

function renderDocumentSections(rows) {
  if (!rows.length) return "";
  return `<div class="table-wrap"><table><thead><tr><th>자료 구간</th><th class="num">일치율</th><th>상태</th><th>누락 키워드</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${html(r.title || r.page)}</td><td class="num">${html(r.score)}%</td><td>${badge(r.status) || "-"}</td><td>${(r.missing || []).map(html).join(", ") || "<span class='muted'>없음</span>"}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderFillers(items) {
  if (!items.length) return "<p class='muted'>감지된 추임새 단어가 없습니다.</p>";
  const max = Math.max(1, ...items.map((x) => Number(x.count || 0)));
  return items.map((x) => `<div class="filler-row"><span class="word">“${html(x.word)}”</span>${badge(x.severity) || ""}<span class="bar"><i style="width:${Math.round(Number(x.count || 0) / max * 100)}%"></i></span><span class="count">${html(x.count)}회</span></div>`).join("");
}

function renderVocab(items) {
  const rows = cleanVocabItems(items);
  if (!rows.length) return "<p class='muted'>감지된 어휘 개선 항목이 없습니다.</p>";
  return rows.map((x) => {
    const body = x.replacement
      ? `<p class="vocab-pair"><b>${html(x.original || "-")}</b><span class="arrow">${icon("arrowRight")}</span><em>${html(x.replacement)}</em></p>`
      : `<p class="vocab-single"><b>${html(x.original || x.reason || "-")}</b></p>`;
    return `<div class="vocab"><small>개선 표현</small>${body}${x.reason && x.reason !== x.original ? `<span>${html(x.reason)}</span>` : ""}</div>`;
  }).join("");
}

function renderSpeakers(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "<p class='muted'>화자 분리 정보가 없습니다.</p>";
  return `<div class="table-wrap"><table><thead><tr><th>화자</th><th class="num">문장</th><th class="num">발화시간</th><th class="num">WPM</th><th class="num">추임새</th></tr></thead><tbody>${rows.map((s) => `<tr><td><span class="speaker-name"><span class="circle-icon soft">${icon("user")}</span>${html(cleanSpeaker(s.speaker))}</span></td><td class="num">${html(s.sentences)}</td><td class="num">${html(s.seconds)}초</td><td class="num">${html(s.wpm)}</td><td class="num">${html(s.fillers)}회</td></tr>`).join("")}</tbody></table></div>`;
}

function formatGap(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  return number < 1 ? number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") : number.toFixed(1).replace(/\.0$/, "");
}

function renderTimeline(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "<p class='muted'>문장별 timestamp가 없습니다.</p>";
  return `<p class="muted" style="margin:0 0 10px;font-size:13px">전체 ${rows.length}개 문장</p><div class="timeline-list">${rows.map((x) => `<div class="timeline-item"><span class="t-time">${html(x.time)}</span><div><span class="t-meta">${html(cleanSpeaker(x.speaker))} · 구간 ${html(x.section)} · 공백 ${html(formatGap(x.gap_before))}초</span><p>${html(x.text)}</p></div></div>`).join("")}</div>`;
}

function renderSlideRows(rows) {
  if (!rows.length) return "<p class='muted'>구간별 분석이 없습니다.</p>";
  return `<div class="table-wrap"><table><thead><tr><th>슬라이드</th><th>체류시간</th><th>권장시간</th><th>발화속도</th><th>추임새</th><th>피드백</th></tr></thead><tbody>${rows.map((r) => `<tr><td><span class="badge">${html(r.slide)}</span></td><td class="num">${html(r.duration)}</td><td class="num">${html(r.recommended)}</td><td class="num">${html(r.wpm)}</td><td class="num">${html(r.fillers)}</td><td>${html(r.feedback)}</td></tr>`).join("")}</tbody></table></div>`;
}

function drawPaceChart(series, fallbackWpm) {
  const canvas = $("paceChart");
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const cssW = Math.max(300, canvas.clientWidth || canvas.parentElement?.clientWidth || 720);
  const cssH = 320;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = cssW;
  const h = cssH;
  const pad = { l: 52, r: 20, t: 26, b: 42 };
  const data = (series.length ? series : [{ time: "0:00", wpm: fallbackWpm }]).map((d, i) => ({ time: String(d.time || `${i}:00`), wpm: Number(d.wpm || fallbackWpm || 0) }));
  const values = data.map((d) => d.wpm).filter(Number.isFinite);
  const min = Math.max(0, Math.floor((Math.min(...values, 120) - 20) / 10) * 10);
  const max = Math.max(min + 60, Math.ceil((Math.max(...values, 150) + 20) / 10) * 10);
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const xFor = (i) => pad.l + (i / Math.max(1, data.length - 1)) * plotW;
  const yFor = (v) => pad.t + (1 - (v - min) / Math.max(1, max - min)) * plotH;
  const fontBody = "12px Poppins, 'Pretendard Variable', Pretendard, sans-serif";

  ctx.clearRect(0, 0, w, h);
  // recommended band
  ctx.fillStyle = "rgba(248, 213, 126, .32)";
  ctx.fillRect(pad.l, yFor(150), plotW, Math.max(1, yFor(120) - yFor(150)));
  // grid + y labels
  const step = Math.max(10, Math.round((max - min) / 4 / 10) * 10);
  ctx.font = fontBody;
  for (let t = min; t <= max; t += step) {
    const y = yFor(t);
    ctx.strokeStyle = "#eae4f3";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = "#6f6880";
    ctx.textAlign = "right";
    ctx.fillText(String(t), pad.l - 10, y + 4);
  }
  ctx.fillStyle = "#2b2038";
  ctx.font = `600 ${fontBody}`;
  ctx.textAlign = "left";
  ctx.fillText("WPM", pad.l, 14);
  // area under line
  if (data.length > 1) {
    ctx.beginPath();
    data.forEach((d, i) => (i ? ctx.lineTo(xFor(i), yFor(d.wpm)) : ctx.moveTo(xFor(i), yFor(d.wpm))));
    ctx.lineTo(xFor(data.length - 1), yFor(min));
    ctx.lineTo(xFor(0), yFor(min));
    ctx.closePath();
    ctx.fillStyle = "rgba(172, 108, 255, .12)";
    ctx.fill();
  }
  // line
  ctx.strokeStyle = "#ac6cff";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  data.forEach((d, i) => (i ? ctx.lineTo(xFor(i), yFor(d.wpm)) : ctx.moveTo(xFor(i), yFor(d.wpm))));
  ctx.stroke();
  // points + x labels
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  ctx.font = fontBody;
  data.forEach((d, i) => {
    const x = xFor(i);
    const y = yFor(d.wpm);
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#2b2038";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (i % labelEvery === 0 || i === data.length - 1) {
      ctx.fillStyle = "#6f6880";
      ctx.textAlign = "center";
      ctx.fillText(d.time, x, h - 14);
    }
  });
}

window.addEventListener("resize", () => {
  if (state.view === "demo" && state.tab === "analysis" && state.analysis && $("paceChart")) {
    drawPaceChart(state.analysis.pace_series || [], state.analysis.wpm || 140);
  }
});

function renderSummary() {
  const a = state.analysis;
  if (!a) {
    $("tabBody").innerHTML = emptyState("종합 결과가 아직 없습니다", "분석을 완료하면 문제점, 보완 사항, AI 종합 의견이 여기에 정리됩니다.", "award");
    return;
  }
  const problems = cleanProblems(a.problems || []);
  const priorities = cleanPriorities(a.improvement_priorities || []);
  const summaryQuestions = cleanQuestions(a.questions || []);
  const llmFailed = Boolean(a.llm_error);
  const llmUnavailable = "<p class='muted'>AI 평가 실패로 제공되지 않습니다.</p>";
  const llmErrorBox = llmFailed ? alertBox("AI 종합평가 실패", `${html(a.llm_error)} 전사문과 Python 측정 지표는 분석 결과 탭에서 확인할 수 있습니다.`) : "";
  const documentBlock = a.document_match?.available
    ? card("자료 간 매칭 분석", renderDocumentMatch(a.document_match), "full", "layers")
    : card("자료 간 매칭 분석", "<p class='muted'>PPT/PDF 발표자료를 함께 업로드하면 음성 전사와 자료 일치율을 비교합니다.</p>", "full", "layers");
  const problemsHtml = problems.map((p) => `<div class="problem ${toneOf(p.level)}">${badge(p.level)}<b>${html(p.title)}</b><small>${html(p.fix)}</small></div>`).join("") || "<p class='muted'>문제점 없음</p>";
  const prioritiesHtml = priorities.map((p, i) => `<div class="priority"><span class="num-circle">${i + 1}</span><div><b>${html(p.title || p.detail)}${p.impact ? badge(p.impact, "honey") : ""}</b>${p.title && p.detail ? `<small>${html(p.detail)}</small>` : ""}</div></div>`).join("") || "<p class='muted'>보완 사항 없음</p>";
  const questionsHtml = summaryQuestions.map((q, i) => `<div class="q-row"><span class="num-circle">${i + 1}</span>${badge(q.category, "neutral")}<p>${html(q.question)}</p>${q.level && q.level !== "-" ? badge(`난이도 ${q.level}`, "honey") : ""}</div>`).join("") || "<p class='muted'>예상 질문 없음</p>";
  $("tabBody").innerHTML = `
    ${llmErrorBox}
    ${documentBlock}
    <section class="analysis-grid">
      ${card("발견된 문제점", llmFailed ? llmUnavailable : problemsHtml, "", "alert")}
      ${card("보완 사항", llmFailed ? llmUnavailable : prioritiesHtml, "", "trending")}
    </section>
    ${card("AI 예상 심사위원 질문", llmFailed ? llmUnavailable : questionsHtml, "full", "message")}
    <article class="card dark final-card">
      ${deco("deco-blob")}${deco("deco-star", "a")}
      <h3>${icon("sparkle")}AI 종합 의견</h3>
      <p class="summary-text">${html(a.summary || "")}</p>
      <div class="final-score">
        <div><b class="grade">${html(a.grade || "–")}</b><small>등급</small></div>
        <div><b>${llmFailed ? "–" : `${html(a.score)}<span class="unit">/100</span>`}</b><small>종합 점수</small></div>
        <div><b>${html(a.status || "–")}</b><small>판정</small></div>
      </div>
    </article>`;
}

async function downloadReport() {
  if (!ready()) {
    alert("먼저 발표를 분석해 주세요.");
    return;
  }
  const res = await fetch("/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ analysis: state.analysis }),
  });
  if (!res.ok) {
    alert("리포트 생성에 실패했습니다.");
    return;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "presentation-review-report.pdf";
  link.click();
  URL.revokeObjectURL(url);
}

function renderCurrent() {
  if (state.view === "demo" && state.tab === "practice" && state.practice.active) {
    updatePracticeClocks();
    updatePracticeRecordsLive();
    updatePracticeControls();
    return;
  }
  if (state.view === "demo") renderTab();
  else render();
}

function render() {
  $("homeView").classList.toggle("active", state.view === "home");
  $("demoView").classList.toggle("active", state.view === "demo");
  renderTopbar();
  renderFooter();
  if (state.view === "home") renderHome();
  if (state.view === "demo") {
    teardownHome();
    renderDemo();
  }
  window.scrollTo({ top: 0 });
}

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

render();
