/* ==========================================================================
   STT Presentation Review — app.js (2026-10-23 redesign)
   Vanilla JS SPA. Views: home | login | app (dashboard·practice·analysis·
   summary·questions·translate) | admin (users·usage·tokens).
   Every /api/* call except login goes through apiFetch(): the server keeps a
   session cookie (stt_session) and answers 401 {auth_required:true} when the
   visitor is not logged in; the app then shows the login screen and returns
   to the requested screen afterwards.
   ========================================================================== */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const state = {
  view: "home",
  tab: "dashboard",
  adminTab: "users",
  user: null,
  authChecked: false,
  pending: null,
  homeSheet: "score",
  ctaMode: "upload",
  registerOpen: true,
  title: "",
  targetMinutes: 7,
  histQuery: "",
  history: [],
  historyLoaded: false,
  resultsTab: "summary",
  summaryTab: "problems",
  showAllTranscript: false,
  showAllTimeline: false,
  showAllSlides: false,
  analysis: null,
  analysisMeta: null,
  qaOpen: 0,
  qaAnswers: {},
  qaResults: {},
  qaMode: "voice",
  qaRec: null,
  qaListening: false,
  qaStartMs: 0,
  qaTimer: 0,
  qaFilter: "all",
  qaSrc: "upload",
  qaCount: 10,
  qaInfo: {},
  qaRedo: {},
  qaModel: {},
  qaOpenMs: 0,
  qaElapsed: 0,
  qaSaveTimer: 0,
  qaModeChosen: false,
  selectedFile: null,
  selectedMaterial: null,
  materialPreview: null,
  materialObjectUrl: "",
  practiceMaterial: null,
  practicePreview: null,
  practiceObjectUrl: "",
  practicePdfDoc: null,
  practicePdfRenderKey: "",
  practicePdfZoom: 1,
  practiceThumbs: {},
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
    phase: "setup",
    active: false,
    startedAtMs: null,
    pageStartedAtMs: null,
    currentPage: 1,
    records: [],
    tick: 0,
    shortcuts: true,
    totalSec: 0,
    finishedAt: null,
  },
  admin: {
    users: [],
    usage: [],
    usageSummary: null,
    usageFilter: { user: "", feature: "" },
    confirm: null,
    pwFor: null,
    error: "",
    notice: "",
    tokens: null,
    tokensPeriod: "30d",
    tokensStatus: "",
    callLog: null,
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

/* ---------- formatting ---------- */
function formatClock(seconds = 0) {
  const total = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(total / 60);
  const secs = Math.floor(total % 60);
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
function formatShortClock(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
function formatDuration(seconds = 0) {
  const n = Math.max(0, Math.round(Number(seconds || 0)));
  return n >= 60 ? `${Math.floor(n / 60)}분 ${n % 60}초` : `${n}초`;
}
function formatDate(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return String(value || "");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function formatDateShort(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return String(value || "");
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}
function formatDateTime(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return String(value || "");
  return `${formatDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function streamingElapsedSec() {
  if (!state.streamingStartMs) return 0;
  return (nowMs() - state.streamingStartMs) / 1000;
}
function practiceElapsedSec() {
  if (!state.practice.startedAtMs) return state.practice.totalSec || 0;
  return (nowMs() - state.practice.startedAtMs) / 1000;
}
function currentPageElapsedSec() {
  if (!state.practice.pageStartedAtMs) return 0;
  return (nowMs() - state.practice.pageStartedAtMs) / 1000;
}
function wordCount(text) {
  return String(text || "").split(/\s+/).filter(Boolean).length;
}

/* ---------- data cleaning (analysis JSON is LLM-shaped, so be lenient) ---------- */
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
  if (!text || text.includes("미상") || /[�]/.test(text)) return "화자 1";
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
function gradeOf(analysis) {
  const g = asText(analysis?.grade, "").trim();
  if (g && g !== "-" && g !== "–") return g;
  const s = scoreOf(analysis?.score);
  if (s >= 90) return "A";
  if (s >= 85) return "A-";
  if (s >= 80) return "B+";
  if (s >= 75) return "B";
  if (s >= 70) return "B-";
  if (s >= 65) return "C+";
  if (s >= 60) return "C";
  if (s >= 55) return "C-";
  return "D";
}
function scoreWord(score) {
  const s = scoreOf(score);
  if (s >= 85) return "우수";
  if (s >= 75) return "양호";
  if (s >= 60) return "보통";
  return "미흡";
}
function scoreTone(value) {
  const n = scoreOf(value);
  if (n >= 75) return "good";
  if (n >= 55) return "warn";
  return "bad";
}
function toneOf(text) {
  const t = String(text || "").toLowerCase();
  if (/높음|심각|누락|부족|위험|미흡|high|critical/.test(t)) return "bad";
  if (/보통|보완|주의|개선|medium|moderate/.test(t)) return "warn";
  if (/낮음|양호|우수|좋음|통과|완료|적정|low|good|pass/.test(t)) return "good";
  return "";
}

/* ---------- icons ---------- */
const ICONS = {
  sparkle: '<path style="fill:currentColor;stroke:none" d="M12 2.5c.7 4.9 4 8.2 9 9-5 .7-8.3 4-9 9-.7-5-4-8.3-9-9 5-.8 8.3-4.1 9-9z"/>',
  mic: '<path d="M12 15.5a4 4 0 0 0 4-4V6a4 4 0 0 0-8 0v5.5a4 4 0 0 0 4 4z"/><path d="M19 11.5a7 7 0 0 1-14 0"/><path d="M12 18.5V21"/><path d="M8.5 21h7"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h4"/>',
  slides: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v3"/><path d="M8 21h8"/><path d="M7 9h6"/><path d="M7 12h10"/>',
  play: '<path style="fill:currentColor;stroke:none" d="M7 4.8v14.4a1 1 0 0 0 1.5.9l11.2-7.2a1 1 0 0 0 0-1.7L8.5 3.9A1 1 0 0 0 7 4.8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
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
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  chevronLeft: '<path d="m15 6-6 6 6 6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
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
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  home: '<path d="m3 11 9-7 9 7"/><path d="M5 10v10h14V10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  briefcase: '<path d="M3 8h18v12H3z"/><path d="M9 8V5h6v3"/><path d="M3 13h18"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  code: '<path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="m14 4-4 16"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 13h10l1-13"/><path d="M9 7V4h6v3"/>',
  fit: '<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  quote: '<path d="M7 7h4v4H8v3H5V9a2 2 0 0 1 2-2z"/><path d="M15 7h4v4h-3v3h-3V9a2 2 0 0 1 2-2z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
  listCheck: '<path d="M10 6h11M10 12h11M10 18h11"/><path d="m3 6 1.5 1.5L7 5"/><path d="m3 12 1.5 1.5L7 11"/><path d="m3 18 1.5 1.5L7 17"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  text: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h14"/>',
  logout: '<path d="M10 17l5-5-5-5"/><path d="M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>',
  lock: '<rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9"/><path d="m16 7 2 2"/><path d="m18 5 2 2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  hourglass: '<path d="M7 3h10"/><path d="M7 21h10"/><path d="M8 3v4a4 4 0 0 0 8 0V3"/><path d="M8 21v-4a4 4 0 0 1 8 0v4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4M16 3v4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3"/><path d="M8 21v-6h8v6"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 2"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  party: '<path d="m4 20 4-12 8 8z"/><path d="M14 4l.5 2M19 6l-1.5 1.5M20 11l-2 .5"/><path d="M9 11l4 4"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  speaker: '<path d="M4 10v4h4l5 4V6l-5 4z"/>',
  circleCheck: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
};
function icon(name, cls = "") {
  return `<span class="icon ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[name] || ICONS.sparkle}</svg></span>`;
}

/* ---------- small building blocks ---------- */
function bar(label, value, tone = "", extra = "") {
  const n = scoreOf(value);
  return `<div class="bar ${extra}"><p><span>${html(label)}</span><b class="tone-${tone || scoreTone(n)}">${n}</b></p><span><i class="${tone || scoreTone(n)}" style="width:${n}%"></i></span></div>`;
}
function badge(text, tone = "") {
  const value = asText(text, "").trim();
  if (!value) return "";
  return `<span class="badge ${tone || toneOf(value)}">${html(value)}</span>`;
}
function ring(value, cls = "", label = "") {
  const n = scoreOf(value);
  const c = 2 * Math.PI * 46;
  return `<div class="ring ${cls}"><svg viewBox="0 0 104 104" aria-hidden="true"><circle class="track" cx="52" cy="52" r="46"/><circle class="fill" cx="52" cy="52" r="46" stroke-dasharray="${(c * n / 100).toFixed(1)} ${c.toFixed(1)}"/></svg><b>${label}</b></div>`;
}
function emptyState(title, text, iconName = "sparkle", action = "") {
  return `<section class="empty"><span class="icon-box lg neutral">${icon(iconName)}</span><b>${html(title)}</b><p>${html(text)}</p>${action}</section>`;
}
function notice(body, tone = "", iconName = "bulb") {
  return `<div class="notice ${tone}">${icon(iconName)}<div>${body}</div></div>`;
}
function fileChip(file, placeholder) {
  return file
    ? `<span class="file-chip" title="${html(file.name)}">${icon("file", "sm")}${html(file.name)}</span>`
    : `<small>${html(placeholder)}</small>`;
}
function cardHead(title, iconName = "", meta = "") {
  return `<div class="card-head"><span class="card-title">${iconName ? icon(iconName) : ""}${title}</span>${meta ? `<span class="card-meta">${meta}</span>` : ""}</div>`;
}
let toastTimer = 0;
function toast(message, tone = "") {
  const old = $("toast");
  if (old) old.remove();
  const el = document.createElement("div");
  el.id = "toast";
  el.className = `toast ${tone}`;
  el.textContent = message;
  document.body.appendChild(el);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2800);
}

/* ---------- auth client ---------- */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...options });
  if (res.status === 401) {
    let data = {};
    try { data = await res.clone().json(); } catch (_) { /* not json */ }
    if (data.auth_required) {
      state.user = null;
      state.pending = state.view === "app" || state.view === "admin" ? { view: state.view, tab: state.tab } : null;
      toast("로그인이 필요합니다.", "bad");
      state.view = "login";
      render();
      throw new Error(data.error || "로그인이 필요합니다.");
    }
  }
  return res;
}
async function loadMe() {
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    const data = await res.json().catch(() => ({}));
    state.user = res.ok && data.ok ? data.user : null;
  } catch (_) {
    state.user = null;
  }
  state.authChecked = true;
}
async function submitLogin(event) {
  event.preventDefault();
  const id = $("loginId").value.trim();
  const password = $("loginPw").value;
  const error = $("loginError");
  const submit = $("loginSubmit");
  if (!id || !password) {
    error.textContent = "아이디와 비밀번호를 입력해 주세요.";
    return;
  }
  submit.disabled = true;
  error.textContent = "";
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      error.textContent = data.error || "로그인에 실패했습니다.";
      $("loginPw").select();
      return;
    }
    state.user = data.user;
    state.history = [];
    state.historyLoaded = false;
    const next = state.pending || { view: "app", tab: "dashboard" };
    state.pending = null;
    toast(`${data.user.name || data.user.id}님, 환영합니다.`);
    go(next.view, next.tab);
  } catch (err) {
    error.textContent = userErrorMessage(err, "서버에 연결하지 못했습니다.");
  } finally {
    submit.disabled = false;
  }
}
async function logout() {
  closeUserMenu();
  try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch (_) { /* ignore */ }
  state.user = null;
  state.pending = null;
  state.history = [];
  state.historyLoaded = false;
  state.analysis = null;
  state.analysisMeta = null;
  toast("로그아웃했습니다.");
  go("home");
}
function openPasswordChange() {
  closeUserMenu();
  const wrap = document.createElement("div");
  wrap.id = "pwModal";
  wrap.className = "overlay";
  wrap.innerHTML = `
    <form class="modal" style="justify-items:stretch;text-align:left;width:min(440px,100%)" onsubmit="submitPasswordChange(event)">
      <h2 style="font-size:22px">비밀번호 변경</h2>
      <div class="field"><label for="pwCur">현재 비밀번호</label><input id="pwCur" class="input" type="password" autocomplete="current-password"></div>
      <div class="field"><label for="pwNew">새 비밀번호 <small class="muted">(10자 이상)</small></label><input id="pwNew" class="input" type="password" autocomplete="new-password"></div>
      <div class="field"><label for="pwNew2">새 비밀번호 확인</label><input id="pwNew2" class="input" type="password" autocomplete="new-password"></div>
      <p id="pwError" class="form-error" role="alert"></p>
      <div class="row end"><button type="button" class="btn outline" onclick="closePasswordChange()">취소</button><button type="submit" class="btn primary" id="pwSubmit">변경</button></div>
    </form>`;
  document.body.appendChild(wrap);
  setTimeout(() => $("pwCur").focus(), 50);
}
function closePasswordChange() {
  const el = $("pwModal");
  if (el) el.remove();
}
async function submitPasswordChange(event) {
  event.preventDefault();
  const cur = $("pwCur").value;
  const next = $("pwNew").value;
  const error = $("pwError");
  if (next.length < 10) { error.textContent = "새 비밀번호는 10자 이상이어야 합니다."; return; }
  if (next !== $("pwNew2").value) { error.textContent = "새 비밀번호가 서로 다릅니다."; return; }
  $("pwSubmit").disabled = true;
  try {
    const res = await apiFetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: cur, new_password: next }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { error.textContent = data.error || "비밀번호를 변경하지 못했습니다."; return; }
    closePasswordChange();
    toast("비밀번호를 변경했습니다.");
  } catch (err) {
    error.textContent = userErrorMessage(err);
  } finally {
    const btn = $("pwSubmit");
    if (btn) btn.disabled = false;
  }
}

/* ---------- navigation ---------- */
const APP_TABS = ["dashboard", "practice", "analysis", "summary", "questions", "translate"];
const ADMIN_TABS_IDS = ["users", "usage", "tokens"];
/* the address bar mirrors the screen: #/ · #/login · #/app/<tab> · #/admin/<tab> */
function routeOf() {
  if (state.view === "login") return "#/login";
  if (state.view === "admin") return `#/admin/${state.adminTab}`;
  if (state.view === "app") return `#/app/${state.tab}`;
  return "#/";
}
function parseRoute(hash) {
  const parts = String(hash || "").replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!parts.length) return { view: "home" };
  if (parts[0] === "login") return { view: "login" };
  if (parts[0] === "app") return { view: "app", tab: APP_TABS.includes(parts[1]) ? parts[1] : "dashboard" };
  if (parts[0] === "admin") return { view: "admin", tab: ADMIN_TABS_IDS.includes(parts[1]) ? parts[1] : "users" };
  return { view: "home" };
}
function syncHash(push) {
  const target = routeOf();
  if (location.hash === target) return;
  try {
    if (push) history.pushState(null, "", target);
    else history.replaceState(null, "", target);
  } catch (_) {
    location.hash = target;
  }
}
function go(view, tab, options = {}) {
  const push = options.push !== false;
  closeUserMenu();
  if ((view === "app" || view === "admin") && !state.user) {
    state.pending = { view, tab: tab || (view === "admin" ? state.adminTab : state.tab) };
    state.view = "login";
    syncHash(push);
    render();
    return;
  }
  if (view === "admin" && state.user.role !== "admin") {
    toast("관리자만 사용할 수 있습니다.", "bad");
    return;
  }
  state.view = view;
  if (view === "app" && tab) state.tab = tab;
  if (view === "admin" && tab) state.adminTab = tab;
  syncHash(push);
  render();
}
function applyRoute(hash, push = false) {
  const route = parseRoute(hash);
  go(route.view, route.tab, { push });
}
function setTab(tab) {
  go("app", tab);
}
function setView(view, tab) {
  go(view, tab);
}
function toggleUserMenu(event) {
  event.stopPropagation();
  const el = $("userMenu");
  if (el) el.classList.toggle("open");
}
function closeUserMenu() {
  const el = $("userMenu");
  if (el) el.classList.remove("open");
}
document.addEventListener("click", (event) => {
  const el = $("userMenu");
  if (el && !el.contains(event.target)) el.classList.remove("open");
});

/* ---------- analysis history (per account, stored on the server) ---------- */
function normalizeHistoryItem(m) {
  return { ...m, date: m.created_at || m.date || "", llmFailed: Boolean(m.llm_failed ?? m.llmFailed), fillers: Number(m.fillers || 0), wpm: Number(m.wpm || 0), score: Number(m.score || 0) };
}
function historyList() {
  return state.history;
}
async function loadHistory(force = false) {
  if (!state.user) { state.history = []; state.historyLoaded = false; return; }
  if (state.historyLoaded && !force) return;
  try {
    const res = await apiFetch("/api/history");
    const data = await res.json().catch(() => ({}));
    state.history = data.ok ? (data.items || []).map(normalizeHistoryItem) : [];
  } catch (_) {
    state.history = [];
  }
  state.historyLoaded = true;
}
async function historyAdd(analysis, meta) {
  try {
    const res = await apiFetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: meta.title || "", audio: meta.audio || "", material: meta.material || "", analysis }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "저장 실패");
    const item = normalizeHistoryItem(data.item);
    state.history = [item, ...state.history.filter((h) => h.id !== item.id)];
    state.historyLoaded = true;
    return item;
  } catch (err) {
    toast(`분석 결과를 서버에 저장하지 못했습니다: ${userErrorMessage(err)}`, "bad");
    return null;
  }
}
async function historyRemove(id) {
  try {
    const res = await apiFetch(`/api/history/${encodeURIComponent(id)}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "삭제 실패");
    state.history = state.history.filter((item) => item.id !== id);
    toast("분석 기록을 삭제했습니다.");
  } catch (err) {
    toast(userErrorMessage(err, "삭제하지 못했습니다."), "bad");
  }
  if (state.view === "app" && state.tab === "dashboard") renderDashboard();
}
async function historyOpen(id, tab = "analysis") {
  try {
    const res = await apiFetch(`/api/history/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || "불러오지 못했습니다.");
    const meta = normalizeHistoryItem(data.item.meta || {});
    state.analysis = data.item.analysis;
    state.analysisMeta = { title: meta.title, audio: meta.audio, material: meta.material, date: meta.date, historyId: id };
    const qa = data.item.qa || {};
    state.qaAnswers = { ...(qa.answers || {}) };
    state.qaResults = { ...(qa.results || {}) };
    state.qaInfo = { ...(qa.info || {}) };
    state.qaRedo = {};
    state.qaModel = {};
    state.qaOpen = 0;
    go("app", tab);
  } catch (err) {
    toast(userErrorMessage(err, "분석 기록을 불러오지 못했습니다."), "bad");
  }
}

/* ==========================================================================
   SHELL — topbar, footer, page header, login, render loop
   ========================================================================== */
const NAV = [
  ["dashboard", "발표 연습"],
  ["analysis", "분석 결과"],
  ["questions", "예상 질문"],
  ["translate", "실시간 번역"],
];
const JUDGES = ["투자 심사역 AI", "기술 전문가 AI", "산업 전문가 AI"];

function brandMark(small = false) {
  return `<span class="mark">${icon("mic")}</span><span>AI 발표음성평가</span>`;
}

function renderTopbar() {
  const u = state.user;
  const top = $("topbar");
  top.className = "topbar";
  const onApp = state.view === "app";
  top.innerHTML = `
    <div class="topbar-inner">
      <a class="brand" href="#" onclick="go('home');return false;">${brandMark()}</a>
      <nav class="topnav" aria-label="주요 메뉴">
        ${NAV.map(([id, label]) => `<button class="${onApp && state.tab === id ? "is-on" : ""}" onclick="go('app','${id}')">${label}</button>`).join("")}
      </nav>
      <div class="topbar-actions">
        ${u ? userActions(u) : `<button class="btn primary" onclick="go('app','dashboard')">사전심사 시작</button>`}
      </div>
    </div>`;
}

function userActions(u) {
  const initial = String(u.name || u.id || "?").trim().slice(0, 1).toUpperCase();
  const admin = u.role === "admin";
  return `
    ${admin ? `<button class="btn outline sm ${state.view === "admin" ? "violet" : ""}" onclick="go('admin')">${icon("shield")}관리자 메뉴</button>` : ""}
    <div class="user-menu" id="userMenu">
      <button onclick="toggleUserMenu(event)" aria-haspopup="true"><span class="avatar">${html(initial)}</span><span class="name">${html(u.name || u.id)}</span>${icon("chevronDown", "sm")}</button>
      <div class="pop">
        <div class="who"><b>${html(u.name || u.id)}</b><small>${html(u.id)} · ${admin ? "관리자" : "일반 계정"}</small></div>
        ${admin ? `<button onclick="go('admin','users')">${icon("users")}사용자 관리</button><button onclick="go('admin','usage')">${icon("activity")}API 호출 관리</button>` : ""}
        <button onclick="openPasswordChange()">${icon("lock")}비밀번호 변경</button>
        <button class="danger" onclick="logout()">${icon("logout")}로그아웃</button>
      </div>
    </div>`;
}

function renderFooter() {
  const foot = $("siteFooter");
  if (state.view === "home") {
    foot.className = "site-footer home";
    foot.innerHTML = `
      <div class="container">
        <div class="foot-grid">
          <div class="foot-brand"><span class="brand">${brandMark()}</span><p>AI 심사위원 사전심사. 발표 음성과 자료를 올리면 전사문, 심사표, 예상 질문을 돌려드립니다.</p></div>
          <nav class="foot-col" aria-label="바로가기"><span class="k">바로가기</span><button onclick="go('app','dashboard')">발표 연습</button><button onclick="go('app','analysis')">분석 결과</button><button onclick="go('app','questions')">예상 질문</button></nav>
          <div class="foot-col"><span class="k">결과물</span><button onclick="go('app','analysis')">문장별 전사문</button><button onclick="go('app','summary')">심사표와 점수</button><button onclick="go('app','questions')">예상 질문</button><button onclick="go('app','summary')">PDF 리포트</button></div>
          <div class="foot-col"><span class="k">회사</span><span>㈜코드데이원</span><span>이용약관</span><span>개인정보처리방침</span></div>
        </div>
        <div class="foot-line"><span>© 2026 STT Presentation Review</span><span>AI 발표 사전심사 도구</span></div>
      </div>`;
    return;
  }
  foot.className = "site-footer";
  foot.innerHTML = `<div class="container foot-inner"><span class="brand">${brandMark()}<small>· ㈜코드데이원 · AI 발표 사전심사 도구</small></span><span>© 2026 STT Presentation Review</span></div>`;
}

/* page header band: breadcrumb · title · actions · (stepper | tabs) */
const STEPS = [["등록", "발표자료 등록"], ["연습", "발표 연습"], ["결과", "분석 결과"]];
function stepper(current, doneUpTo = current - 1) {
  return `<div class="stepper">${STEPS.map(([, label], i) => {
    const n = i + 1;
    const cls = n === current ? "is-on" : n <= doneUpTo ? "done" : "";
    const dot = n <= doneUpTo && n !== current ? icon("check") : n;
    return `${i ? "<hr>" : ""}<span class="step ${cls}"><i>${dot}</i>${label}</span>`;
  }).join("")}</div>`;
}
const RESULT_TABS = [["analysis", "분석 결과"], ["summary", "종합 결과"], ["questions", "예상 질문 연습"]];
function pageHead({ crumbs = [], title = "", sub = "", actions = "", step = 0, tabs = null, plain = false }) {
  const crumbHtml = `<div class="crumb"><button onclick="go('home')">${icon("home")}홈</button>${crumbs.map((c, i) => `<span>/</span>${i === crumbs.length - 1 ? `<b>${html(c)}</b>` : `<span>${html(c)}</span>`}`).join("")}</div>`;
  const foot = step || tabs ? `<div class="page-foot">${step ? stepper(step, ready() ? 3 : step - 1) : "<span></span>"}${tabs ? `<div class="tabs">${tabs.map(([id, label]) => `<button class="${state.tab === id ? "is-on" : ""}" onclick="go('app','${id}')">${label}</button>`).join("")}</div>` : ""}</div>` : "";
  return `
    <header class="page-head ${plain ? "plain" : ""}">
      <div class="container page-head-inner">
        ${crumbHtml}
        <div class="page-title-row"><div><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ""}</div>${actions ? `<div class="page-actions">${actions}</div>` : ""}</div>
        ${foot}
      </div>
    </header>`;
}

function renderLogin() {
  $("view").innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <div class="head">
          <span class="brand" style="margin-bottom:10px">${brandMark()}</span>
          <h1>로그인</h1>
          <p>관리자가 발급한 아이디와 비밀번호로 로그인하세요.</p>
        </div>
        <form onsubmit="submitLogin(event)" autocomplete="on">
          <div class="field"><label for="loginId">아이디</label><input id="loginId" class="input" autocomplete="username" placeholder="아이디 또는 이메일" autofocus></div>
          <div class="field"><label for="loginPw">비밀번호</label><input id="loginPw" class="input" type="password" autocomplete="current-password" placeholder="비밀번호"></div>
          <p id="loginError" class="form-error" role="alert"></p>
          <button class="btn primary lg wide" id="loginSubmit" type="submit">로그인</button>
        </form>
        <p class="foot">계정이 없으면 관리자에게 발급을 요청하세요. 발표 분석·번역·답변 평가는 로그인한 계정별로 사용 기록이 남습니다.</p>
      </div>
    </div>`;
  setTimeout(() => { const el = $("loginId"); if (el) el.focus(); }, 30);
}

/* floating screen switcher (bottom dock) on the result screens, as in the design file */
const DOCK_TABS = [["analysis", "분석 결과"], ["summary", "종합 결과"], ["questions", "예상 질문"], ["translate", "실시간 번역"]];
function renderDock() {
  const show = state.user && state.view === "app" && DOCK_TABS.some(([id]) => id === state.tab);
  let el = $("dock");
  if (!show) {
    if (el) el.remove();
    document.body.classList.remove("has-dock");
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "dock";
    el.className = "dock";
    el.setAttribute("aria-label", "화면 전환");
    document.body.appendChild(el);
  }
  document.body.classList.add("has-dock");
  el.innerHTML = `<span class="k">화면</span><div class="seg" role="tablist">${DOCK_TABS.map(([id, label]) => `<button type="button" role="tab" aria-pressed="${state.tab === id}" class="${state.tab === id ? "is-on" : ""}" onclick="go('app','${id}')">${label}</button>`).join("")}</div>`;
}

function render() {
  syncHash(false);
  document.body.classList.toggle("is-home", state.view === "home");
  renderTopbar();
  if (state.view === "home") renderHome();
  else if (state.view === "login") renderLogin();
  else if (state.view === "app") renderApp();
  else if (state.view === "admin") renderAdmin();
  renderFooter();
  renderDock();
  window.scrollTo({ top: 0 });
}
function renderApp() {
  if (state.tab === "dashboard") renderDashboard();
  else if (state.tab === "practice") renderPractice();
  else if (state.tab === "analysis") renderAnalysis();
  else if (state.tab === "summary") renderSummary();
  else if (state.tab === "questions") renderQuestions();
  else if (state.tab === "translate") renderTranslate();
  else renderDashboard();
}
/* re-render the current screen after a streaming/recognition event without scrolling */
function renderCurrent() {
  if (state.view !== "app") return;
  if (state.tab === "practice" && state.practice.active) {
    updatePracticeClocks();
    updatePracticeLive();
    return;
  }
  if (state.tab === "questions" && state.qaListening) {
    updateAnswerLive();
    return;
  }
  renderApp();
}

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

window.addEventListener("popstate", () => {
  applyRoute(location.hash, false);
});
async function boot() {
  await loadMe();
  applyRoute(location.hash, false);
}

/* ==========================================================================
   HOME (Main) — landing page with a working sample 심사표
   ========================================================================== */
const SAMPLE = {
  title: "2026 예비창업패키지 IR 발표",
  deck: "sample_pitch_deck.pptx",
  audio: "sample_pitch.m4a",
  date: "2026-10-15",
  length: "5분 12초",
  scores: [["발표 흐름", 82], ["내용 전달력", 76], ["Q&A 대응", 70], ["시간 관리", 65]],
  total: 78,
  grade: "B+",
  psst: [["P", "문제 인식", "문제 정의가 구체적이고 고객 인터뷰 근거가 있습니다.", 80, "p"], ["S", "실현 가능성", "핵심 기술의 검증 데이터가 부족합니다.", 72, "p"], ["S", "성장 전략", "시장 규모 산출 근거(SAM·SOM)를 보강하세요.", 68, "o"], ["T", "팀 구성", "팀 경력과 역할이 사업 내용과 잘 맞습니다.", 85, "s"]],
  judges: [["coins", "투자 심사역 AI", 74, "시장 규모 수치는 있으나 산출 근거가 약합니다. SAM·SOM을 구분해 주세요."], ["code", "기술 전문가 AI", 81, "페이지–음성 매칭 방식이 명확합니다. 정확도 검증 데이터를 덧붙이면 좋겠습니다."], ["compass", "산업 전문가 AI", 79, "초기 고객을 대학 창업지원단으로 좁힌 점이 설득력 있습니다."]],
  summary: "전달력은 양호하지만 후반부 시간 관리가 아쉽습니다. 수치 근거를 보강하면 상위 등급이 가능합니다.",
  lines: [
    ["00:00", "안녕하세요, 오늘 발표를 맡은 발표자입니다.", "페이지 1 · 공백 0.8초", false],
    ["00:08", "저희는 발표 연습을 돕는 AI 심사 서비스를 만들고 있습니다.", "142 WPM", false],
    ["00:17", "시장은 <mark>어,</mark> 굉장히 큰 시장이고요.", "추임새 · 자료 외 발화", true],
    ["00:24", "국내 창업지원사업 발표 인원은 연간 2만 명이 넘습니다.", "페이지 2 · 131 WPM", false],
    ["00:33", "<mark>그,</mark> 기존 서비스는 문서 요약에 그치고 평가는 하지 못합니다.", "추임새", true],
    ["00:42", "저희 기술은 자료 페이지와 음성 구간을 자동으로 매칭합니다.", "페이지 3 · 128 WPM", false],
  ],
  fillers: [["어", 6], ["그", 4], ["음", 3], ["이제", 1]],
  pages: [["1 · 표지", "0:42", 0, ""], ["2 · 문제 정의", "1:38", 86, ""], ["3 · 해결책", "1:12", 71, ""], ["4 · 시장 규모", "0:55", 48, "누락 키워드: SAM, SOM"], ["5 · 팀", "0:31", 90, ""]],
  questions: [["coins", "투자 심사역 AI", "초기 고객 확보 비용(CAC)은 얼마로 추정하시나요?", "답변 82점"], ["code", "기술 전문가 AI", "한국어 추임새 인식 정확도는 어떻게 검증했나요?", "답변 76점"], ["compass", "산업 전문가 AI", "대학 창업지원단 외에 확장할 시장은 어디입니까?", ""]],
  history: [["2026 예비창업패키지 IR 발표", "10월 15일", 78, "B+", "+7"], ["예비창업패키지 발표 연습 2차", "10월 9일", 71, "B", "+5"], ["예비창업패키지 발표 연습 1차", "10월 3일", 66, "C+", ""], ["데모데이 리허설", "9월 26일", 73, "B", ""]],
};

function renderHome() {
  $("view").innerHTML = `
    <section class="hero container">
      <span class="eyebrow reveal">${icon("mic", "sm")}AI 심사위원 사전심사</span>
      <h1 class="reveal" style="--d:80ms">연습한 발표를<br>심사표로 받는다</h1>
      <p class="lead reveal" style="--d:160ms">발표 음성과 자료를 올리면 문장별 전사문, 심사표, 예상 질문을 돌려드립니다.<br>무대에 서기 전에 AI 심사위원 셋에게 먼저 심사받으세요.</p>
      <div class="cta reveal" style="--d:240ms">
        <button class="btn primary lg" onclick="go('app','dashboard')">사전심사 시작 ${icon("arrowRight")}</button>
        <button class="btn outline lg" onclick="document.getElementById('preview').scrollIntoView({behavior:'smooth'})">샘플 심사표 보기</button>
      </div>
      <div class="notes reveal" style="--d:320ms"><span>${icon("circleCheck")}분석 약 3분</span><span>${icon("circleCheck")}음성 파일 없이 바로 녹음</span><span>${icon("circleCheck")}PDF 리포트 제공</span></div>
    </section>

    <section class="preview container" id="preview" aria-label="샘플 심사표">
      <div class="sheet reveal">
        <div class="sheet-head">
          <div class="file"><span class="icon-box neutral">${icon("file")}</span><div><b>${SAMPLE.title}</b><small>${SAMPLE.audio} · ${SAMPLE.deck} · ${SAMPLE.date} · ${SAMPLE.length}</small></div></div>
          <div class="tabs">${[["score", "심사표"], ["transcript", "전사문"], ["pages", "페이지 기록"], ["questions", "예상 질문"]].map(([id, label]) => `<button class="${state.homeSheet === id ? "is-on" : ""}" onclick="setHomeSheet('${id}')">${label}</button>`).join("")}</div>
          <div class="tail"><span class="badge good pill">${icon("party", "sm")}통과 예상</span><button class="btn outline sm" onclick="go('app','dashboard')">${icon("download")}PDF 리포트</button></div>
        </div>
        <div id="sheetBody">${sheetBody()}</div>
      </div>
    </section>

    <section class="how">
      <div class="container">
        <span class="sec-eyebrow reveal">${icon("listCheck")}진행 방식</span>
        <h2 class="reveal" style="--d:60ms">등록부터 심사표까지, 네 단계</h2>
        <p class="lead reveal" style="--d:120ms">발표 한 번이면 끝납니다. 분석에는 약 3분이 걸립니다.</p>
        <div class="steps">
          ${[["upload", "등록", "m4a·wav·mp3 음성이나 브라우저 마이크 녹음, pptx·pdf 자료를 올립니다."], ["slides", "연습", "슬라이드를 넘기며 발표하면 페이지별 체류시간과 문장 단위 전사문이 기록됩니다."], ["listCheck", "분석", "AI 심사위원 3명이 발화·자료·내용(PSST) 세 축으로 채점합니다."], ["award", "심사표", "점수와 예상 질문을 받고 PDF 리포트로 내려받아 다음 연습에 반영합니다."]].map(([ic, t, d], i) => `<div class="step-card reveal" style="--d:${180 + i * 90}ms"><span class="icon-box">${icon(ic)}</span><span class="n">0${i + 1}</span><b>${t}</b><p>${d}</p></div>`).join("")}
        </div>
      </div>
    </section>

    <section class="feature">
      <div class="container inner">
        <div class="reveal">
          <span class="sec-eyebrow">${icon("mic")}전사문 · 발화 분석</span>
          <h3>말한 문장은 시각과 함께 전사되고,<br>발화 속도는 분당 어절 수로 돌아옵니다</h3>
          <p class="lead">추임새는 단어별로 세고, 문장 사이 공백과 화자별 발화 시간까지 기록합니다. 권장 속도는 분당 120~150어절입니다.</p>
          <div class="ticks"><span>${icon("check")}CLOVA Speech 기반 한국어 전사</span><span>${icon("check")}추임새 횟수 · 문장별 공백 · 화자별 발화 시간</span><span>${icon("check")}8개 언어 번역 전사문</span></div>
        </div>
        <div class="demo reveal" style="--d:120ms">
          <div class="d-head"><div><b>문장별 전사문</b><small>화자 1 · 42문장 · 5분 12초</small></div><span class="badge">CLOVA Speech</span></div>
          <div class="tx-list">${SAMPLE.lines.slice(0, 4).map(([t, text, meta, flag]) => `<div class="tx-row ${flag ? "flag" : ""}"><span class="t">${t}</span><span>${text}</span><span class="meta">${meta}</span></div>`).join("")}</div>
          <div class="d-foot">${SAMPLE.fillers.map(([w, n]) => `<span>${w} ${n}회</span>`).join("")}</div>
        </div>
      </div>
    </section>

    <section class="feature flip">
      <div class="container inner">
        <div class="reveal">
          <span class="sec-eyebrow">${icon("file")}자료 반영률 · 페이지 기록</span>
          <h3>발표자료를 올리면<br>페이지별 반영률까지 비교합니다</h3>
          <p class="lead">슬라이드마다 머문 시간과 자료 밖에서 말한 비율, 빠뜨린 키워드를 짚어 줍니다. 어느 페이지에서 시간을 잃었는지 바로 보입니다.</p>
        </div>
        <div class="demo reveal" style="--d:120ms">
          <div class="d-head"><div><b>페이지 기록</b></div><small>${SAMPLE.deck} · 5페이지</small></div>
          <div class="d-body">${SAMPLE.pages.map(([name, t, pct, miss], i) => `<div class="pg-row ${miss ? "flag" : ""}"><img class="thumb" src="assets/slides/slide-${i + 1}.svg" alt="" width="72" height="40"><span>${name}${miss ? `<span class="miss">${miss}</span>` : ""}</span><span class="t">${t}</span><div class="bar thin"><span><i class="${pct && pct < 60 ? "warn" : ""}" style="width:${pct}%"></i></span></div><span class="pct">${pct ? `${pct}%` : "—"}</span></div>`).join("")}</div>
          <div class="d-sum"><span>자료 반영률 <b>71%</b></span><span>자료 외 발화 <b>18%</b></span><span>시간 배분 편차 <b class="tone-bad">큼</b></span></div>
        </div>
      </div>
    </section>

    <section class="feature">
      <div class="container inner">
        <div class="reveal">
          <span class="sec-eyebrow">${icon("users")}심사위원 AI · 예상 질문</span>
          <h3>세 명의 AI 심사위원이<br>각자의 기준으로 묻습니다</h3>
          <p class="lead">투자 심사역, 기술 전문가, 산업 전문가 AI가 예상 질문 10개를 만들고, 답변을 100점 만점으로 평가해 모범 답변을 제시합니다.</p>
          <div class="chips">${JUDGES.map((j) => `<span class="chip outline">${j}</span>`).join("")}</div>
        </div>
        <div class="q-cards reveal" style="--d:120ms">${SAMPLE.questions.map(([ic, who, q, s]) => `<div class="q-card"><div class="who"><span>${icon(ic, "sm")}${who}</span>${s ? `<span class="badge good">${s}</span>` : `<span class="btn link sm">모범 답변 보기 ${icon("chevronRight", "sm")}</span>`}</div><p>${q}</p></div>`).join("")}</div>
      </div>
    </section>

    <section class="history container">
      <div class="wrap">
        <div class="reveal">
          <span class="sec-eyebrow">${icon("history")}평가 이력</span>
          <h3>연습할수록 점수가 올라갑니다 📈</h3>
          <p class="lead">모든 심사표는 이력으로 남습니다. 같은 발표를 반복 연습하면 항목별 변화와 남은 보완 사항을 한눈에 봅니다.</p>
        </div>
        <div class="table-wrap reveal" style="--d:120ms"><table><thead><tr><th>발표</th><th>날짜</th><th class="num">점수</th><th class="num">변화</th></tr></thead><tbody>
          ${SAMPLE.history.map(([t, d, s, g, delta]) => `<tr><td><b>${t}</b></td><td class="muted">${d}</td><td class="num"><b>${s}</b> <span class="tone-violet" style="font-size:12px;font-weight:700">${g}</span></td><td class="num ${delta ? "tone-good" : "muted"}">${delta ? `▲${delta.replace("+", "")}` : "—"}</td></tr>`).join("")}
        </tbody></table></div>
      </div>
    </section>

    <section class="cta-band container">
      <div class="wrap">
        <div class="reveal">
          <h2>먼저 심사받고<br>무대에 선다 🎤</h2>
          <p class="lead">버튼을 누르면 자료 등록 화면이 열립니다. 음성 파일이 없어도 바로 녹음할 수 있습니다.</p>
        </div>
        <div class="mini-form reveal" style="--d:120ms">
          <b>발표자료 등록</b>
          <div class="field"><label for="ctaTitle">발표 제목</label><input id="ctaTitle" class="input" placeholder="예: 2026 예비창업패키지 IR 발표" value="${html(state.title)}" oninput="state.title=this.value"></div>
          <div class="modes"><button class="btn outline ${state.ctaMode === "upload" ? "is-on" : ""}" onclick="ctaChoose(this,'upload')">${icon("upload")}음성 파일 올리기</button><button class="btn outline ${state.ctaMode === "record" ? "is-on" : ""}" onclick="ctaChoose(this,'record')">${icon("mic")}지금 녹음하기</button></div>
          <button class="btn primary lg wide" onclick="ctaStart()">사전심사 시작</button>
        </div>
      </div>
    </section>`;
  setupHomeReveal();
}

function sheetBody() {
  const s = SAMPLE;
  if (state.homeSheet === "transcript") {
    return `<div class="sheet-body single"><div><div class="tx-list">${s.lines.map(([t, text, meta, flag]) => `<div class="tx-row ${flag ? "flag" : ""}"><span class="t">${t}</span><span>${text}</span><span class="meta">${meta}</span></div>`).join("")}</div><div class="counts"><span>전체 <b>42문장</b></span><span>평균 <b>138 WPM</b></span><span>추임새 <b>14회</b></span><span>화자 <b>1명</b></span></div></div></div>`;
  }
  if (state.homeSheet === "pages") {
    return `<div class="sheet-body single"><div>${s.pages.map(([name, t, pct, miss], i) => `<div class="pg-row ${miss ? "flag" : ""}"><img class="thumb" src="assets/slides/slide-${i + 1}.svg" alt="" width="72" height="40"><span>${name}${miss ? `<span class="miss">${miss}</span>` : ""}</span><span class="t">${t}</span><div class="bar thin"><span><i class="${pct && pct < 60 ? "warn" : ""}" style="width:${pct}%"></i></span></div><span class="pct">${pct ? `${pct}%` : "—"}</span></div>`).join("")}<div class="counts"><span>자료 반영률 <b>71%</b></span><span>자료 외 발화 <b>18%</b></span><span>시간 배분 편차 <b class="tone-bad">큼</b></span></div></div></div>`;
  }
  if (state.homeSheet === "questions") {
    return `<div class="sheet-body single"><div class="q-cards" style="padding:20px 24px">${s.questions.map(([ic, who, q, sc]) => `<div class="q-card"><div class="who"><span>${icon(ic, "sm")}${who}</span>${sc ? `<span class="badge good">${sc}</span>` : `<span class="btn link sm">모범 답변 보기 ${icon("chevronRight", "sm")}</span>`}</div><p>${q}</p></div>`).join("")}</div></div>`;
  }
  return `
    <div class="sheet-body">
      <div>
        <span class="sec">${icon("award")}종합 점수</span>
        <div class="stat-value">${s.total}<small>/100</small><span class="grade" style="background:var(--primary);color:#fff">${s.grade}</span></div>
        <div class="bars" style="margin-top:22px">${s.scores.map(([k, v]) => bar(k, v, v >= 70 ? "good" : "warn")).join("")}</div>
        <div class="mini-tiles"><div class="mini-tile"><small>평균 발화 속도</small><b>138<small>WPM</small></b></div><div class="mini-tile"><small>추임새</small><b>14<small>회</small></b></div><div class="mini-tile"><small>자료 반영률</small><b>71<small>%</small></b></div><div class="mini-tile"><small>자료 외 발화</small><b>18<small>%</small></b></div></div>
      </div>
      <div>
        <div class="card-head" style="margin-bottom:18px"><span class="sec" style="margin:0">${icon("listCheck")}PSST 항목별 피드백</span><span class="card-meta">예비창업패키지 기준</span></div>
        <div class="psst">${s.psst.map(([l, t, d, sc, tone]) => `<div class="psst-row"><i class="${tone}">${l}</i><div><b>${t}</b><small>${d}</small></div><span class="score ${sc < 70 ? "tone-warn" : ""}">${sc}</span></div>`).join("")}</div>
        <div class="counts"><span>문제점 <b>3건</b></span><span>보완 사항 <b>2건</b></span><span>예상 질문 <b>10개</b></span></div>
      </div>
      <div>
        <span class="sec">${icon("users")}심사위원 AI 의견</span>
        ${s.judges.map(([ic, who, sc, text]) => `<div class="judge-row"><span class="icon-box round" style="width:32px;height:32px">${icon(ic, "sm")}</span><div><b>${who} <span>· ${sc}점</span></b><p>${text}</p></div></div>`).join("")}
        <div class="judge-sum"><b>종합 의견</b> ${s.summary}</div>
      </div>
    </div>`;
}
function setHomeSheet(id) {
  state.homeSheet = id;
  const body = $("sheetBody");
  if (body) body.innerHTML = sheetBody();
  document.querySelectorAll(".sheet-head .tabs button").forEach((b, i) => b.classList.toggle("is-on", ["score", "transcript", "pages", "questions"][i] === id));
}
function ctaChoose(button, mode) {
  state.ctaMode = mode;
  button.parentElement.querySelectorAll("button").forEach((b) => b.classList.toggle("is-on", b === button));
}
function ctaStart() {
  go("app", state.ctaMode === "record" ? "practice" : "dashboard");
}

/* ---------- scroll reveal: each block fades up the first time it enters the viewport ---------- */
let homeRevealObserver = null;
function setupHomeReveal() {
  if (homeRevealObserver) homeRevealObserver.disconnect();
  const els = [...document.querySelectorAll("#view .reveal")];
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    els.forEach((el) => el.classList.add("is-in"));
    return;
  }
  homeRevealObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-in");
      homeRevealObserver.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  els.forEach((el) => homeRevealObserver.observe(el));
}

/* ==========================================================================
   DASHBOARD — 발표 연습 (새 발표 등록 · 통계 · 내 발표)
   ========================================================================== */
function renderDashboard() {
  if (!state.historyLoaded) {
    loadHistory().then(() => { if (state.view === "app" && state.tab === "dashboard") renderDashboard(); });
  }
  const hist = historyList();
  const open = state.registerOpen || !hist.length;
  const actions = hist.length
    ? `<button class="btn ${open ? "primary" : "outline"}" onclick="toggleRegister()">${open ? `${icon("x")}등록 닫기` : `${icon("plus")}새 발표 등록`}</button>`
    : "";
  $("view").innerHTML = pageHead({ crumbs: ["발표 연습"], title: "발표 연습", sub: "새 발표를 등록하거나, 등록한 발표를 이어서 연습하고 심사 결과를 확인하세요.", actions, plain: true }) + `
    <div class="page-body"><div class="container stack-24">
      ${open ? registerCard() : ""}
      ${statsCards(hist)}
      ${resumeBand()}
      ${myList(hist)}
    </div></div>`;
}
function toggleRegister() {
  state.registerOpen = !state.registerOpen;
  renderDashboard();
}
function segmentedMinutes() {
  return `<span class="segmented sm">${[5, 7, 10].map((m) => `<button class="${state.targetMinutes === m ? "is-on" : ""}" onclick="setMinutes(${m})">${m}분</button>`).join("")}</span>`;
}
function setMinutes(m) {
  state.targetMinutes = Number(m);
  if (state.view === "app") renderApp();
}

function registerCard() {
  const audio = state.selectedFile;
  const mat = state.selectedMaterial;
  return `
    <section class="card outline-violet register">
      <div class="stack-24">
        <div class="card-head" style="margin:0"><span class="card-title" style="font-size:20px"><span class="icon-box">${icon("upload")}</span>새 발표 등록</span><span class="card-meta">음성 또는 자료 하나만 있어도 시작할 수 있습니다</span></div>
        <div class="field"><label for="titleInput">발표 제목</label><input id="titleInput" class="input" placeholder="예: 2026 예비창업패키지 IR 발표 3차" value="${html(state.title)}" oninput="state.title=this.value"></div>
        <div class="files">
          <label class="dropzone ${audio ? "has-file" : ""}" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handleAudioDrop(event)">
            <input type="file" accept=".mp3,.wav,.m4a,.aac,.flac,audio/*" onchange="handleAudioSelected(this)" aria-label="발표 음성 파일">
            <span class="icon-box round">${icon("mic")}</span>
            <b>발표 음성 <span>${audio ? "" : "선택"}</span></b>
            ${fileChip(audio, "m4a · mp3 · wav 또는 연습 화면에서 녹음")}
          </label>
          <label class="dropzone plain ${mat ? "has-file" : ""}" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handleMaterialDrop(event)">
            <input type="file" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onchange="handleMaterialSelected(this)" aria-label="발표자료 파일">
            <span class="icon-box round neutral">${icon("file")}</span>
            <b>발표자료 <span>${mat ? "" : "선택"}</span></b>
            ${fileChip(mat, "pptx · pdf · 페이지별 반영률 분석")}
          </label>
        </div>
        <div class="opts">
          <span class="inline-label">발표 시간 ${segmentedMinutes()}</span>
          <span class="judges">심사위원 ${JUDGES.map((j) => `<span class="chip outline">${j}</span>`).join("")}</span>
        </div>
        <div class="actions">
          <button class="btn primary lg" onclick="goPracticeFromRegister()">${icon("play")}발표 연습으로 이동</button>
          <button class="btn outline violet lg" onclick="analyzePresentation()" ${state.busy ? "disabled" : ""}>${icon("sparkle")}${state.busy ? "분석 중..." : "바로 분석하기"}</button>
          <button class="btn ghost" onclick="clearRegister()">취소</button>
        </div>
      </div>
      <aside>
        ${cardHead("진행 순서", "listCheck")}
        <ol class="num-list">
          <li><i>1</i><span><b>등록</b> · 음성·자료를 올리고 발표 시간을 정합니다</span></li>
          <li><i>2</i><span><b>연습</b> · 슬라이드를 넘기며 발표하면 페이지별 체류시간이 기록됩니다</span></li>
          <li><i>3</i><span><b>결과</b> · 약 3분 뒤 심사표·문제점·예상 질문 10개를 받습니다</span></li>
        </ol>
        <p class="hint">음성 파일이 이미 있으면 연습 없이 바로 분석할 수 있습니다.</p>
      </aside>
    </section>`;
}

function statsCards(hist) {
  const done = hist.filter((h) => !h.llmFailed);
  const latest = done[0];
  const prev = done[1];
  const recent = done.slice(0, 5);
  const avg = recent.length ? Math.round(recent.reduce((s, h) => s + h.score, 0) / recent.length * 10) / 10 : 0;
  const best = done.length ? Math.max(...done.map((h) => h.score)) : 0;
  const delta = latest && prev ? latest.score - prev.score : null;
  const fd = latest && prev ? latest.fillers - prev.fillers : null;
  const none = `<small>아직 없음</small>`;
  return `
    <section class="grid-4 dash-stats">
      <div class="card stat sm"><span class="stat-label">${icon("folder")}등록한 발표</span><div class="stat-value">${hist.length}<small>개 · 내 계정</small></div></div>
      <div class="card stat sm"><span class="stat-label">${icon("award")}최근 심사 점수</span><div class="stat-value">${latest ? `${latest.score}<span class="tone-violet" style="font-size:16px">${html(latest.grade)}</span>${delta !== null ? `<small class="${delta >= 0 ? "tone-good" : "tone-bad"}" style="font-weight:700">${delta >= 0 ? "▲" : "▼"}${Math.abs(delta)} (이전 ${prev.score})</small>` : ""}` : none}</div></div>
      <div class="card stat sm"><span class="stat-label">${icon("trending")}${recent.length || 5}회 평균</span><div class="stat-value">${recent.length ? `${avg}<small>점 · 최고 ${best}</small>` : none}</div></div>
      <div class="card stat sm"><span class="stat-label">${icon("volume")}추임새 추세</span><div class="stat-value">${latest ? `<span class="${fd !== null && fd > 0 ? "tone-bad" : ""}">${latest.fillers}</span><small>회${fd !== null ? ` · 이전 ${prev.fillers}회` : ""}</small>` : none}</div></div>
    </section>`;
}

function resumeBand() {
  const p = state.practice;
  const total = practicePageTotal();
  if (p.active) {
    return `<section class="resume">
      <div class="pages"><b>${p.currentPage}<small>/${total}</small></b><small>페이지</small></div>
      <div><div class="meta"><span class="badge pill" style="background:rgba(255,255,255,.14);color:#fff">연습 중</span><span>녹음과 전사가 진행 중입니다</span></div><h3>${html(practiceTitle())}</h3><p>${html(practiceMaterialName())}</p></div>
      <div class="acts"><button class="btn white" onclick="go('app','practice')">${icon("play")}연습 화면으로</button></div>
    </section>`;
  }
  if (p.phase === "summary" && p.records.length) {
    return `<section class="resume">
      <div class="pages"><b>${total}<small>/${total}</small></b><small>페이지</small></div>
      <div><div class="meta"><span class="badge pill" style="background:rgba(255,255,255,.14);color:#fff">분석 대기</span><span>마지막 연습 ${formatDateTime(p.finishedAt)}</span></div><h3>${html(practiceTitle())}</h3><p>${html(practiceMaterialName())} · ${total}페이지 · ${formatDuration(p.totalSec)} 녹음됨</p></div>
      <div class="acts"><button class="btn on-dark" onclick="go('app','practice')">연습 요약 보기</button><button class="btn white" onclick="analyzePractice()" ${state.busy ? "disabled" : ""}>${icon("sparkle")}AI 심사 시작</button></div>
    </section>`;
  }
  return "";
}

function myList(hist) {
  const rows = filteredHistory(hist);
  return `
    <section class="card my-list">
      <div class="list-head">
        <div class="row"><h3>내 발표</h3><span class="segmented sm"><button class="is-on">전체 ${hist.length}</button></span></div>
        <div class="row"><div class="input-icon">${icon("search")}<input class="input sm" placeholder="발표 제목 검색" value="${html(state.histQuery)}" oninput="state.histQuery=this.value;renderMyList()"></div></div>
      </div>
      <div id="myList">${myRows(rows)}</div>
      <div class="list-foot"><span id="myListCount">${rows.length}개 표시 · 전체 ${hist.length}개</span><span>분석 결과는 계정별로 서버에 저장됩니다 (최근 50건)</span></div>
    </section>`;
}
function filteredHistory(hist) {
  const q = state.histQuery.trim().toLowerCase();
  return hist.filter((h) => !q || `${h.title} ${h.audio} ${h.material}`.toLowerCase().includes(q));
}
function myRows(rows) {
  if (!state.historyLoaded) return `<div class="table-empty">분석 기록을 불러오는 중입니다…</div>`;
  if (!rows.length) return `<div class="table-empty">아직 분석한 발표가 없습니다. 위에서 음성이나 자료를 등록하고 연습을 시작하세요.</div>`;
  return `<div class="pres-row head"><span></span><span>발표</span><span>상태</span><span>점수</span><span>발화 속도 · 추임새</span><span>날짜</span><span style="text-align:right">동작</span></div>`
    + rows.map((h) => `
      <div class="pres-row">
        <span class="icon-box ${h.llmFailed ? "orange" : ""}">${icon(h.llmFailed ? "alert" : "listCheck")}</span>
        <div class="title"><b>${html(h.title)}</b><small>${html([h.audio, h.material].filter(Boolean).join(" · ") || "실시간 전사")}</small></div>
        <span>${h.llmFailed ? badge("AI 실패", "warn") : badge("완료", "good")}</span>
        <span class="score ${h.llmFailed ? "none" : ""}">${h.llmFailed ? "—" : `${h.score}<span>${html(h.grade)}</span>`}</span>
        <span class="muted">${h.wpm ? `${h.wpm} WPM` : "—"} · 추임새 ${h.fillers}회</span>
        <span class="muted">${formatDateShort(h.date)}</span>
        <div class="acts"><button class="btn outline sm" onclick="historyOpen('${h.id}')">결과 보기</button><button class="btn ghost sm" title="삭제" aria-label="삭제" onclick="historyRemove('${h.id}')">${icon("trash")}</button></div>
      </div>`).join("");
}
function renderMyList() {
  const el = $("myList");
  if (!el) return;
  const hist = historyList();
  const rows = filteredHistory(hist);
  el.innerHTML = myRows(rows);
  const count = $("myListCount");
  if (count) count.textContent = `${rows.length}개 표시 · 전체 ${hist.length}개`;
}

/* ---------- file handling ---------- */
function handleAudioSelected(input) {
  applyAudioFile(input.files && input.files.length ? input.files[0] : null);
}
function applyAudioFile(file) {
  state.selectedFile = file;
  if (state.view === "app" && state.tab === "dashboard") renderDashboard();
}
function handleMaterialSelected(input) {
  applyMaterialFile(input.files && input.files.length ? input.files[0] : null);
}
function applyMaterialFile(file) {
  state.selectedMaterial = file;
  state.materialPreview = null;
  if (state.materialObjectUrl) URL.revokeObjectURL(state.materialObjectUrl);
  state.materialObjectUrl = file ? URL.createObjectURL(file) : "";
  // the registered deck is linked to practice automatically unless a practice is running
  if (file && !state.practice.active) linkPracticeMaterial(file);
  if (state.view === "app" && state.tab === "dashboard") renderDashboard();
}
function goPracticeFromRegister() {
  if (state.selectedMaterial && !state.practiceMaterial) linkPracticeMaterial(state.selectedMaterial);
  go("app", "practice");
}
function clearRegister() {
  state.selectedFile = null;
  state.selectedMaterial = null;
  state.materialPreview = null;
  state.title = "";
  renderDashboard();
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
    toast("M4A, MP3, WAV, AAC, FLAC 음성 파일을 올려 주세요.", "bad");
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
    toast("PPTX 또는 PDF 발표자료를 올려 주세요.", "bad");
    return;
  }
  applyMaterialFile(file);
}
function handlePracticeMaterialSelected(input) {
  applyPracticeMaterialFile(input.files && input.files.length ? input.files[0] : null);
}
function handlePracticeMaterialDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");
  const file = droppedFile(event);
  if (!file) return;
  if (!matchesDropType(file, MATERIAL_DROP_EXTENSIONS)) {
    toast("PPTX 또는 PDF 발표자료를 올려 주세요.", "bad");
    return;
  }
  applyPracticeMaterialFile(file);
}
async function fetchMaterialPreview(file) {
  const form = new FormData();
  form.append("material", file);
  const res = await apiFetch("/api/material-preview", { method: "POST", body: form });
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

/* ==========================================================================
   PRACTICE — 발표 연습 (빈 상태 · 연습 중 · 종료 요약)
   ========================================================================== */
function practicePageTotal() {
  if (!state.practiceMaterial) return 1;
  const p = state.practicePreview;
  return Math.max(1, Number(p?.page_count || p?.sections?.length || 1));
}
function practiceTitle() {
  return state.title.trim() || (state.practiceMaterial ? state.practiceMaterial.name.replace(/\.[^.]+$/, "") : "") || "제목 없는 발표";
}
function practiceMaterialName() {
  return state.practiceMaterial ? state.practiceMaterial.name : "자료 없음";
}
function practicePageTitle(n) {
  const section = (state.practicePreview?.sections || []).find((item) => Number(item.page) === n);
  const t = section && section.title ? String(section.title).trim() : "";
  return t ? t.slice(0, 18) : `페이지 ${n}`;
}
function recommendedPerPageSec() {
  return state.targetMinutes * 60 / practicePageTotal();
}
function linkPracticeMaterial(file) {
  state.practiceMaterial = file;
  state.practicePreview = null;
  state.practicePdfDoc = null;
  state.practicePdfRenderKey = "";
  state.practiceThumbs = {};
  if (state.practiceObjectUrl) URL.revokeObjectURL(state.practiceObjectUrl);
  state.practiceObjectUrl = file ? URL.createObjectURL(file) : "";
}
function applyPracticeMaterialFile(file) {
  if (state.practice.active) {
    toast("연습 중에는 자료를 바꿀 수 없습니다.", "bad");
    return;
  }
  linkPracticeMaterial(file);
  state.practice.currentPage = 1;
  state.practice.records = [];
  state.practice.phase = "setup";
  renderPractice();
}
function replacePracticeMaterial() {
  if (state.practice.active) {
    toast("연습 중에는 자료를 바꿀 수 없습니다.", "bad");
    return;
  }
  const input = $("prMaterialInput");
  if (input) input.click();
}
function leavePractice() {
  go("app", "dashboard");
}
function startVoiceOnlyPractice() {
  state.practice.phase = "live";
  renderPractice();
}
function togglePracticeShortcuts() {
  state.practice.shortcuts = !state.practice.shortcuts;
  renderPractice();
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

async function renderPractice() {
  const p = state.practice;
  if (p.phase === "summary" && !p.active) {
    renderPracticeSummary();
    return;
  }
  if (!state.practiceMaterial && p.phase !== "live" && !p.active) {
    renderPracticeEmpty();
    return;
  }
  if (state.practiceMaterial && !state.practicePreview) {
    $("view").innerHTML = practiceHead() + `<div class="page-body"><div class="container">${emptyState("발표자료를 불러오는 중입니다", "페이지를 준비하고 있습니다. 잠시만 기다려 주세요.", "refresh")}</div></div>`;
    try {
      await preparePracticePreview();
    } catch (err) {
      $("view").innerHTML = practiceHead() + `<div class="page-body"><div class="container">${emptyState("발표자료를 불러오지 못했습니다", userErrorMessage(err, "파일 형식을 확인해 주세요."), "alert", `<button class="btn outline" onclick="applyPracticeMaterialFile(null)">다른 자료 선택</button>`)}</div></div>`;
      return;
    }
  }
  renderPracticeLive();
}
function practiceHead() {
  return pageHead({ crumbs: ["AI 사전심사", "발표 연습"], title: "발표 연습", sub: "자료를 넘기며 발표하면 페이지별 체류시간과 음성 구간이 기록됩니다.", actions: `<button class="btn outline" onclick="go('home')">${icon("arrowLeft")}홈으로</button>`, step: 2 });
}

/* --- empty state: no deck yet --- */
function renderPracticeEmpty() {
  $("view").innerHTML = practiceHead() + `
    <div class="page-body"><div class="container layout-side">
      <section class="card practice-empty">
        <span class="icon-box xl">${icon("slides")}</span>
        <h2>연결된 발표자료가 없습니다</h2>
        <p>발표자료 등록에서 올린 PPT/PDF는 이 화면에 자동으로 연결됩니다. 지금 바로 올려도 되고, 자료 없이 음성만으로 연습할 수도 있습니다.</p>
        <label class="dropzone" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handlePracticeMaterialDrop(event)">
          <input type="file" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onchange="handlePracticeMaterialSelected(this)" aria-label="발표자료 첨부">
          <span class="icon" style="font-size:28px;color:var(--primary)"><svg viewBox="0 0 24 24">${ICONS.upload}</svg></span>
          <b>PPT/PDF 발표자료 첨부</b>
          <small>pptx · pdf · 최대 50MB · 파일을 끌어다 놓아도 됩니다</small>
          <span class="btn outline sm" style="margin-top:6px">파일 선택</span>
        </label>
        <div class="acts">
          <button class="btn primary lg" onclick="startVoiceOnlyPractice()">${icon("mic")}자료 없이 음성만 연습</button>
          <button class="btn outline lg" onclick="go('app','dashboard')">발표자료 등록으로 이동 ${icon("arrowRight")}</button>
        </div>
        <p class="foot">음성만 연습하면 페이지별 체류시간 없이 전사문과 시간 기록만 남습니다.</p>
      </section>
      <aside class="stack">
        <div class="card">
          ${cardHead("준비 체크리스트", "listCheck")}
          <p class="muted" style="font-size:13px;margin-bottom:14px">음성 또는 자료 하나만 있어도 연습을 시작할 수 있습니다.</p>
          <div class="check-list">
            <div class="check-row"><span class="dot">${icon("check")}</span><div><b>발표 음성</b><small>연습 중 마이크로 실시간 녹음</small></div></div>
            <div class="check-row pending"><span class="dot">!</span><div><b>발표자료</b><small>미연결 · PPTX 또는 PDF (선택)</small></div></div>
            <div class="check-row" id="micRow"><span class="dot">${icon("check")}</span><div><b>마이크 권한</b><small id="micNote">브라우저에서 확인 중</small></div></div>
          </div>
        </div>
        ${practiceSettingsCard()}
      </aside>
    </div></div>`;
  checkMicPermission();
}
function practiceSettingsCard() {
  const p = state.practice;
  const langs = [["en", "English"], ["ja", "日本語"], ["zh", "中文"]];
  return `
    <div class="card pr-setup">
      ${cardHead("연습 설정", "sliders")}
      <div class="seg-row"><span>발표 시간</span>${segmentedMinutes()}<small>권장 발화 속도 135 WPM 기준 약 ${state.targetMinutes * 135}어절</small></div>
      <div class="seg-row"><span>실시간 번역</span><div class="langs">${langs.map(([v, l]) => `<button class="chip sm ${state.targetLang === v ? "" : "outline"}" onclick="setTargetLang('${v}');renderPractice()">${l}</button>`).join("")}<select class="select sm" style="width:auto;height:28px;padding:0 32px 0 10px;font-size:13px;border-radius:999px" onchange="setTargetLang(this.value);renderPractice()">${TARGET_LANGS.map(([v, l]) => `<option value="${v}" ${state.targetLang === v ? "selected" : ""}>${l}</option>`).join("")}</select></div></div>
      <div class="sw"><div><b>페이지 넘김 단축키</b><small>스페이스바 · 방향키</small></div><button class="toggle ${p.shortcuts ? "is-on" : ""}" onclick="togglePracticeShortcuts()" aria-label="페이지 넘김 단축키" aria-pressed="${p.shortcuts}"></button></div>
    </div>`;
}
async function checkMicPermission() {
  const note = $("micNote");
  const row = $("micRow");
  if (!note || !row) return;
  try {
    if (!navigator.permissions?.query) throw new Error("no permissions api");
    const status = await navigator.permissions.query({ name: "microphone" });
    const apply = () => {
      if (status.state === "granted") { note.textContent = "허용됨 · 입력 정상"; row.className = "check-row"; }
      else if (status.state === "denied") { note.textContent = "차단됨 · 브라우저 주소창에서 허용해 주세요"; row.className = "check-row pending"; }
      else { note.textContent = "연습 시작 시 권한을 묻습니다"; row.className = "check-row pending"; }
    };
    apply();
    status.onchange = apply;
  } catch (_) {
    note.textContent = SpeechRecognition ? "연습 시작 시 권한을 묻습니다" : "이 브라우저는 실시간 음성 인식을 지원하지 않습니다 (Chrome/Edge 권장)";
    row.className = SpeechRecognition ? "check-row pending" : "check-row pending";
  }
}

/* --- live layout (before start and during practice) --- */
function renderPracticeLive() {
  const p = state.practice;
  const preview = state.practicePreview || {};
  const total = practicePageTotal();
  const current = Math.min(Math.max(1, p.currentPage), total);
  p.currentPage = current;
  const active = p.active;
  const linked = state.practiceMaterial && state.selectedMaterial && state.practiceMaterial === state.selectedMaterial;
  $("view").innerHTML = `
    <div class="pr-bar"><div class="pr-bar-inner">
      <div class="left">
        ${stepper(2, 1)}
        <span class="divider"></span>
        <div class="title"><b>${html(practiceTitle())}</b><small>${icon("file")}${html(practiceMaterialName())}${state.practiceMaterial ? ` · ${total}페이지${linked ? " · 등록 탭에서 연결됨" : ""}` : ""} <button class="btn link sm" onclick="replacePracticeMaterial()" ${active ? "disabled" : ""}>${state.practiceMaterial ? "교체" : "자료 첨부"}</button></small>
          <input id="prMaterialInput" type="file" hidden accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onchange="handlePracticeMaterialSelected(this)"></div>
      </div>
      <div class="right" id="prBarRight">${practiceBarRight()}</div>
    </div></div>
    <div class="pr-layout">
      <aside class="pr-pages">
        <div class="ph"><span>페이지</span><span>체류시간</span></div>
        <div class="pr-thumbs" id="prThumbs">${practiceThumbsHtml()}</div>
        <p class="foot">권장 페이지당 ${formatShortClock(recommendedPerPageSec())} · 목표 ${state.targetMinutes}분</p>
      </aside>
      <section class="pr-stage">
        <div class="pr-slide">
          ${renderMaterialPage(preview, current)}
          <div class="pr-nav" id="prNav">${practiceNavHtml()}</div>
        </div>
        <div class="pr-mic" id="prMic">${practiceMicHtml()}</div>
      </section>
      <aside class="pr-side">
        <div class="pr-timer" id="prTimer">${practiceTimerHtml()}</div>
        <div class="card">${cardHead("페이지별 체류시간", "hourglass", "권장 대비")}<div class="dwell" id="prDwell">${dwellRowsHtml()}</div></div>
        <div class="card">${cardHead("실시간 전사", "mic", `<span class="badge">${html(TARGET_LANGS.find(([v]) => v === state.targetLang)?.[1] || "")} 번역은 연습 후</span>`)}<div class="live-tx" id="prLive">${liveRowsHtml()}</div><div class="live-tx-foot" id="prLiveFoot">${liveFootHtml()}</div></div>
      </aside>
    </div>`;
  if (isPracticePdf()) {
    renderPracticePdfPage(current);
    renderPracticeThumbs();
  }
}
function practiceBarRight() {
  const p = state.practice;
  if (p.active) {
    return `<span class="pill live">녹음 중 · <span id="prBarClock">${formatClock(practiceElapsedSec())}</span></span><button class="btn primary" onclick="finishPractice()">${icon("stop")}연습 종료</button>`;
  }
  return `<button class="btn outline" onclick="leavePractice()">${icon("arrowLeft")}등록으로</button><button class="btn primary" onclick="startPractice()">${icon("play")}연습 시작</button>`;
}
function practiceThumbsHtml() {
  const total = practicePageTotal();
  const p = state.practice;
  const dwell = dwellMap();
  const rec = recommendedPerPageSec();
  const pdf = isPracticePdf();
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const sec = dwell[n];
    const warn = sec && sec > rec * 1.25;
    const live = p.active && n === p.currentPage;
    const value = live ? formatShortClock(currentPageElapsedSec() + (sec || 0)) : sec ? formatShortClock(sec) : "—";
    const img = pdf
      ? (state.practiceThumbs[n] ? `<img src="${state.practiceThumbs[n]}" alt="">` : `<span>${n}</span>`)
      : (state.practiceMaterial ? `<div class="lines"><i></i><i></i><i></i></div>` : `<span>음성만 연습</span>`);
    return `<button class="pr-thumb ${n === p.currentPage ? "is-on" : ""}" onclick="jumpPracticePage(${n})" ${p.active ? "disabled" : ""}><div class="img" id="thumb-${n}">${img}</div><div class="cap"><b>${n} · ${html(state.practiceMaterial ? practicePageTitle(n) : "전체")}</b><span class="${warn ? "warn" : ""}" id="thumbTime-${n}">${value}</span></div></button>`;
  }).join("");
}
function practiceNavHtml() {
  const p = state.practice;
  const total = practicePageTotal();
  const current = p.currentPage;
  const rec = recommendedPerPageSec();
  const pageSec = p.active ? currentPageElapsedSec() : 0;
  const pace = !p.active ? "" : pageSec > rec * 1.25 ? `<span class="badge warn">페이스 느림</span>` : pageSec < rec * 0.5 && pageSec > 5 ? `<span class="badge violet">페이스 빠름</span>` : `<span class="badge good">페이스 적정</span>`;
  const last = p.active && current >= total;
  return `
    <button class="btn outline circ" onclick="prevPracticePage()" ${current <= 1 || p.active ? "disabled" : ""} aria-label="이전 페이지">${icon("chevronLeft")}</button>
    <span class="count">${current} <span>/ ${total}</span></span>
    <button class="btn primary" onclick="nextPracticePage()" ${!p.active && current >= total ? "disabled" : ""}>${last ? "연습 종료" : "다음 페이지"} ${icon(last ? "stop" : "chevronRight")}</button>
    <span class="hint">${p.shortcuts ? "스페이스바로도 넘어갑니다" : "단축키 꺼짐"}</span>
    <div class="cur">이 페이지 <b>${formatClock(pageSec)}</b> / 권장 ${formatShortClock(rec)} ${pace}</div>`;
}
function practiceMicHtml() {
  const p = state.practice;
  if (!SpeechRecognition) return `<span class="icon-box red">${icon("alert")}</span><span class="sp">이 브라우저는 실시간 음성 인식을 지원하지 않습니다. Chrome 또는 Edge에서 연습해 주세요.</span>`;
  if (p.active) return `<span class="icon-box ${state.listening ? "green" : "orange"}">${icon("mic")}</span><span class="sp">${state.listening ? "마이크 입력 정상 · 조용한 곳에서 녹음하면 전사 정확도가 올라갑니다" : "음성 인식이 잠시 멈췄습니다. 말을 이어가면 다시 시작됩니다."}</span><span class="muted">${state.streamingTimeline.length}문장 전사됨</span>`;
  return `<span class="icon-box neutral">${icon("mic")}</span><span class="sp">연습 시작을 누르면 마이크 녹음과 실시간 전사가 함께 시작됩니다. 다음 페이지를 누를 때마다 체류시간과 음성 구간이 저장됩니다.</span>`;
}
function practiceTimerHtml() {
  const p = state.practice;
  const total = practicePageTotal();
  const target = state.targetMinutes * 60;
  const elapsed = practiceElapsedSec();
  const remain = target - elapsed;
  const recCum = p.currentPage * target / total;
  const diff = recCum - elapsed;
  const marks = Array.from({ length: total - 1 }, (_, i) => `<em style="left:${((i + 1) / total * 100).toFixed(1)}%"></em>`).join("");
  return `
    <div class="k"><span>${icon("clock", "sm")}발표 시간</span><span>목표 ${formatClock(target)}</span></div>
    <div class="clocks"><div><small>경과</small><b id="prTotal">${formatClock(elapsed)}</b></div><div><small>${remain >= 0 ? "남은 시간" : "초과"}</small><b id="prRemain" class="${remain < 0 ? "tone-bad" : ""}">${remain >= 0 ? formatClock(remain) : `+${formatClock(-remain)}`}</b></div></div>
    <div class="track"><i style="width:${Math.min(100, elapsed / target * 100).toFixed(1)}%"></i>${marks}</div>
    <p class="note">${p.active ? `페이지 ${p.currentPage}까지 권장 ${formatShortClock(recCum)} · 현재 ${formatShortClock(elapsed)} <b class="${diff < 0 ? "warn" : ""}">${diff >= 0 ? `${Math.round(diff)}초 여유` : `${Math.round(-diff)}초 초과`}</b>` : "연습 시작을 누르면 시간이 흐릅니다"}</p>`;
}
function dwellMap() {
  const map = {};
  for (const r of state.practice.records || []) map[r.page] = (map[r.page] || 0) + Number(r.duration || 0);
  return map;
}
function dwellRowsHtml() {
  const total = practicePageTotal();
  const p = state.practice;
  const map = dwellMap();
  const rec = recommendedPerPageSec();
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const live = p.active && n === p.currentPage;
    const sec = (map[n] || 0) + (live ? currentPageElapsedSec() : 0);
    const off = !sec && !live;
    const pct = Math.min(100, sec / (rec * 1.5) * 100);
    return `<div class="dwell-row ${live ? "is-on" : ""} ${off ? "off" : ""}"><span class="n">${n} ${html(state.practiceMaterial ? practicePageTitle(n) : "전체")}</span><div class="bar"><span><i class="${sec > rec * 1.25 ? "warn" : ""}" style="width:${pct.toFixed(1)}%"></i></span></div><span class="t">${sec ? formatShortClock(sec) : "—"}</span></div>`;
  }).join("");
}
function liveRowsHtml() {
  const items = (state.streamingTimeline || []).slice(-14);
  if (!items.length && !state.streamingInterim) return `<p class="live-tx-empty">${state.practice.active ? "말하면 문장 단위로 여기에 전사됩니다." : "연습을 시작하면 실시간 전사가 표시됩니다."}</p>`;
  const rows = items.map((item) => `<div class="r"><b>${formatShortClock(item.start)}</b><span>${html(item.text)}</span></div>`).join("");
  const interim = state.streamingInterim
    ? `<div class="r interim"><b>${formatShortClock(streamingElapsedSec())}</b><span><span class="dots"><i></i><i></i><i></i></span>${html(state.streamingInterim)}</span></div>`
    : state.listening ? `<div class="r interim"><b>${formatShortClock(streamingElapsedSec())}</b><span><span class="dots"><i></i><i></i><i></i></span>듣는 중</span></div>` : "";
  return rows + interim;
}
function liveFootHtml() {
  const p = state.practice;
  const all = state.streamingTimeline.length;
  const here = state.streamingTimeline.filter((item) => item.page === p.currentPage).length;
  return `<span>${all}문장${state.practiceMaterial ? ` · 페이지 ${p.currentPage} 구간 ${here}문장` : ""}</span><span>${state.recordedBlob ? "녹음 저장됨" : p.active ? "녹음 중" : "대기"}</span>`;
}
function updatePracticeLive() {
  const set = (id, value) => { const el = $(id); if (el) el.innerHTML = value; };
  set("prTimer", practiceTimerHtml());
  set("prDwell", dwellRowsHtml());
  set("prLive", liveRowsHtml());
  set("prLiveFoot", liveFootHtml());
  set("prNav", practiceNavHtml());
  set("prMic", practiceMicHtml());
  set("prBarRight", practiceBarRight());
  const live = $("prLive");
  if (live) live.scrollTop = live.scrollHeight;
  const p = state.practice;
  const map = dwellMap();
  const rec = recommendedPerPageSec();
  for (let n = 1; n <= practicePageTotal(); n += 1) {
    const el = $(`thumbTime-${n}`);
    if (!el) continue;
    const sec = (map[n] || 0) + (p.active && n === p.currentPage ? currentPageElapsedSec() : 0);
    el.textContent = sec ? formatShortClock(sec) : "—";
    el.className = sec > rec * 1.25 ? "warn" : "";
  }
}
function updatePracticeClocks() {
  const el = $("prTotal");
  if (el) el.textContent = formatClock(practiceElapsedSec());
}
function updatePracticeControls() {
  updatePracticeLive();
}

/* --- slide rendering (PDF via pdf.js, PPTX via extracted text) --- */
function renderMaterialPage(preview, page) {
  if (!state.practiceMaterial) {
    return `<div class="pptx none"><span class="icon-box xl">${icon("mic")}</span><h2>자료 없이 음성만 연습합니다</h2><p>연습 시작을 누르면 녹음과 전사가 시작되고, 종료하면 전사문과 시간 기록이 남습니다.</p></div>`;
  }
  const type = String(preview.type || "").toUpperCase();
  if (type === "PDF" && state.practiceObjectUrl) {
    if (window.pdfjsLib) {
      return `
        <div class="pdf-tools"><span>PDF ${page}페이지</span><span style="flex:1"></span>
          <button class="btn ghost xs" onclick="setPracticePdfZoom(-0.15)">${icon("minus", "sm")}축소</button>
          <span>${Math.round(state.practicePdfZoom * 100)}%</span>
          <button class="btn ghost xs" onclick="setPracticePdfZoom(0.15)">${icon("plus", "sm")}확대</button>
          <button class="btn ghost xs" onclick="resetPracticePdfZoom()">${icon("fit", "sm")}맞춤</button>
        </div>
        <div id="practicePdfShell" class="pdf-shell"><canvas id="practicePdfCanvas"></canvas></div>`;
    }
    return `<iframe class="pdf-frame" src="${state.practiceObjectUrl}#page=${page}&zoom=page-fit&toolbar=0&navpanes=0&scrollbar=0"></iframe>`;
  }
  const section = (preview.sections || []).find((item) => Number(item.page) === page) || {};
  return `
    <div class="pptx">
      <div class="k">SLIDE ${page}<span>${html(practiceTitle())}</span></div>
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
    const availableWidth = Math.max(420, shell.clientWidth - 32);
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
  } catch (err) {
    shell.innerHTML = `<iframe class="pdf-frame" src="${state.practiceObjectUrl}#page=${pageNumber}&zoom=page-fit&toolbar=0&navpanes=0&scrollbar=0"></iframe>`;
  }
}
let thumbJob = 0;
async function renderPracticeThumbs() {
  const job = ++thumbJob;
  try {
    const doc = await loadPracticePdfDocument();
    if (!doc) return;
    const total = Math.min(doc.numPages, 40);
    for (let n = 1; n <= total; n += 1) {
      if (job !== thumbJob) return;
      if (!state.practiceThumbs[n]) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 220 / base.width });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        state.practiceThumbs[n] = canvas.toDataURL("image/jpeg", 0.7);
      }
      const holder = $(`thumb-${n}`);
      if (holder && !holder.querySelector("img")) holder.innerHTML = `<img src="${state.practiceThumbs[n]}" alt="">`;
    }
  } catch (_) {
    /* thumbnails are decorative */
  }
}
function setPracticePdfZoom(delta) {
  state.practicePdfZoom = Math.max(0.7, Math.min(2.4, Number((state.practicePdfZoom + delta).toFixed(2))));
  state.practicePdfRenderKey = "";
  renderPractice();
}
function resetPracticePdfZoom() {
  state.practicePdfZoom = 1;
  state.practicePdfRenderKey = "";
  renderPractice();
}

/* --- practice flow --- */
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
function transcriptForRange(start, end) {
  return (state.streamingTimeline || [])
    .filter((item) => Number(item.end || 0) >= start && Number(item.start || 0) <= end)
    .map((item) => item.text)
    .join(" ")
    .trim();
}
async function startPractice() {
  const p = state.practice;
  if (p.active) return;
  if (state.practiceMaterial) await preparePracticePreview();
  clearStreaming(false);
  p.active = true;
  p.phase = "live";
  p.startedAtMs = nowMs();
  p.pageStartedAtMs = nowMs();
  p.currentPage = 1;
  p.records = [];
  p.totalSec = 0;
  p.finishedAt = null;
  if (p.tick) window.clearInterval(p.tick);
  p.tick = window.setInterval(() => {
    if (state.view === "app" && state.tab === "practice") updatePracticeLive();
  }, 1000);
  renderPracticeLive();
  await startStreaming({ renderAfterStart: false });
  updatePracticeLive();
}
function recordCurrentPracticePage() {
  const p = state.practice;
  if (!p.active || !p.pageStartedAtMs || !p.startedAtMs) return;
  const start = (p.pageStartedAtMs - p.startedAtMs) / 1000;
  const end = practiceElapsedSec();
  const duration = Math.max(0, end - start);
  if (duration < 0.3) return;
  p.records.push({ page: p.currentPage, start, end, duration, transcript: transcriptForRange(start, end) });
  p.pageStartedAtMs = nowMs();
}
function nextPracticePage() {
  const p = state.practice;
  const total = practicePageTotal();
  if (p.active) recordCurrentPracticePage();
  if (p.currentPage < total) {
    p.currentPage += 1;
    state.practicePdfRenderKey = "";
  } else if (p.active) {
    finishPractice();
    return;
  }
  if (p.active) {
    // keep the live screen; only swap the slide and refresh the side panels
    const slide = document.querySelector(".pr-slide");
    if (slide) {
      slide.innerHTML = `${renderMaterialPage(state.practicePreview || {}, p.currentPage)}<div class="pr-nav" id="prNav">${practiceNavHtml()}</div>`;
      if (isPracticePdf()) renderPracticePdfPage(p.currentPage);
    }
    document.querySelectorAll(".pr-thumb").forEach((el, i) => el.classList.toggle("is-on", i + 1 === p.currentPage));
    const thumb = document.querySelector(".pr-thumb.is-on");
    if (thumb) thumb.scrollIntoView({ block: "nearest" });
    updatePracticeLive();
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
  const p = state.practice;
  if (p.active) recordCurrentPracticePage();
  p.totalSec = practiceElapsedSec();
  p.active = false;
  p.phase = "summary";
  p.finishedAt = new Date().toISOString();
  p.startedAtMs = null;
  p.pageStartedAtMs = null;
  if (p.tick) window.clearInterval(p.tick);
  p.tick = 0;
  stopStreaming();
  toast("연습을 종료했습니다. 녹음과 페이지 기록을 저장했습니다.");
  renderPractice();
}
function resetPractice() {
  const p = state.practice;
  p.records = [];
  p.currentPage = 1;
  p.phase = "setup";
  p.totalSec = 0;
  p.finishedAt = null;
  state.showAllTranscript = false;
  clearStreaming(false);
  renderPractice();
}
document.addEventListener("keydown", (event) => {
  const p = state.practice;
  if (state.view !== "app" || state.tab !== "practice" || !p.active || !p.shortcuts) return;
  const tag = (event.target && event.target.tagName) || "";
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  if (event.code === "Space" || event.key === "ArrowRight") {
    event.preventDefault();
    nextPracticePage();
  }
});

/* --- summary after finishing --- */
function renderPracticeSummary() {
  const p = state.practice;
  const total = practicePageTotal();
  const target = state.targetMinutes * 60;
  const diff = target - p.totalSec;
  const timeline = state.streamingTimeline || [];
  const words = wordCount(practiceTranscript());
  const map = dwellMap();
  const rec = recommendedPerPageSec();
  const dwellRows = Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const sec = map[n] || 0;
    const d = sec - rec;
    const judge = !sec ? ["", "미발표"] : Math.abs(d) <= rec * 0.2 ? ["good", "적정"] : d > 0 ? ["bad", `길음 +${Math.round(d)}초`] : ["bad", `짧음 −${Math.round(-d)}초`];
    const tone = !sec ? "" : d > rec * 0.2 ? "warn" : d < -rec * 0.2 ? "warn" : "";
    return `<div class="r"><span class="thumb">${state.practiceThumbs[n] ? `<img src="${state.practiceThumbs[n]}" alt="" style="height:40px;width:auto;border-radius:6px">` : ""}</span><span class="n">${n} · ${html(state.practiceMaterial ? practicePageTitle(n) : "전체")}</span><div class="bar"><span><i class="${tone}" style="width:${Math.min(100, sec / (rec * 1.6) * 100).toFixed(1)}%"></i></span></div><span class="t ${tone ? "warn" : ""}">${sec ? formatShortClock(sec) : "—"}</span><span class="judge">${judge[0] ? badge(judge[1], judge[0]) : judge[1]}</span></div>`;
  }).join("");
  const long = Object.entries(map).filter(([, s]) => s > rec * 1.2).map(([n]) => n);
  const short = Object.entries(map).filter(([, s]) => s > 0 && s < rec * 0.8).map(([n]) => n);
  const suggestion = long.length || short.length
    ? `<b>다음 연습 제안</b> ${long.length ? `${long.join("·")}페이지에서 ${Math.round(long.reduce((s, n) => s + map[n] - rec, 0))}초를 줄이고` : ""}${long.length && short.length ? " " : ""}${short.length ? `${short.join("·")}페이지 설명에 ${Math.round(short.reduce((s, n) => s + rec - map[n], 0))}초를 더 쓰세요.` : long.length ? " 전체 길이를 맞추세요." : ""}`
    : `<b>시간 배분이 고릅니다.</b> 이대로 AI 심사를 시작해 내용 평가를 받아 보세요.`;
  const variance = Object.values(map).length > 1 ? Math.sqrt(Object.values(map).reduce((s, v) => s + (v - rec) ** 2, 0) / Object.values(map).length) / rec : 0;
  const shown = state.showAllTranscript ? timeline : timeline.slice(0, 3);
  $("view").innerHTML = pageHead({
    crumbs: ["AI 사전심사", "발표 연습"],
    title: "연습이 끝났습니다 🎉",
    sub: `${html(practiceTitle())} · ${formatDateTime(p.finishedAt)} · 녹음과 페이지 기록이 저장되었습니다.`,
    actions: `<button class="btn outline" onclick="downloadStreamingAudio()" ${state.recordedBlob ? "" : "disabled"}>${icon("download")}녹음 파일 저장</button><button class="btn outline" onclick="resetPractice()">${icon("refresh")}다시 연습하기</button>`,
    step: 2,
  }) + `
    <div class="page-body"><div class="container layout-side">
      <div class="stack-24">
        <section class="grid-3 ps-stats">
          <div class="card stat sm"><span class="stat-label">${icon("clock")}총 발표 시간</span><div class="stat-value">${formatClock(p.totalSec)}<small>/ ${formatClock(target)}</small></div><span class="tag">${badge(diff >= 0 ? `${Math.round(diff)}초 남김 · ${diff <= target * 0.15 ? "적정" : "짧음"}` : `${Math.round(-diff)}초 초과`, diff >= 0 && diff <= target * 0.15 ? "good" : "warn")}</span></div>
          <div class="card stat sm"><span class="stat-label">${icon("slides")}페이지</span><div class="stat-value">${Object.keys(map).length}<small>/${total}</small></div><span class="tag">${badge(variance > 0.35 ? "시간 배분 편차 큼" : variance > 0.15 ? "시간 배분 보통" : "시간 배분 고름", variance > 0.35 ? "warn" : "")}</span></div>
          <div class="card stat sm"><span class="stat-label">${icon("text")}전사 문장</span><div class="stat-value">${timeline.length}<small>문장 · ${words}어절</small></div><span class="tag">${badge(state.recordingSavedPath && state.recordingSavedPath !== "서버 저장 실패" ? "녹음 서버 저장 완료" : state.recordedBlob ? "녹음 완료" : "녹음 없음", "violet")}</span></div>
        </section>
        <section class="card">
          ${cardHead("페이지별 체류시간", "hourglass", `권장 페이지당 ${formatShortClock(rec)} · 막대는 권장 대비`)}
          <div class="dwell-table">${dwellRows}</div>
          <div style="margin-top:18px">${notice(suggestion)}</div>
        </section>
        <section class="card">
          ${cardHead("전사문 미리보기", "mic", timeline.length > 3 ? `<button class="btn link" onclick="state.showAllTranscript=!state.showAllTranscript;renderPractice()">${state.showAllTranscript ? "접기" : `전체 ${timeline.length}문장 보기`} ${icon("chevronRight", "sm")}</button>` : "")}
          ${shown.length ? `<div class="tx-list">${shown.map((item) => `<div class="tx-row compact"><span class="t">${formatShortClock(item.start)}</span><span>${html(item.text)}</span><span class="meta">${item.page ? `페이지 ${item.page}` : ""}</span></div>`).join("")}</div>` : `<p class="muted">전사된 문장이 없습니다. 마이크 권한과 브라우저(Chrome/Edge)를 확인해 주세요.</p>`}
        </section>
      </div>
      <aside class="stack">
        <section class="card violet ai-start">
          <span class="card-title" style="color:#fff;font-size:20px">${icon("listCheck")}AI 심사 시작</span>
          <p>투자 심사역·기술 전문가·산업 전문가 AI가 녹음과 페이지 기록으로 심사표와 예상 질문 10개를 만듭니다. 약 3분 걸립니다.</p>
          <div class="chips">${JUDGES.map((j) => `<span class="chip">${j}</span>`).join("")}</div>
          <button class="btn white lg wide" onclick="analyzePractice()" ${state.busy || !practiceTranscript().trim() ? "disabled" : ""}>${state.busy ? "분석 중..." : `분석 시작 ${icon("arrowRight")}`}</button>
          <small>${practiceTranscript().trim() ? "결과는 분석 결과 탭과 PDF 리포트로 받습니다" : "전사문이 없어 분석할 수 없습니다"}</small>
        </section>
        <section class="card">
          ${cardHead("저장된 항목", "listCheck")}
          <div class="check-list saved-list">
            <div class="check-row ${state.recordedBlob ? "" : "off"}"><span class="dot">${icon("check")}</span><div><b>발표 음성</b><small>${state.recordedBlob ? `${html(state.recordedAudioName)} · ${formatDuration(p.totalSec)}` : "녹음 파일 없음"}</small></div></div>
            <div class="check-row ${p.records.length ? "" : "off"}"><span class="dot">${icon("check")}</span><div><b>페이지 기록</b><small>${p.records.length ? `${Object.keys(map).length}페이지 체류시간 · 음성 구간 매칭` : "기록 없음"}</small></div></div>
            <div class="check-row ${timeline.length ? "" : "off"}"><span class="dot">${icon("check")}</span><div><b>전사문</b><small>${timeline.length ? `한국어 ${timeline.length}문장 · 번역은 실시간 번역 탭에서` : "전사문 없음"}</small></div></div>
          </div>
          <p class="muted" style="font-size:13px;margin-top:14px">다시 연습하면 이번 기록은 지워지고 새로 시작합니다. 분석 결과는 내 발표 목록에 남습니다.</p>
        </section>
      </aside>
    </div></div>`;
}

/* ==========================================================================
   RESULTS — 분석 결과 · 종합 결과 · 분석 실행 · PDF 리포트
   ========================================================================== */
function resultsHead(title, sub) {
  const a = state.analysis;
  const meta = state.analysisMeta || {};
  const tail = a ? ` · ${html(meta.audio || a.audio_name || "실시간 전사")} · ${formatDate(meta.date)}` : "";
  return pageHead({
    crumbs: ["AI 사전심사", title],
    title,
    sub: `${sub}${tail}`,
    actions: `<button class="btn outline" onclick="go('home')">${icon("arrowLeft")}홈으로</button><button class="btn primary" onclick="downloadReport()" ${a ? "" : "disabled"}>${icon("download")}리포트 다운로드</button>`,
    step: 3,
    tabs: RESULT_TABS,
  });
}
function noAnalysis(title, text) {
  return `<div class="page-body"><div class="container">${emptyState(title, text, "chart", `<div class="row" style="margin-top:8px"><button class="btn primary" onclick="go('app','dashboard')">발표 등록하러 가기</button><button class="btn outline" onclick="go('app','practice')">발표 연습 시작</button></div>`)}</div></div>`;
}
function gradeChip(a) {
  const tone = scoreOf(a.score) >= 75 ? "background:var(--primary);color:#fff" : scoreOf(a.score) >= 60 ? "background:var(--orange-bg);color:var(--orange)" : "background:var(--red-bg);color:var(--red)";
  return `<span class="grade" style="${tone}">${html(gradeOf(a))}</span>`;
}
function setResultsTab(tab) {
  state.resultsTab = tab;
  renderAnalysis();
}
function setSummaryTab(tab) {
  state.summaryTab = tab;
  renderSummary();
}
function lowestVoice(a) {
  const entries = Object.entries(displayVoiceScores(a));
  entries.sort((x, y) => x[1] - y[1]);
  return entries[0] || ["", 0];
}
function maxGap(a) {
  let best = null;
  for (const s of a.sentence_segments || []) {
    const g = Number(s.gap_before || 0);
    if (!best || g > best.gap) best = { gap: g, time: s.time };
  }
  return best;
}

/* ---------- 분석 결과 ---------- */
function renderAnalysis() {
  const a = state.analysis;
  if (!a) {
    $("view").innerHTML = resultsHead("분석 결과", "발화 속도, 추임새, 어휘, 자료 일치율을 정량 지표로 확인합니다.") + noAnalysis("아직 분석 결과가 없습니다", "발표 음성을 등록하거나 발표 연습을 마친 뒤 AI 심사를 시작하면 결과가 표시됩니다.");
    return;
  }
  const llmFailed = Boolean(a.llm_error);
  const wpm = Math.round(Number(a.wpm || 0));
  const fillers = Number(a.filler_total || 0);
  const match = a.document_match;
  const fw = (a.filler_words || []).slice(0, 3);
  const sentences = (a.sentence_segments || []).length;
  const low = lowestVoice(a);
  const inRange = wpm >= 120 && wpm <= 150;
  const markerLeft = Math.max(0, Math.min(100, (wpm - 60) / 140 * 100));
  const paceNote = wpm === 0 ? "발화 속도 정보 없음" : inRange ? "권장 120~150 안 · 안정적" : wpm < 120 ? `권장 120~150보다 느림 · ${120 - wpm} WPM 부족` : `권장 120~150보다 빠름 · ${wpm - 150} WPM 초과`;
  const fillerNote = !sentences ? "문장 정보 없음" : fillers >= sentences * 0.8 ? `${sentences}문장 중 거의 매 문장` : fillers >= sentences * 0.3 ? `${sentences}문장 중 세 문장에 한 번꼴` : `${sentences}문장 기준 적은 편`;
  const tabs = [
    ["summary", "요약", "핵심 지표와 진단 요약"],
    ["match", "자료 일치율", match?.available ? `발표자료 ${(match.sections || []).length}페이지 대비 음성 반영` : "발표자료 없음"],
    ["speech", "발화·어휘", `추임새 ${fillers}회 · 어휘 개선 ${llmFailed ? 0 : cleanVocabItems(a.vocab_suggestions || []).length}건`],
    ["transcript", "전사·구간", `${sentences}문장 · ${(a.slide_rows || []).length}개 구간`],
  ];
  const tab = tabs.find(([id]) => id === state.resultsTab) || tabs[0];
  $("view").innerHTML = resultsHead("분석 결과", "발화 속도, 추임새, 어휘, 자료 일치율을 정량 지표로 확인합니다.") + `
    <div class="page-body"><div class="container stack-24">
      ${llmFailed ? notice(`<b>AI 종합평가 실패</b> ${html(a.llm_error)} 아래 내용은 CLOVA 전사문과 Python 측정 지표만으로 표시된 결과입니다.`, "bad", "alert") : ""}
      <section class="card kpi">
        <div class="stat"><span class="stat-label">${icon("award")}종합 점수</span><div class="stat-value big">${llmFailed ? "–" : `${scoreOf(a.score)}<small>/100</small>${gradeChip(a)}`}</div><span class="stat-note">${llmFailed ? "AI 평가 실패" : `판정 <b>${html(asText(a.status, "") || scoreWord(a.score))}</b>${low[0] ? ` · ${html(low[0])}(${low[1]}점)이 가장 낮습니다` : ""}`}</span></div>
        <div class="stat"><span class="stat-label">${icon("activity")}평균 발화 속도</span><div class="stat-value">${wpm}<small>WPM</small></div><div class="range"><i style="left:42.9%;width:21.4%"></i><em class="${inRange ? "ok" : ""}" style="left:${markerLeft.toFixed(1)}%"></em></div><span class="stat-note ${inRange ? "tone-good" : "tone-warn"}">${paceNote}</span></div>
        <div class="stat"><span class="stat-label">${icon("volume")}추임새</span><div class="stat-value">${fillers}<small>회</small></div><div class="filler-chips">${fw.length ? fw.map((x) => `<span>${html(x.word)} ${html(x.count)}</span>`).join("") : `<span>감지된 단어 없음</span>`}</div><span class="stat-note ${fillers >= sentences * 0.3 && sentences ? "tone-bad" : ""}">${fillerNote}</span></div>
        <div class="stat"><span class="stat-label">${icon("file")}자료 일치율</span>${match?.available
          ? `<div class="ring-row">${ring(match.score, "sm")}<div class="stat-value">${scoreOf(match.score)}<small>%</small></div></div><span class="stat-note ${scoreOf(match.score) < 50 ? "tone-bad" : ""}">${(match.missing_terms || []).length ? `누락 키워드 ${(match.missing_terms || []).length}개` : "주요 키워드 반영됨"}${match.sections?.length ? ` · ${match.sections.length}페이지 비교` : ""}</span>`
          : `<div class="stat-value"><small style="font-size:18px">자료 없음</small></div><span class="stat-note">PPT/PDF를 함께 올리면 페이지별 반영률을 비교합니다</span>`}</div>
      </section>
      <div class="tabs-row"><div class="tabs">${tabs.map(([id, label]) => `<button class="${tab[0] === id ? "is-on" : ""}" onclick="setResultsTab('${id}')">${label}</button>`).join("")}</div><small>${tab[2]}</small></div>
      ${tab[0] === "summary" ? analysisSummaryHtml(a) : tab[0] === "match" ? analysisMatchHtml(a) : tab[0] === "speech" ? analysisSpeechHtml(a) : analysisTranscriptHtml(a)}
    </div></div>`;
  if (tab[0] === "summary") drawPaceChart(a.pace_series || [], a.wpm || 140);
}

function analysisSummaryHtml(a) {
  const llmFailed = Boolean(a.llm_error);
  const wpm = Math.round(Number(a.wpm || 0));
  const series = (a.pace_series || []).map((d) => Number(d.wpm || 0)).filter((v) => v > 0);
  const inBand = series.filter((v) => v >= 120 && v <= 150).length;
  const headline = series.length
    ? inBand === series.length ? `${series.length}개 구간 모두 권장 속도 안이었습니다` : inBand === 0 ? `${series.length}개 구간 모두 권장 속도 ${wpm < 120 ? "아래" : "밖"}였습니다` : `${series.length}개 구간 중 ${inBand}개가 권장 속도 안이었습니다`
    : wpm ? `평균 ${wpm} WPM, 권장 범위 ${wpm >= 120 && wpm <= 150 ? "안" : wpm < 120 ? "아래" : "위"}였습니다` : "발화 속도 정보가 없습니다";
  const slowest = series.length ? Math.min(...series) : 0;
  const fastest = series.length ? Math.max(...series) : 0;
  const top = (a.filler_words || [])[0];
  const fillers = Number(a.filler_total || 0);
  const match = a.document_match;
  const gap = maxGap(a);
  const problems = cleanProblems(a.problems || []);
  const diag = [
    { ic: "activity", tone: wpm >= 120 && wpm <= 150 ? "green" : "orange", k: "속도", t: wpm ? (wpm < 120 ? `권장 범위 아래, 평균 ${wpm} WPM` : wpm > 150 ? `권장보다 빠름, 평균 ${wpm} WPM` : `권장 범위 안, 평균 ${wpm} WPM`) : "발화 속도 정보 없음", link: ["speech", "발화·어휘 보기"] },
    { ic: "volume", tone: fillers > 20 ? "red" : fillers > 8 ? "orange" : "green", k: "추임새", t: top ? `'${asText(top.word)}' ${asText(top.count)}회 등 ${fillers}회` : fillers ? `추임새 ${fillers}회` : "추임새가 거의 없습니다", link: ["speech", "발화·어휘 보기"] },
    { ic: "file", tone: !match?.available ? "neutral" : scoreOf(match.score) < 50 ? "orange" : "green", k: "자료", t: match?.available ? `자료 반영률 ${scoreOf(match.document_coverage ?? match.score)}%, 자료 외 발화 ${scoreOf(match.speech_extra_ratio)}%` : "발표자료가 없어 비교하지 못했습니다", link: ["match", "자료 일치율 보기"] },
    { ic: "hourglass", tone: gap && gap.gap >= 5 ? "red" : gap && gap.gap >= 2.5 ? "orange" : "green", k: "침묵", t: gap ? `가장 긴 공백 ${Number(gap.gap).toFixed(1)}초 (${html(gap.time || "")})` : "문장 사이 공백 정보 없음", link: ["transcript", "전사·구간 보기"] },
  ];
  return `
    <div class="sec-head"><div><span class="k">01 · 발표 속도</span><h2>${headline}</h2><p>${series.length ? `구간별 분당 어절 수(WPM)입니다. 가장 느린 구간 ${slowest} WPM, 가장 빠른 구간 ${fastest} WPM.` : "구간별 발화 속도는 발표 연습 기록이나 문장 시각이 있을 때 표시됩니다."}</p></div></div>
    <div class="grid-2" style="grid-template-columns:2fr 1fr">
      <section class="card chart-card"><div class="legend"><span><i></i>구간별 WPM</span><span><i class="band"></i>권장 120–150</span><b>평균 ${wpm} WPM</b></div><canvas id="paceChart"></canvas></section>
      <section class="card">${cardHead("음성 품질 · 심사위원 AI 채점", "target")}${llmFailed ? `<p class="muted">AI 평가 실패로 음성 품질 점수를 제공할 수 없습니다.</p>` : `<div class="bars">${Object.entries(displayVoiceScores(a)).map(([k, v]) => bar(k, v)).join("")}</div>`}</section>
    </div>
    <div class="sec-head"><div><span class="k">02 · 핵심 진단</span><h2>점수를 깎은 네 가지</h2></div>${problems.length ? `<button class="btn outline" onclick="state.summaryTab='problems';go('app','summary')">종합 결과에서 문제점 ${problems.length}건 보기 ${icon("arrowRight")}</button>` : ""}</div>
    <div class="grid-4">${diag.map((d) => `<section class="card diag-card"><span class="icon-box ${d.tone}">${icon(d.ic)}</span><span class="k tone-${d.tone === "green" ? "good" : d.tone === "red" ? "bad" : d.tone === "orange" ? "warn" : "violet"}">${d.k}</span><h4>${d.t}</h4><button class="btn link" onclick="setResultsTab('${d.link[0]}')">${d.link[1]} ${icon("chevronRight", "sm")}</button></section>`).join("")}</div>
    <section class="next-band"><div><h3>다음은 종합 결과입니다</h3><p>${llmFailed ? "AI 평가가 실패해 문제점과 보완 사항은 제공되지 않습니다." : `문제점 ${problems.length}건과 보완 사항 ${cleanPriorities(a.improvement_priorities || []).length}건, AI 종합 의견을 확인한 뒤 예상 질문 ${cleanQuestions(a.questions || []).length}개로 답변을 연습하세요.`}</p></div><button class="btn primary lg" onclick="go('app','summary')">종합 결과 보기 ${icon("arrowRight")}</button></section>`;
}
function analysisMatchHtml(a, withHead = true) {
  const match = a.document_match;
  const meta = state.analysisMeta || {};
  if (!match?.available) {
    return `${withHead ? `<div class="sec-head"><div><span class="k">03 · 자료–음성 일치율</span><h2>발표자료가 없어 비교하지 못했습니다</h2><p>PPT/PDF를 함께 올리고 분석하면 자료 페이지와 음성 구간의 일치율, 누락 키워드를 비교합니다.</p></div></div>` : ""}<section class="card">${notice("<b>발표자료가 없습니다.</b> 발표자료 등록에서 PPT/PDF를 함께 올리고 다시 분석하세요.", "", "info")}</section>`;
  }
  const cov = scoreOf(match.document_coverage ?? match.score);
  const extra = scoreOf(match.speech_extra_ratio);
  const sections = match.sections || [];
  const pages = sections.length;
  const name = meta.material || a.document_name || "발표자료";
  const headline = cov >= 60 ? `발표자료 핵심어의 ${cov}%가 음성에 나왔습니다` : `발표자료 핵심어의 ${cov}%만 음성에 나왔습니다`;
  const sub = cov >= 60 ? `${name} · ${pages}페이지. 자료와 발표가 잘 맞습니다.` : `${name} · ${pages}페이지. 자료와 발표 원고의 용어가 다르거나, 다른 문서일 수 있습니다.`;
  const low = scoreOf(match.score) < 50;
  return `
    ${withHead ? `<div class="sec-head"><div><span class="k">03 · 자료–음성 일치율</span><h2>${headline}</h2><p>${html(sub)}</p></div></div>` : ""}
    <div class="match-grid">
      <section class="card match-donut">
        ${ring(match.score, `xl ${low ? "orange" : ""}`, `${scoreOf(match.score)}<small>%</small><em>자료 → 음성</em>`)}
        <div class="tiles c3 wide">
          <div class="tile center"><b>${cov}%</b><small>자료 반영률</small></div>
          <div class="tile center"><b class="${extra >= 50 ? "tone-warn" : ""}">${extra}%</b><small>자료 외 발화</small></div>
          <div class="tile center"><b>${pages}</b><small>페이지</small></div>
        </div>
      </section>
      <section class="card">
        <p class="card-meta" style="margin-bottom:14px">페이지별 일치율 · 누락 키워드</p>
        ${sections.length ? `<div class="page-match">${sections.map((row, i) => {
          const sc = scoreOf(row.score);
          const missing = Array.isArray(row.missing) ? row.missing.filter(Boolean) : [];
          return `<div class="pm-row"><b>${html(row.title || `Page ${row.page || i + 1}`)}</b><div class="bar"><span><i class="${sc < 50 ? "warn" : "good"}" style="width:${sc}%"></i></span></div><span class="pct">${sc}%</span><div class="kw-list">${missing.length ? missing.slice(0, 6).map((t) => `<span class="kw mini">${html(t)}</span>`).join("") : `<span class="kw mini none">누락 없음</span>`}</div></div>`;
        }).join("")}</div>` : `<p class="muted">페이지별 정보가 없습니다.</p>`}
      </section>
    </div>
    <div class="grid-2">
      <section class="card">${cardHead("자료에는 있지만 발표에서 약한 키워드", "file")}<p class="muted kw-lead">발표에서 이 단어들을 의도적으로 말해야 자료 반영률이 올라갑니다.</p>${keywordList(match.missing_terms, "outline")}</section>
      <section class="card">${cardHead("발표에는 있지만 자료에 약한 키워드", "mic")}<p class="muted kw-lead">대부분 구어체 연결어입니다. 핵심어가 섞여 있으면 자료에 추가하세요.</p>${keywordList(match.extra_terms, "outline")}</section>
    </div>`;
}
function analysisSpeechHtml(a) {
  const llmFailed = Boolean(a.llm_error);
  const items = (a.filler_words || []).map((x) => ({ word: asText(x.word), count: Number(x.count || 0), severity: asText(x.severity) })).filter((x) => x.word);
  items.sort((x, y) => y.count - x.count);
  const total = Number(a.filler_total || 0) || items.reduce((sum, x) => sum + x.count, 0);
  const top = items[0];
  const vocab = llmFailed ? [] : cleanVocabItems(a.vocab_suggestions || []);
  const pct = top && total ? Math.round(top.count / total * 100) : 0;
  const headline = total ? (top ? `추임새 ${total}회, '${top.word}' 하나가 전체의 ${pct}%` : `추임새 ${total}회`) : "추임새가 거의 없습니다";
  const sub = total ? "문장 시작 습관어가 대부분입니다. 2초 침묵으로 바꾸는 연습이 가장 효과적입니다." : "깨끗한 발화입니다. 어휘 개선 제안만 확인하세요.";
  const max = Math.max(1, ...items.map((x) => x.count));
  return `
    <div class="sec-head"><div><span class="k">04 · 추임새 · 어휘</span><h2>${html(headline)}</h2><p>${sub}</p></div></div>
    <div class="grid-2">
      <section class="card">
        <div class="card-head"><span class="card-meta">단어별 횟수 · ${items.length}종</span><span class="legend-mini"><i></i>높음<i class="lo"></i>보통</span></div>
        ${items.length ? `<div class="filler-list">${items.map((x) => {
          const hi = x.count >= 4 || /높음|high/i.test(x.severity);
          return `<div class="filler-row"><span class="word">“${html(x.word)}”</span><div class="bar"><span><i class="${hi ? "good" : "lo"}" style="width:${Math.round(x.count / max * 100)}%"></i></span></div><span class="count">${x.count}회</span></div>`;
        }).join("")}</div>` : "<p class='muted'>감지된 추임새 단어가 없습니다.</p>"}
      </section>
      <section class="card">
        <div class="card-head"><span class="card-meta">어휘 개선 제안 · ${vocab.length}건</span></div>
        ${llmFailed ? `<p class="muted">AI 평가 실패로 어휘 개선 제안을 제공할 수 없습니다.</p>` : vocab.length ? `<div class="vocab-list">${vocab.map((x) => `<div class="vocab"><s>${html(x.original || x.reason || "-")}</s><b>↳ ${html(x.replacement || x.reason || "-")}</b>${x.reason && x.replacement && x.reason !== x.original ? `<span class="why">${html(x.reason)}</span>` : ""}</div>`).join("")}</div>` : "<p class='muted'>감지된 어휘 개선 항목이 없습니다.</p>"}
      </section>
    </div>`;
}
function segLabel(text, i) {
  const t = String(text || "").replace(/^구간\s*\d+\s*[.·:]?\s*/, "").replace(/^Page\s*(\d+)$/i, "페이지 $1").trim();
  return t || `구간 ${i + 1}`;
}
function analysisTranscriptHtml(a) {
  const segs = a.sentence_segments || [];
  const speakers = Array.isArray(a.speaker_stats) ? a.speaker_stats : [];
  const rows = a.slide_rows || [];
  const totalSec = speakers.reduce((sum, x) => sum + Number(x.seconds || 0), 0) || Number(a.timing_seconds?.total || a.duration_seconds || 0);
  const headline = `${segs.length}문장${totalSec ? `, ${formatDuration(totalSec)} 발화` : ""}`;
  const sub = speakers.length <= 1 ? "화자가 한 명으로 인식되었습니다. 질의응답 녹음을 함께 올리면 화자별로 나뉩니다." : `화자 ${speakers.length}명으로 인식되었습니다.`;
  const shownSegs = state.showAllTimeline ? segs : segs.slice(0, 5);
  const shownRows = state.showAllSlides ? rows : rows.slice(0, 8);
  return `
    <div class="sec-head"><div><span class="k">05 · 전사 · 구간</span><h2>${headline}</h2><p>${sub}</p></div></div>
    ${speakers.length ? `<section class="card speakers">${speakers.map((sp) => { const name = cleanSpeaker(sp.speaker); return `<div class="sp-row"><span class="sp-name"><span class="avatar">${html(name.replace(/[^0-9]/g, "") || name.slice(0, 1))}</span>${html(name)}</span><div class="sp-stat"><b>${html(sp.sentences)}</b><small>문장</small></div><div class="sp-stat"><b>${html(sp.seconds)}<small>초</small></b><small>발화시간</small></div><div class="sp-stat"><b>${html(sp.wpm)}</b><small>WPM</small></div><div class="sp-stat"><b class="${Number(sp.fillers) >= 10 ? "tone-bad" : ""}">${html(sp.fillers)}<small>회</small></b><small>추임새</small></div></div>`; }).join("")}</section>` : ""}
    <section class="card">
      <div class="card-head"><span class="card-title">문장별 타임라인</span>${segs.length > 5 ? `<button class="btn link" onclick="state.showAllTimeline=!state.showAllTimeline;renderAnalysis()">${state.showAllTimeline ? "접기" : `전체 ${segs.length}문장 보기`} ${icon("chevronRight", "sm")}</button>` : ""}</div>
      ${segs.length ? `<div class="tl">${shownSegs.map((x) => {
        const gap = Number(x.gap_before || 0);
        const long = gap >= 2.5;
        return `<div class="tl-row ${long ? "flag" : ""}"><span class="t">${html(String(x.time || "").replace(/\s*-\s*/, " – "))}</span><span class="dot"></span><div><p>${html(x.text)}</p><small>${html(cleanSpeaker(x.speaker))} · 구간 ${html(x.section)} · 공백 ${html(formatGap(x.gap_before))}초${long ? " (긴 침묵)" : ""}</small></div></div>`;
      }).join("")}</div>` : "<p class='muted'>문장별 timestamp가 없습니다.</p>"}
    </section>
    <section class="card">
      <div class="card-head"><span class="card-title">구간별 분석 · ${rows.length}개</span><span class="card-meta">${a.practice_summary ? "발표 연습의 페이지 구간 기준" : "페이지 동기화 없이 녹음되어 문장 구간 기준"}</span></div>
      ${rows.length ? `<div class="seg-table"><div class="seg-row head"><span></span><span>구간</span><span>체류시간</span><span>발화속도</span><span>추임새</span><span>피드백</span></div>${shownRows.map((row, i) => {
        const wpm = numericWpm(row.wpm);
        const off = wpm > 0 && (wpm < 100 || wpm > 160);
        const fill = numericWpm(row.fillers);
        return `<div class="seg-row"><span class="n">${i + 1}</span><span class="txt" title="${html(row.slide)}">${html(segLabel(row.slide, i))}</span><span>${html(row.duration)}</span><span class="${off ? "tone-warn" : ""}" style="font-weight:700">${html(row.wpm)}</span><span class="${fill >= 5 ? "tone-bad" : ""}" style="font-weight:600">${html(row.fillers)}</span><span class="fb ${off ? "tone-warn" : ""}">${html(row.feedback)}</span></div>`;
      }).join("")}</div>${rows.length > 8 ? `<button class="btn outline wide" style="margin-top:14px" onclick="state.showAllSlides=!state.showAllSlides;renderAnalysis()">${state.showAllSlides ? "접기" : `나머지 ${rows.length - 8}개 구간 보기`} ${icon("chevronDown", "sm")}</button>` : ""}` : "<p class='muted'>구간별 분석이 없습니다. 발표 연습에서 슬라이드를 넘기며 녹음하면 페이지별로 표시됩니다.</p>"}
      ${a.practice_summary ? `<p class="muted" style="margin:18px 0 10px;font-size:13px">${html(a.practice_summary)}</p>${renderPracticeAnalysisTable(a.practice_segments || [])}` : ""}
    </section>`;
}
function renderPracticeAnalysisTable(rows) {
  if (!rows.length) return "";
  return `<div class="table-wrap"><table><thead><tr><th>페이지</th><th class="num">시작</th><th class="num">종료</th><th>체류시간</th><th>전사 구간</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${badge(`페이지 ${r.page}`, "violet")}</td><td class="num">${html(formatClock(r.start))}</td><td class="num">${html(formatClock(r.end))}</td><td>${html(formatDuration(r.duration))}</td><td>${html(r.transcript || "-")}</td></tr>`).join("")}</tbody></table></div>`;
}
function keywordList(list, variant = "") {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!items.length) return `<span class="kw ${variant} none">없음</span>`;
  return `<div class="kw-list">${items.map((t) => `<span class="kw ${variant}">${html(t)}</span>`).join("")}</div>`;
}
function renderDocumentMatch(match) {
  return `
    <div class="match-hero">
      ${ring(match.score, "", `${scoreOf(match.score)}<small>%</small>`)}
      <div><div class="match-flow">${icon("file")}발표자료 ${icon("arrowRight")} 발표 음성 ${icon("mic")}</div><p>${html(match.summary || "")}</p></div>
    </div>
    <div class="tiles c3" style="margin-top:20px">
      <div class="tile"><b>${html(match.document_coverage)}%</b><small>자료 반영률</small></div>
      <div class="tile"><b>${html(match.speech_extra_ratio)}%</b><small>자료 외 발화 추정</small></div>
      <div class="tile"><b>${html(match.sections?.length || 0)}</b><small>페이지/슬라이드</small></div>
    </div>
    <div class="keyword-duo" style="margin-top:20px">
      <div><b>자료에는 있지만 발표에서 약한 키워드</b>${keywordList(match.missing_terms)}</div>
      <div><b>발표에는 있지만 자료에 약한 키워드</b>${keywordList(match.extra_terms)}</div>
    </div>
    ${renderDocumentSections(match.sections || [])}`;
}
function renderDocumentSections(rows) {
  if (!rows.length) return "";
  return `<div class="table-wrap" style="margin-top:20px"><table><thead><tr><th>자료 구간</th><th class="num">일치율</th><th>상태</th><th>누락 키워드</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${html(r.title || r.page)}</td><td class="num"><b>${html(r.score)}%</b></td><td>${badge(r.status) || "-"}</td><td>${(r.missing || []).map(html).join(", ") || "<span class='muted'>없음</span>"}</td></tr>`).join("")}</tbody></table></div>`;
}
function renderFillers(items) {
  if (!items.length) return "<p class='muted'>감지된 추임새 단어가 없습니다.</p>";
  const max = Math.max(1, ...items.map((x) => Number(x.count || 0)));
  return items.map((x) => `<div class="filler-row"><span class="word">“${html(x.word)}”</span>${badge(x.severity) || "<span></span>"}<div class="bar"><span><i class="${toneOf(x.severity) || "good"}" style="width:${Math.round(Number(x.count || 0) / max * 100)}%"></i></span></div><span class="count">${html(x.count)}회</span></div>`).join("");
}
function renderVocab(items) {
  const rows = cleanVocabItems(items);
  if (!rows.length) return "<p class='muted'>감지된 어휘 개선 항목이 없습니다.</p>";
  return `<div class="vocab-list">${rows.map((x) => {
    const body = x.replacement
      ? `<p class="pair"><b>${html(x.original || "-")}</b>${icon("arrowRight", "sm")}<em>${html(x.replacement)}</em></p>`
      : `<p class="pair"><em>${html(x.original || x.reason || "-")}</em></p>`;
    return `<div class="vocab"><small>개선 표현</small>${body}${x.reason && x.reason !== x.original ? `<span class="why">${html(x.reason)}</span>` : ""}</div>`;
  }).join("")}</div>`;
}
function renderSpeakers(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "<p class='muted'>화자 분리 정보가 없습니다.</p>";
  return `<div class="table-wrap"><table><thead><tr><th>화자</th><th class="num">문장</th><th class="num">발화시간</th><th class="num">WPM</th><th class="num">추임새</th></tr></thead><tbody>${rows.map((s) => `<tr><td><span class="speaker"><span class="icon-box round" style="width:28px;height:28px">${icon("user", "sm")}</span>${html(cleanSpeaker(s.speaker))}</span></td><td class="num">${html(s.sentences)}</td><td class="num">${html(s.seconds)}초</td><td class="num">${html(s.wpm)}</td><td class="num">${html(s.fillers)}회</td></tr>`).join("")}</tbody></table></div>`;
}
function formatGap(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  return number < 1 ? number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") : number.toFixed(1).replace(/\.0$/, "");
}
function shortTime(value) {
  const first = String(value || "").split(/[-–~]/)[0].trim();
  const m = first.match(/^(\d+):(\d+):(\d+)/) || first.match(/^(\d+):(\d+)/);
  if (!m) return first.slice(0, 8);
  if (m.length === 4) {
    const h = Number(m[1]);
    return `${h ? `${h}:` : ""}${h ? m[2] : String(Number(m[2]))}:${m[3]}`;
  }
  return `${Number(m[1])}:${m[2]}`;
}
function renderTimeline(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "<p class='muted'>문장별 timestamp가 없습니다.</p>";
  return `<div class="timeline-list tx-list">${rows.map((x) => {
    const gap = Number(x.gap_before || 0);
    return `<div class="tx-row compact ${gap >= 2.5 ? "flag" : ""}"><span class="t" title="${html(x.time)}">${html(shortTime(x.time))}</span><span>${html(x.text)}</span><span class="meta">${html(cleanSpeaker(x.speaker))} · 구간 ${html(x.section)} · 공백 ${html(formatGap(x.gap_before))}초</span></div>`;
  }).join("")}</div>`;
}
function renderSlideRows(rows) {
  if (!rows.length) return "<p class='muted'>구간별 분석이 없습니다. 발표 연습에서 슬라이드를 넘기며 녹음하면 페이지별로 표시됩니다.</p>";
  return `<div class="table-wrap"><table><thead><tr><th>슬라이드</th><th class="num">체류시간</th><th class="num">권장</th><th class="num">발화속도</th><th class="num">추임새</th><th>피드백</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${badge(r.slide, "violet")}</td><td class="num">${html(r.duration)}</td><td class="num">${html(r.recommended)}</td><td class="num">${html(r.wpm)}</td><td class="num">${html(r.fillers)}</td><td>${html(r.feedback)}</td></tr>`).join("")}</tbody></table></div>`;
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
  const pad = { l: 44, r: 16, t: 20, b: 36 };
  const data = (series.length ? series : [{ time: "0:00", wpm: fallbackWpm }]).map((d, i) => ({ time: String(d.time || `${i}:00`), wpm: Number(d.wpm || fallbackWpm || 0) }));
  const values = data.map((d) => d.wpm).filter(Number.isFinite);
  const min = 0;
  const max = Math.max(160, Math.ceil((Math.max(...values, 150) + 20) / 20) * 20);
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const xFor = (i) => pad.l + (i / Math.max(1, data.length - 1)) * plotW;
  const yFor = (v) => pad.t + (1 - (v - min) / Math.max(1, max - min)) * plotH;
  const font = "12px Pretendard, 'Pretendard Variable', -apple-system, sans-serif";
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#fef4e6";
  ctx.fillRect(pad.l, yFor(150), plotW, Math.max(1, yFor(120) - yFor(150)));
  ctx.fillStyle = "#d17600";
  ctx.font = `600 ${font}`;
  ctx.textAlign = "left";
  ctx.fillText("권장 120–150 WPM", pad.l + 10, yFor(150) + 16);
  const step = max > 200 ? 50 : 40;
  ctx.font = font;
  for (let t = min; t <= max; t += step) {
    const y = yFor(t);
    ctx.strokeStyle = "rgba(112,115,124,0.14)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(55,56,60,0.61)";
    ctx.textAlign = "right";
    ctx.fillText(String(t), pad.l - 10, y + 4);
  }
  if (data.length > 1) {
    ctx.beginPath();
    data.forEach((d, i) => (i ? ctx.lineTo(xFor(i), yFor(d.wpm)) : ctx.moveTo(xFor(i), yFor(d.wpm))));
    ctx.lineTo(xFor(data.length - 1), yFor(min));
    ctx.lineTo(xFor(0), yFor(min));
    ctx.closePath();
    ctx.fillStyle = "rgba(101,65,242,0.1)";
    ctx.fill();
  }
  ctx.strokeStyle = "#6541f2";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.beginPath();
  data.forEach((d, i) => (i ? ctx.lineTo(xFor(i), yFor(d.wpm)) : ctx.moveTo(xFor(i), yFor(d.wpm))));
  ctx.stroke();
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  ctx.font = font;
  data.forEach((d, i) => {
    const x = xFor(i);
    const y = yFor(d.wpm);
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#6541f2";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
    if (i % labelEvery === 0 || i === data.length - 1) {
      ctx.fillStyle = "rgba(55,56,60,0.61)";
      ctx.textAlign = "center";
      ctx.fillText(d.time.split("-")[0], x, h - 12);
    }
  });
}
window.addEventListener("resize", () => {
  if (state.view === "app" && state.tab === "analysis" && state.analysis && $("paceChart")) {
    drawPaceChart(state.analysis.pace_series || [], state.analysis.wpm || 140);
  }
});

/* ---------- 종합 결과 ---------- */
function renderSummary() {
  const a = state.analysis;
  if (!a) {
    $("view").innerHTML = resultsHead("종합 결과", "문제점과 보완 사항, AI 종합 의견을 한눈에 봅니다.") + noAnalysis("종합 결과가 아직 없습니다", "분석을 완료하면 문제점, 보완 사항, AI 종합 의견이 여기에 정리됩니다.");
    return;
  }
  const llmFailed = Boolean(a.llm_error);
  const problems = cleanProblems(a.problems || []);
  const priorities = cleanPriorities(a.improvement_priorities || []);
  const qs = cleanQuestions(a.questions || []);
  const summary = asText(a.summary, "").trim();
  const sentences = summary.split(/(?<=[.!?다])\s+/).filter(Boolean);
  const op = sentences.slice(0, 2).join(" ");
  const op2 = sentences.slice(2).join(" ");
  const match = a.document_match;
  const pages = (match?.sections || []).length;
  const tabs = [
    ["problems", `문제점 <span class="count">${problems.length}</span>`, "영향이 큰 순서"],
    ["priorities", `보완 사항 <span class="count">${priorities.length}</span>`, "다음 연습 순서"],
    ["match", "자료 매칭", match?.available ? `발표자료 ${pages}페이지 기준` : "발표자료 없음"],
    ["questions", `예상 질문 <span class="count">${qs.length}</span>`, "질문마다 90초 답변 연습"],
  ];
  const tab = state.summaryTab;
  const tabNote = (tabs.find(([id]) => id === tab) || tabs[0])[2];
  let body = "";
  if (tab === "problems") {
    body = `<div class="sec-head"><div><span class="k">01 · 발견된 문제점</span><h2>${problems.length ? `${problems.length}가지가 점수를 깎았습니다` : "발견된 문제점이 없습니다"}</h2><p>시간 순서가 아니라 영향이 큰 순서입니다. 각 항목의 근거는 분석 결과에서 확인할 수 있습니다.</p></div></div>
      ${llmFailed ? `<section class="card">${notice("AI 평가 실패로 문제점을 제공할 수 없습니다.", "warn", "alert")}</section>` : problems.length ? `<div class="grid-3">${problems.map((p, i) => `<section class="card issue-card"><div class="top"><span>${String(i + 1).padStart(2, "0")}</span>${p.level && p.level !== "확인" ? badge(p.level, "bad") : ""}</div><h4>${html(p.title || p.fix)}</h4>${p.title && p.fix ? `<p>${html(p.fix)}</p>` : ""}</section>`).join("")}</div>` : `<section class="card">${notice("문제점으로 지적된 항목이 없습니다.", "ok", "circleCheck")}</section>`}`;
  } else if (tab === "priorities") {
    body = `<div class="sec-head"><div><span class="k">02 · 보완 사항</span><h2>${priorities.length ? "다음 연습에서 이 순서로 고치세요" : "보완 사항이 없습니다"}</h2></div></div>
      ${llmFailed ? `<section class="card">${notice("AI 평가 실패로 보완 사항을 제공할 수 없습니다.", "warn", "alert")}</section>` : priorities.length ? `<section class="card prio-card">${priorities.map((p, i) => `<div class="prio-row"><b>${String(i + 1).padStart(2, "0")}</b><p>${html(p.title || p.detail)}${p.impact ? ` ${badge(p.impact, "warn")}` : ""}${p.title && p.detail ? `<small>${html(p.detail)}</small>` : ""}</p></div>`).join("")}</section>` : `<section class="card">${notice("보완 사항이 없습니다. 문제점 탭과 분석 결과의 진단을 참고해 다음 연습을 준비하세요.", "ok", "circleCheck")}</section>`}`;
  } else if (tab === "match") {
    if (!match?.available) {
      body = `<div class="sec-head"><div><span class="k">03 · 자료 간 매칭</span><h2>발표자료가 없어 비교하지 못했습니다</h2></div></div><section class="card">${notice("<b>발표자료가 없습니다.</b> 발표자료 등록에서 PPT/PDF를 함께 올리고 다시 분석하세요.", "", "info")}</section>`;
    } else {
      const cov = scoreOf(match.document_coverage ?? match.score);
      const extra = scoreOf(match.speech_extra_ratio);
      const weak = (match.sections || []).filter((row) => scoreOf(row.score) < 50).length;
      const terms = (match.missing_terms || []).filter(Boolean).slice(0, 4);
      const advice = cov < 60
        ? `${terms.length ? `자료의 '${terms.join("·")}' 같은 용어가 발표에 거의 나오지 않았습니다. ` : ""}자료와 원고를 같은 용어로 맞추세요.`
        : "자료 핵심어가 발표에 충분히 반영됐습니다. 누락 키워드는 분석 결과에서 확인하세요.";
      body = `<div class="sec-head"><div><span class="k">03 · 자료 간 매칭</span><h2>${cov >= 60 ? `발표자료 핵심어의 ${cov}%가 음성에 나왔습니다` : `발표자료 핵심어의 ${cov}%만 음성에 나왔습니다`}</h2></div><button class="btn link" onclick="state.resultsTab='match';go('app','analysis')">페이지별 상세는 분석 결과에서 ${icon("chevronRight", "sm")}</button></div>
        <section class="card sum-match">
          ${ring(match.score, `md ${scoreOf(match.score) < 50 ? "orange" : ""}`, `${scoreOf(match.score)}<small>%</small>`)}
          <div class="st"><b>${cov}%</b><small>자료 반영률</small></div>
          <div class="st"><b class="${extra >= 50 ? "tone-warn" : ""}">${extra}%</b><small>자료 외 발화 추정</small></div>
          <div class="st"><b>${weak}<small>/${pages}</small></b><small>누락 가능 페이지</small></div>
          <span class="vline"></span>
          <p>${html(advice)}</p>
        </section>`;
    }
  } else {
    body = `<div class="sec-head"><div><span class="k">04 · AI 예상 심사위원 질문</span><h2>${qs.length ? `이 발표를 들은 심사위원이 던질 ${qs.length === 10 ? "열 가지" : `${qs.length}가지`}` : "예상 질문이 없습니다"}</h2><p>수치의 출처, 기술 기여, 법적 관계, 실적 검증을 묻습니다. 질문마다 90초 답변을 연습할 수 있습니다.</p></div><button class="btn primary" onclick="state.qaOpen=0;go('app','questions')" ${qs.length ? "" : "disabled"}>답변 연습 시작 ${icon("arrowRight")}</button></div>
      ${qs.length ? `<div class="qgrid">${qs.map((q, i) => `<button class="qcard" onclick="state.qaOpen=${i};go('app','questions')"><span class="n">${i + 1}</span><span>${html(q.question)}</span></button>`).join("")}</div>` : `<section class="card">${notice(llmFailed ? "AI 평가 실패로 예상 질문을 생성하지 못했습니다." : "예상 질문이 생성되지 않았습니다.", "warn", "alert")}</section>`}`;
  }
  $("view").innerHTML = resultsHead("종합 결과", "문제점과 보완 사항, AI 종합 의견을 한눈에 봅니다.") + `
    <div class="page-body"><div class="container stack-24">
      <section class="sum-hero">
        <div class="left">
          ${ring(llmFailed ? 0 : a.score, "lg on-dark orange", llmFailed ? `–` : `${html(gradeOf(a))}<small>${scoreOf(a.score)} / 100 · ${html(asText(a.status, "") || scoreWord(a.score))}</small>`)}
          <div class="cnt"><div><b>${problems.length}<small>건</small></b><small>문제점</small></div><div><b>${priorities.length}<small>건</small></b><small>보완 사항</small></div><div><b>${qs.length}<small>개</small></b><small>예상 질문</small></div></div>
        </div>
        <div>
          <span class="k">${icon("sparkle", "sm")}AI 종합 의견</span>
          ${llmFailed ? `<p class="op">AI 종합 의견을 만들지 못했습니다.</p><p class="failed">${html(a.llm_error)} 전사문과 측정 지표는 분석 결과 탭에서 확인할 수 있습니다.</p>` : `<p class="op">${html(op || "종합 의견이 없습니다.")}</p>${op2 ? `<p class="op2">${html(op2)}</p>` : ""}`}
          <div class="acts"><button class="btn primary lg" onclick="go('app','questions')" ${qs.length ? "" : "disabled"}>예상 질문 ${qs.length}개 보기 ${icon("arrowRight")}</button><button class="btn on-dark lg" onclick="downloadReport()">${icon("download")}PDF 리포트</button></div>
        </div>
      </section>
      <div class="tabs-row"><div class="tabs">${tabs.map(([id, label]) => `<button class="${tab === id ? "is-on" : ""}" onclick="setSummaryTab('${id}')">${label}</button>`).join("")}</div><small>${tabNote}</small></div>
      ${body}
    </div></div>`;
}

/* ---------- practice metrics merged into the analysis ---------- */
function practiceSlideRows() {
  return (state.practice.records || []).map((record) => {
    const words = (record.transcript || "").split(/\s+/).filter(Boolean).length;
    const wpm = record.duration > 0 ? Math.round(words / record.duration * 60) : 0;
    const fillerCount = ((record.transcript || "").match(/\b(어|아|음|그|이제|일단|뭐)\b/g) || []).length;
    return {
      slide: `Page ${record.page}`,
      duration: `약 ${Math.round(record.duration)}초`,
      recommended: `${Math.round(recommendedPerPageSec())}초`,
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
    return { time: `${formatClock(start)}-${formatClock(cursor)}`, wpm, seconds, words: Math.round(wpm * seconds / 60) };
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

/* ---------- analysis loading modal ---------- */
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
  el.className = "overlay";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="modal">
      <div class="spinner"></div>
      <h2>분석 중입니다</h2>
      <p class="meta">${html(meta)}</p>
      <ol class="steps-list">${ANALYZE_STEPS.map(([t, d], i) => `<li class="${i === 0 ? "active" : ""}"><i>${i + 1}</i><div><b>${t}</b><small>${d}</small></div><em>${i === 0 ? "진행 중" : "대기"}</em></li>`).join("")}</ol>
      <div class="progress"><i id="analyzeBar"></i></div>
      <p class="foot"><b id="analyzeClock">00:00</b> 경과 · 9분 발표 기준 약 1분, 발표 길이에 따라 달라집니다</p>
      <p class="foot" style="font-size:13px">창을 닫지 말고 기다려 주세요 · 끝나면 분석 결과 탭으로 이동합니다</p>
    </div>`;
  document.body.appendChild(el);
  const t0 = Date.now();
  const stepAt = window.ANALYZE_STEP_SECONDS || [10, 16];
  analyzeTimer = setInterval(() => {
    const s = (Date.now() - t0) / 1000;
    const clock = $("analyzeClock");
    if (clock) clock.textContent = formatClock(s);
    const bar = $("analyzeBar");
    if (bar) bar.style.width = `${Math.min(95, 100 * (1 - Math.exp(-s / 45))).toFixed(1)}%`;
    const idx = s >= stepAt[1] ? 2 : s >= stepAt[0] ? 1 : 0;
    el.querySelectorAll(".steps-list li").forEach((li, i) => {
      li.className = i < idx ? "done" : i === idx ? "active" : "";
      const em = li.querySelector("em");
      const ic = li.querySelector("i");
      if (em) em.textContent = i < idx ? "완료" : i === idx ? "진행 중" : "대기";
      if (ic) ic.innerHTML = i < idx ? icon("check") : String(i + 1);
    });
  }, 250);
}
function hideAnalyzeOverlay() {
  if (analyzeTimer) { clearInterval(analyzeTimer); analyzeTimer = null; }
  const el = $("analyzeOverlay");
  if (el) el.remove();
}

/* ---------- run the analysis ---------- */
function requireLogin() {
  if (state.user) return true;
  state.pending = { view: "app", tab: state.tab };
  state.view = "login";
  toast("로그인 후 이용할 수 있습니다.");
  render();
  return false;
}
async function finishAnalysis(analysis, meta) {
  if (state.practice.records.length) applyPracticeMetrics(analysis);
  state.analysis = analysis;
  state.analysisMeta = { ...meta, date: new Date().toISOString() };
  state.qaAnswers = {};
  state.qaResults = {};
  state.qaInfo = {};
  state.qaRedo = {};
  state.qaModel = {};
  state.qaOpen = 0;
  state.resultsTab = "summary";
  state.summaryTab = "problems";
  const entry = await historyAdd(analysis, meta);
  if (entry) state.analysisMeta.historyId = entry.id;
  if (state.practice.phase === "summary") state.practice.phase = "done";
  state.registerOpen = false;
}
async function analyzePresentation() {
  const transcript = state.streamingTranscript.trim();
  if (!state.selectedFile && !transcript) {
    toast("발표 음성 파일을 선택하거나 발표 연습으로 전사문을 만드세요.", "bad");
    return;
  }
  if (!requireLogin()) return;
  state.busy = true;
  renderApp();
  showAnalyzeOverlay(`${state.selectedFile ? state.selectedFile.name : "실시간 전사문"}${state.selectedMaterial ? " + " + state.selectedMaterial.name : ""}`);
  try {
    const form = new FormData();
    if (state.selectedFile) form.append("audio", state.selectedFile);
    if (state.selectedMaterial) form.append("material", state.selectedMaterial);
    if (transcript) form.append("streaming_transcript", transcript);
    if (state.streamingTimeline.length) form.append("streaming_timeline", JSON.stringify(state.streamingTimeline));
    const res = await apiFetch("/api/analyze", { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "분석 실패");
    await finishAnalysis(data.analysis || {}, { title: state.title.trim() || (state.selectedFile ? state.selectedFile.name.replace(/\.[^.]+$/, "") : "실시간 전사 분석"), audio: state.selectedFile ? state.selectedFile.name : "", material: state.selectedMaterial ? state.selectedMaterial.name : "" });
    state.tab = "analysis";
    toast("분석이 끝났습니다.");
  } catch (err) {
    toast(userErrorMessage(err, "분석을 완료하지 못했습니다. 입력 파일과 전사문을 확인해 주세요."), "bad");
  } finally {
    state.busy = false;
    hideAnalyzeOverlay();
    if (state.view === "app") render();
  }
}
async function analyzePractice() {
  const transcript = practiceTranscript();
  if (!transcript) {
    toast("발표 연습 전사문이 없습니다. 연습 시작 후 말한 내용이 전사되어야 합니다.", "bad");
    return;
  }
  if (!requireLogin()) return;
  state.busy = true;
  renderApp();
  showAnalyzeOverlay(`발표 연습 전사문${state.practiceMaterial ? " + " + state.practiceMaterial.name : ""}`);
  try {
    const form = new FormData();
    if (state.practiceMaterial) form.append("material", state.practiceMaterial);
    form.append("streaming_transcript", transcript);
    form.append("streaming_timeline", JSON.stringify(state.streamingTimeline));
    const res = await apiFetch("/api/analyze", { method: "POST", body: form });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "분석 실패");
    await finishAnalysis(data.analysis || {}, { title: practiceTitle(), audio: state.recordedAudioName || "실시간 녹음", material: state.practiceMaterial ? state.practiceMaterial.name : "" });
    state.tab = "analysis";
    toast("분석이 끝났습니다.");
  } catch (err) {
    toast(userErrorMessage(err, "분석을 완료하지 못했습니다. 전사문을 확인해 주세요."), "bad");
  } finally {
    state.busy = false;
    hideAnalyzeOverlay();
    if (state.view === "app") render();
  }
}
async function downloadReport() {
  if (!ready()) {
    toast("먼저 발표를 분석해 주세요.", "bad");
    return;
  }
  try {
    const res = await apiFetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysis: state.analysis }),
    });
    if (!res.ok) throw new Error("리포트 생성에 실패했습니다.");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(state.analysisMeta?.title || "presentation-review").replace(/[\\/:*?"<>|]+/g, "_")}-report.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    toast(userErrorMessage(err, "리포트 생성에 실패했습니다."), "bad");
  }
}

/* ==========================================================================
   QUESTIONS — 예상 질문 · 답변(음성/텍스트) · AI 답변 평가
   ========================================================================== */
const ANSWER_LIMIT_SEC = 90;
const CRITERIA = ["논리성", "구체성", "자신감", "시간 관리"];
const CRITERIA_KEYS = { "논리성": "logic", "구체성": "specificity", "자신감": "confidence", "시간 관리": "time_control" };
const QA_COUNTS = [5, 10, 15];
const QA_FILLER_RE = /(^|\s)(어|아|음|그|이제|일단|뭐)(?=\s|,|\.|$)/g;

function questions() {
  return cleanQuestions(state.analysis?.questions || []);
}
function qaCountOptions(total) {
  // the smallest option that still covers every question stays enabled; bigger ones are pointless
  const cover = QA_COUNTS.find((n) => n >= total) || QA_COUNTS[QA_COUNTS.length - 1];
  return QA_COUNTS.map((n) => ({ n, disabled: total > 0 && n > total && n !== cover }));
}
function setQaMode(mode) {
  if (state.qaListening) stopAnswerVoice();
  state.qaMode = mode;
  state.qaModeChosen = true;
  renderQuestions();
}
function setQaSrc(src) {
  state.qaSrc = src;
  renderQuestions();
}
function setQaCount(n) {
  state.qaCount = Number(n);
  if (state.qaOpen >= state.qaCount) state.qaOpen = -1;
  renderQuestions();
}
function toggleQuestion(i) {
  if (state.qaListening) stopAnswerVoice();
  state.qaOpen = state.qaOpen === i ? -1 : i;
  if (state.qaOpen === i) state.qaOpenMs = nowMs();
  renderQuestions();
}
function setQaFilter(f) {
  state.qaFilter = f;
  renderQuestions();
}
function redoAnswer(i) {
  state.qaRedo[i] = true;
  state.qaOpen = i;
  state.qaOpenMs = nowMs();
  renderQuestions();
}
function backToEval(i) {
  delete state.qaRedo[i];
  renderQuestions();
}
function toggleModelAnswer(i) {
  state.qaModel[i] = !state.qaModel[i];
  renderQuestions();
}
function criteriaScore(r, key) {
  if (!r) return 0;
  const en = CRITERIA_KEYS[key] || key;
  const v = r[key] ?? r[en] ?? r.criteria?.[key] ?? r.criteria?.[en] ?? r.scores?.[key] ?? r.scores?.[en];
  if (v === undefined || v === null) return Math.round(scoreOf(r.score) / 4);
  const n = Number(v);
  return n > 25 ? Math.round(n / 4) : Math.round(n);
}
function formatDateShortTime(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) return String(value || "");
  return `${formatDateShort(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function formatBytes(n) {
  const b = Number(n || 0);
  if (!b) return "";
  return b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`;
}
function sentenceList(items) {
  return (Array.isArray(items) ? items : []).map((x) => asText(x).trim()).filter(Boolean).map((s) => (/[.!?다요]$/.test(s) ? s : `${s}.`)).join(" ");
}

/* ---------- source card: which deck the questions came from ---------- */
function qaMaterialFile(file) {
  // a new deck goes through the register card: questions are rebuilt by analysing voice + deck together
  applyMaterialFile(file);
  state.registerOpen = true;
  toast(`${file.name} 자료를 등록했습니다. 발표 음성을 올리고 분석하면 예상 질문이 새로 만들어집니다.`);
  go("app", "dashboard");
}
function handleQaMaterialSelected(input) {
  const file = input.files && input.files.length ? input.files[0] : null;
  if (!file) return;
  if (!matchesDropType(file, MATERIAL_DROP_EXTENSIONS)) {
    toast("PPTX 또는 PDF 발표자료를 올려 주세요.", "bad");
    return;
  }
  qaMaterialFile(file);
}
function handleQaMaterialDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove("drag-over");
  const file = droppedFile(event);
  if (!file) return;
  if (!matchesDropType(file, MATERIAL_DROP_EXTENSIONS)) {
    toast("PPTX 또는 PDF 발표자료를 올려 주세요.", "bad");
    return;
  }
  qaMaterialFile(file);
}
function pickQaMaterial(event) {
  event.preventDefault();
  const input = event.currentTarget.parentElement.querySelector("input[type=file]");
  if (input) input.click();
}
function regenerateQuestions() {
  state.registerOpen = true;
  toast("발표 음성과 자료를 다시 올려 분석하면 예상 질문이 새로 만들어집니다.");
  go("app", "dashboard");
}
function qaSourceCard(a, meta, total) {
  const pick = state.qaSrc === "pick";
  const seg = `<span class="segmented sm"><button class="${pick ? "" : "is-on"}" onclick="setQaSrc('upload')">PPT/PDF 올리기</button><button class="${pick ? "is-on" : ""}" onclick="setQaSrc('pick')">등록한 발표에서 선택</button></span>`;
  const fileInput = `<input type="file" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onchange="handleQaMaterialSelected(this)" aria-label="발표자료 파일">`;
  const dzAttrs = `ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handleQaMaterialDrop(event)"`;
  let left = "";
  if (pick) {
    const items = state.history.slice(0, 5);
    left = `<div class="qsrc-list">${items.length ? items.map((h) => {
      const cur = h.id === meta.historyId;
      const qn = h.questions === undefined ? null : Number(h.questions || 0);
      const right = qn === null ? "불러오기" : !qn ? "질문 없음" : h.qa_done ? `질문 ${qn}개 · 답변 ${h.qa_done}/${qn}` : cur ? `질문 ${qn}개 생성됨` : `질문 ${qn}개`;
      return `<button class="qsrc-pick ${cur ? "is-on" : ""}" onclick="historyOpen('${html(h.id)}','questions')"><span class="icon-box">${icon("slides")}</span><span class="t"><b>${html(h.material || h.audio || h.title)}</b><small>${formatDateShort(h.date)}${h.pages ? ` · ${h.pages}페이지` : ""} · ${html(h.title)}</small></span><span class="r ${qn === 0 ? "none" : ""}">${right}</span></button>`;
    }).join("") : `<div class="qsrc-pick"><span class="icon-box neutral">${icon("slides")}</span><span class="t"><b>등록한 발표가 없습니다</b><small>발표 연습에서 음성과 자료를 올리고 분석하면 여기에 나타납니다</small></span></div>`}</div>`;
  } else if (a) {
    const pages = a.document_match?.sections?.length || 0;
    const hasMat = Boolean(meta.material || a.document_match?.available);
    const name = meta.material || meta.audio || a.audio_name || "실시간 전사";
    const sentences = (a.sentence_segments || []).length;
    const facts = [pages ? `${pages}페이지` : "", formatBytes(meta.materialSize), sentences ? `${sentences}문장 전사` : "", hasMat ? "" : "음성만으로 생성"].filter(Boolean);
    left = `<label class="qsrc-dz" ${dzAttrs}>${fileInput}<span class="icon-box lg">${icon(hasMat ? "file" : "mic")}</span><span class="info"><span class="name"><b>${html(name)}</b>${badge(hasMat ? "업로드 완료" : "분석 완료", "good xs")}</span><small>${facts.concat("다른 파일을 끌어다 놓으면 교체됩니다").join(" · ")}</small></span><span class="btn sm outline" role="button" tabindex="0" onclick="pickQaMaterial(event)">파일 교체</span></label>`;
  } else {
    left = `<label class="qsrc-dz" ${dzAttrs}>${fileInput}<span class="icon-box lg">${icon("upload")}</span><span class="info"><span class="name"><b>PPT/PDF를 끌어다 놓거나 클릭해 선택</b></span><small>발표 등록 화면으로 이동합니다 · 음성과 함께 분석하면 예상 질문 10개가 만들어집니다</small></span></label>`;
  }
  const counts = `<span class="segmented sm">${qaCountOptions(total).map(({ n, disabled }) => `<button class="${state.qaCount === n ? "is-on" : ""}" onclick="setQaCount(${n})" ${disabled ? "disabled" : ""}>${n}</button>`).join("")}</span>`;
  return `
    <section class="card qsrc">
      <div class="head"><span class="t">${icon("file")}질문을 만들 발표자료</span>${seg}</div>
      <div class="body">
        ${left}
        <div class="qsrc-opts">
          <div class="row"><span>질문 수</span>${counts}</div>
          <div class="col"><span>심사위원</span><div class="judges">${JUDGES.map((j) => `<span class="chip xs" aria-pressed="true">${j.replace(" AI", "")}</span>`).join("")}</div></div>
        </div>
      </div>
      <div class="foot"><span>${icon("circleCheck", "sm")}${a ? `질문 ${total}개 생성됨 · ${formatDateShortTime(meta.date)} · 자료를 바꾸면 다시 만듭니다` : "아직 만든 질문이 없습니다 · 발표를 분석하면 10개가 만들어집니다"}</span><button class="btn outline violet" onclick="regenerateQuestions()">${icon("sparkle")}질문 다시 만들기</button></div>
    </section>`;
}

/* ---------- page ---------- */
function renderQuestions() {
  if (!state.historyLoaded && state.user) {
    loadHistory().then(() => { if (state.view === "app" && state.tab === "questions") renderQuestions(); });
  }
  if (state.qaMode === "voice" && !SpeechRecognition && !state.qaModeChosen) state.qaMode = "text";
  const a = state.analysis;
  const all = a ? questions() : [];
  const list = all.slice(0, state.qaCount || all.length);
  const meta = state.analysisMeta || {};
  const results = state.qaResults;
  const doneKeys = Object.keys(results).filter((k) => all[Number(k)]);
  const done = doneKeys.length;
  const avg = done ? Math.round(doneKeys.reduce((s, k) => s + scoreOf(results[k].score), 0) / done) : 0;
  const crit = CRITERIA.map((k) => [k, done ? Math.round(doneKeys.reduce((s, key) => s + criteriaScore(results[key], k), 0) / done) : 0]);
  const idxs = list.map((_, i) => i).filter((i) => state.qaFilter === "all" || (state.qaFilter === "done" ? results[i] : !results[i]));
  const listDone = list.filter((_, i) => results[i]).length;
  const head = pageHead({
    crumbs: ["예상 질문"],
    title: "예상 질문",
    sub: "발표자료를 올리면 AI 심사위원이 예상 질문을 만듭니다. 질문마다 음성이나 텍스트로 답하고 평가를 받으세요.",
    actions: `<button class="btn outline" onclick="downloadReport()" ${a ? "" : "disabled"}>${icon("download")}질문 PDF 저장</button>`,
    plain: true,
  });
  const items = idxs.map((i) => {
    const q = list[i];
    const r = results[i];
    const open = state.qaOpen === i;
    const showEval = r && !state.qaRedo[i];
    return `
      <div class="q-item ${open ? "open" : ""}" id="q-${i}">
        <button class="q-head" onclick="toggleQuestion(${i})" aria-expanded="${open}">
          <span class="n ${r ? "done" : ""}">${i + 1}</span>
          <span class="qt">${html(q.question)}</span>
          <span class="r">${r ? `<span class="pill good">답변 ${scoreOf(r.score)}점</span>` : `<span class="pill">미답변</span>`}${icon("chevronDown", "chev")}</span>
        </button>
        ${open ? `<div class="q-body">${showEval ? evalBox(i, r) : answerBox(i, r)}</div>` : ""}
      </div>`;
  }).join("");
  const listHtml = a
    ? `<div class="qa-filters"><div class="l"><h3>예상 질문 ${list.length}개</h3><span class="segmented sm">${[["all", `전체 ${list.length}`], ["todo", `미답변 ${list.length - listDone}`], ["done", `답변 완료 ${listDone}`]].map(([f, l]) => `<button class="${state.qaFilter === f ? "is-on" : ""}" onclick="setQaFilter('${f}')">${l}</button>`).join("")}</span></div><small>질문을 누르면 답변 칸이 열립니다 · 권장 답변 ${ANSWER_LIMIT_SEC}초</small></div>
       <div class="q-list">${items || `<div class="card table-empty">${list.length ? "해당하는 질문이 없습니다." : "AI 평가 실패로 예상 질문이 만들어지지 않았습니다. 발표를 다시 분석해 주세요."}</div>`}</div>`
    : `<div class="q-list">${emptyState("예상 질문이 아직 없습니다", "발표를 분석하면 투자 심사역·기술 전문가·산업 전문가 AI가 예상 질문 10개를 만듭니다.", "message", `<div class="row" style="margin-top:8px"><button class="btn primary" onclick="go('app','dashboard')">발표 등록하러 가기</button></div>`)}</div>`;
  const others = state.history.filter((h) => h.id !== meta.historyId).slice(0, 3);
  const sets = others.map((h) => {
    const qn = h.questions === undefined ? null : Number(h.questions || 0);
    const doneN = Number(h.qa_done || 0);
    return `<button class="set" onclick="historyOpen('${html(h.id)}','questions')"><span class="t"><b>${html(h.title)}</b><small>${formatDateShort(h.date)}${qn === null ? "" : ` · 질문 ${qn}개 · 답변 ${doneN}/${qn}`}</small></span><strong class="${doneN ? "" : "none"}">${doneN ? Number(h.qa_avg || 0) : "–"}</strong></button>`;
  }).join("");
  $("view").innerHTML = head + `
    <div class="page-body"><div class="container layout-side qa-layout">
      <div class="qa-main">
        ${qaSourceCard(a, meta, all.length)}
        ${listHtml}
      </div>
      <aside class="qa-side">
        <section class="qa-dark">
          <div class="t">${icon("target")}답변 연습 현황</div>
          <div class="tiles"><div class="tile"><b>${done}<span>/${all.length || 10}</span></b><small>완료한 질문</small></div><div class="tile"><b class="v">${done ? avg : "–"}</b><small>현재 평균 점수</small></div></div>
          <div class="bars">${crit.map(([k, v]) => `<div class="qa-bar"><p><span>${k}</span><strong>${v}<span>/25</span></strong></p><span class="track"><i class="${done && v < 20 ? "low" : ""}" style="width:${v / 25 * 100}%"></i></span></div>`).join("")}</div>
          <div class="note">${all.length || 10}개를 모두 답하면 Q&amp;A 대응 점수에 반영됩니다.</div>
        </section>
        <section class="qa-sets">
          <div class="h"><span class="t">${icon("history")}이전 질문 세트</span><span class="c">${others.length}개</span></div>
          ${sets ? `<div class="list">${sets}</div>` : `<p class="empty">다른 발표를 분석하면 그 질문 세트가 여기에 쌓입니다.</p>`}
          <button class="btn link" onclick="go('app','dashboard')">모든 질문 세트 보기 ${icon("chevronRight", "sm")}</button>
        </section>
        <div class="qa-tip">${icon("bulb")}<div><strong>팁</strong> 숫자를 말할 때는 출처 · 기준 연도 · 단위를 한 문장에 넣으세요. 구체성 점수가 가장 많이 오릅니다.</div></div>
      </aside>
    </div></div>`;
  if (state.qaOpen >= 0 && state.qaOpen < list.length) {
    const el = $(`q-${state.qaOpen}`);
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

function remainText(sec) {
  const s = Math.floor(sec);
  return s > ANSWER_LIMIT_SEC ? `권장 시간 초과 · ${s}초` : `${s}초 · ${Math.max(0, ANSWER_LIMIT_SEC - s)}초 남음`;
}
function answerBox(i, r) {
  const voice = state.qaMode === "voice";
  const answer = state.qaAnswers[i] || "";
  const live = state.qaListening && state.qaOpen === i;
  const sec = live ? (nowMs() - state.qaStartMs) / 1000 : 0;
  const voiceUi = `
    <div class="qa-voice ${live ? "live" : ""}">
      <div class="mic">
        <button class="micbtn" onclick="toggleAnswerVoice(${i})" aria-label="${live ? "녹음 중지" : "녹음 시작"}" ${SpeechRecognition ? "" : "disabled"}>${icon(live ? "stop" : "mic")}</button>
        <b id="qaClock">${formatClock(sec)}</b>
        <small id="qaHint">${live ? "녹음 중 · 다시 누르면 정지" : SpeechRecognition ? `마이크를 누르고 ${ANSWER_LIMIT_SEC}초 안에 답하세요` : "이 브라우저는 음성 인식을 지원하지 않습니다"}</small>
      </div>
      <div class="side">
        <div class="k"><b>권장 답변 시간 ${ANSWER_LIMIT_SEC}초</b><span id="qaState" class="${live ? (sec > ANSWER_LIMIT_SEC ? "over" : "on") : ""}">${live ? remainText(sec) : "대기"}</span></div>
        <span class="track"><i id="qaTrack" style="width:${Math.min(100, sec / ANSWER_LIMIT_SEC * 100)}%"></i></span>
        ${live
          ? `<div class="qa-live"><span id="qaLiveText">${html(answer)}</span><span class="dots"><i></i><i></i><i></i></span></div>`
          : `<textarea id="answerText" class="qa-ta" placeholder="녹음을 시작하면 말한 내용이 여기에 실시간으로 전사됩니다." oninput="state.qaAnswers[${i}]=this.value">${html(answer)}</textarea>`}
        <div class="stats"><span>${icon("activity", "sm")}<span id="qaWpm">발화 속도 –</span></span><span>${icon("message", "sm")}<span id="qaFill">추임새 –</span></span></div>
      </div>
    </div>`;
  const textUi = `<div class="qa-text"><textarea id="answerText" rows="5" placeholder="질문에 대한 답변을 입력하세요. 수치는 출처와 단위를 함께 쓰면 구체성 점수가 올라갑니다." oninput="state.qaAnswers[${i}]=this.value">${html(answer)}</textarea></div>`;
  return `
    <div class="qa-answer">
      <div class="head"><b>내 답변</b><span class="segmented sm"><button class="${voice ? "is-on" : ""}" onclick="setQaMode('voice')">음성으로 답변</button><button class="${voice ? "" : "is-on"}" onclick="setQaMode('text')">텍스트로 답변</button></span></div>
      ${voice ? voiceUi : textUi}
      <div class="foot"><span>평가 기준: ${CRITERIA.join(" · ")}, 각 25점</span><div class="btns">${r ? `<button class="btn outline" onclick="backToEval(${i})">평가 결과 보기</button>` : `<button class="btn outline" onclick="skipQuestion(${i})">건너뛰기</button>`}<button class="btn primary" id="evalBtn" onclick="evaluateAnswer(${i})">${icon("sparkle")}답변 평가하기</button></div></div>
    </div>`;
}
function evalBox(i, r) {
  const info = state.qaInfo[i] || {};
  const sub = ["/100", info.seconds ? formatDuration(info.seconds) : "", info.mode === "voice" ? "음성" : info.mode === "text" ? "텍스트" : ""].filter(Boolean).join(" · ");
  const strengths = sentenceList(r.strengths);
  const improvements = sentenceList(r.improvements);
  const model = asText(r.model_answer).trim();
  return `
    <div class="qa-eval">
      <div class="score"><span>답변 평가</span><b>${scoreOf(r.score)}</b><small>${sub}</small></div>
      <div class="detail">
        <div class="crit">${CRITERIA.map((k) => { const v = criteriaScore(r, k); const low = v < 20; return `<div><p><span>${k}</span><strong class="${low ? "low" : ""}">${v}</strong></p><span class="track"><i class="${low ? "low" : ""}" style="width:${v / 25 * 100}%"></i></span></div>`; }).join("")}</div>
        <div class="fb">${strengths || improvements ? `${strengths ? `<p><strong>AI 피드백</strong> ${html(strengths)}</p>` : ""}${improvements ? `<p><strong>개선점</strong> ${html(improvements)}</p>` : ""}` : `<p><strong>AI 피드백</strong> 세부 피드백이 제공되지 않았습니다.</p>`}</div>
        ${state.qaModel[i] && model ? `<div class="fb model"><p><strong>모범 답변 예시</strong> ${html(model)}</p></div>` : ""}
        <div class="btns"><button class="btn sm outline" onclick="toggleModelAnswer(${i})" ${model ? "" : "disabled"}>${icon("text", "sm")}${state.qaModel[i] ? "모범 답변 닫기" : "모범 답변 보기"}</button><button class="btn sm outline" onclick="redoAnswer(${i})">${icon("refresh", "sm")}다시 답변</button></div>
      </div>
    </div>`;
}
function skipQuestion(i) {
  if (state.qaListening) stopAnswerVoice();
  const list = questions().slice(0, state.qaCount || undefined);
  state.qaOpen = i + 1 < list.length ? i + 1 : -1;
  state.qaOpenMs = nowMs();
  renderQuestions();
}

/* --- voice answer: a second SpeechRecognition fills the transcript box --- */
function toggleAnswerVoice(i) {
  if (state.qaListening) {
    stopAnswerVoice();
    return;
  }
  if (!SpeechRecognition) {
    toast("이 브라우저는 실시간 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.", "bad");
    return;
  }
  const rec = new SpeechRecognition();
  rec.lang = "ko-KR";
  rec.continuous = true;
  rec.interimResults = true;
  let base = (state.qaAnswers[i] || "").trim();
  rec.onresult = (event) => {
    let interim = "";
    for (let k = event.resultIndex; k < event.results.length; k += 1) {
      const text = event.results[k][0].transcript.trim();
      if (event.results[k].isFinal && text) base = `${base} ${text}`.trim();
      else interim += text;
    }
    state.qaAnswers[i] = `${base} ${interim}`.trim();
    updateAnswerLive();
  };
  rec.onerror = () => { stopAnswerVoice(); toast("음성 인식 오류가 발생했습니다. 마이크 권한을 확인해 주세요.", "bad"); };
  rec.onend = () => { if (state.qaListening) stopAnswerVoice(); };
  state.qaRec = rec;
  state.qaListening = true;
  state.qaStartMs = nowMs();
  state.qaOpen = i;
  try { rec.start(); } catch (_) { /* already started */ }
  state.qaTimer = window.setInterval(() => {
    updateAnswerLive();
    if ((nowMs() - state.qaStartMs) / 1000 >= ANSWER_LIMIT_SEC + 30) stopAnswerVoice();
  }, 500);
  renderQuestions();
}
function stopAnswerVoice() {
  if (state.qaTimer) window.clearInterval(state.qaTimer);
  state.qaTimer = 0;
  const rec = state.qaRec;
  state.qaRec = null;
  if (state.qaListening) state.qaElapsed = Math.round((nowMs() - state.qaStartMs) / 1000);
  state.qaListening = false;
  if (rec) { rec.onend = null; try { rec.stop(); } catch (_) { /* ignore */ } }
  if (state.view === "app" && state.tab === "questions") renderQuestions();
}
function updateAnswerLive() {
  const i = state.qaOpen;
  const text = state.qaAnswers[i] || "";
  const ta = $("answerText");
  if (ta && document.activeElement !== ta) ta.value = text;
  const liveText = $("qaLiveText");
  if (liveText) liveText.textContent = text;
  const sec = state.qaListening ? (nowMs() - state.qaStartMs) / 1000 : 0;
  const clock = $("qaClock");
  if (clock) clock.textContent = formatClock(sec);
  const track = $("qaTrack");
  if (track) track.style.width = `${Math.min(100, sec / ANSWER_LIMIT_SEC * 100)}%`;
  const st = $("qaState");
  if (st) { st.textContent = state.qaListening ? remainText(sec) : "대기"; st.className = state.qaListening ? (sec > ANSWER_LIMIT_SEC ? "over" : "on") : ""; }
  const words = wordCount(text);
  const wpm = sec > 3 ? Math.round(words / sec * 60) : 0;
  const fillers = text.match(QA_FILLER_RE) || [];
  const counts = {};
  fillers.forEach((m) => { const w = m.trim(); counts[w] = (counts[w] || 0) + 1; });
  const top = Object.keys(counts).sort((x, y) => counts[y] - counts[x])[0];
  const w = $("qaWpm");
  if (w) w.textContent = wpm ? `현재 ${wpm} WPM` : "발화 속도 –";
  const f = $("qaFill");
  if (f) f.textContent = words ? `추임새 ${fillers.length}회${top ? ` ('${top}')` : ""}` : "추임새 –";
}

/* --- answer practice progress is kept with the analysis record on the server --- */
function saveQaProgress() {
  const id = state.analysisMeta?.historyId;
  if (!id || !state.user) return;
  if (state.qaSaveTimer) window.clearTimeout(state.qaSaveTimer);
  state.qaSaveTimer = window.setTimeout(async () => {
    state.qaSaveTimer = 0;
    try {
      const res = await apiFetch(`/api/history/${encodeURIComponent(id)}/qa`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qa: { answers: state.qaAnswers, results: state.qaResults, info: state.qaInfo } }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.ok && data.item) {
        const item = normalizeHistoryItem(data.item);
        state.history = state.history.map((h) => (h.id === item.id ? item : h));
      }
    } catch (_) { /* progress stays in memory for this session */ }
  }, 600);
}

async function evaluateAnswer(i) {
  if (!ready()) {
    toast("먼저 발표를 분석해 주세요.", "bad");
    return;
  }
  const mode = state.qaMode === "voice" ? "voice" : "text";
  if (state.qaListening) stopAnswerVoice();
  const ta = $("answerText");
  const answer = (ta ? ta.value : state.qaAnswers[i] || "").trim();
  if (!answer) {
    toast("답변을 입력하거나 말해 주세요.", "bad");
    return;
  }
  if (!requireLogin()) return;
  state.qaAnswers[i] = answer;
  const seconds = mode === "voice" ? state.qaElapsed : Math.round((nowMs() - (state.qaOpenMs || nowMs())) / 1000);
  const btn = $("evalBtn");
  if (btn) { btn.disabled = true; btn.textContent = "평가 중..."; }
  try {
    const res = await apiFetch("/api/evaluate-answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: questions()[i], answer, transcript: state.analysis.transcript || "" }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "답변 평가 실패");
    state.qaResults[i] = data.result || {};
    state.qaInfo[i] = { seconds: Math.max(0, seconds || 0), mode };
    delete state.qaRedo[i];
    state.qaModel[i] = false;
    toast(`답변 평가 완료 · ${scoreOf(state.qaResults[i].score)}점`);
    saveQaProgress();
    renderQuestions();
  } catch (err) {
    toast(userErrorMessage(err, "답변 평가를 완료하지 못했습니다."), "bad");
    const b = $("evalBtn");
    if (b) { b.disabled = false; b.innerHTML = `${icon("sparkle")}답변 평가하기`; }
  }
}

/* ==========================================================================
   STREAMING STT · RECORDING · TRANSLATE
   ========================================================================== */
const TARGET_LANGS = [
  ["en", "영어"], ["ja", "일본어"], ["zh", "중국어 간체"], ["es", "스페인어"],
  ["fr", "프랑스어"], ["de", "독일어"], ["vi", "베트남어"], ["id", "인도네시아어"],
];
function langName(code = state.targetLang) {
  return (TARGET_LANGS.find(([v]) => v === code) || ["", code])[1];
}
function langSelect() {
  return `<label class="inline-label">${icon("globe")}번역 언어
    <select class="select sm" style="width:150px" onchange="setTargetLang(this.value)">
      ${TARGET_LANGS.map(([value, label]) => `<option value="${value}" ${state.targetLang === value ? "selected" : ""}>${label}</option>`).join("")}
    </select></label>`;
}
function statusPill(status, listening = false) {
  if (listening) return `<span class="pill live">전사 중</span>`;
  const text = String(status || "대기");
  const cls = text === "완료" ? "done" : text === "오류" ? "error" : text === "번역 중" ? "busy" : "";
  return `<span class="pill ${cls}">${html(text)}</span>`;
}

function createRecognition() {
  if (!SpeechRecognition) {
    toast("이 브라우저는 실시간 음성 인식을 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.", "bad");
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
    if (event && event.error === "no-speech") {
      // Chrome ends recognition after silence; the practice keeps running and we simply restart
      if (state.practice.active) { try { recognition.start(); } catch (_) { /* ignore */ } }
      return;
    }
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive" && !state.practice.active) state.mediaRecorder.stop();
    toast("실시간 음성 인식 오류가 발생했습니다. 브라우저 권한과 마이크 상태를 확인해 주세요.", "bad");
    renderCurrent();
  };
  recognition.onend = () => {
    state.listening = false;
    state.streamingInterim = "";
    if (state.practice.active) {
      // keep listening for the whole practice; the browser stops after silences
      try { recognition.start(); } catch (_) { /* ignore */ }
      return;
    }
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
  return `practice-${stamp}.${ext}`;
}
async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast("이 브라우저는 마이크 녹음을 지원하지 않습니다. Chrome 또는 Edge를 사용하세요.", "bad");
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
    const res = await fetch("/api/save-recording", { method: "POST", body: form, credentials: "same-origin" });
    const data = await res.json();
    state.recordingSavedPath = data.ok ? data.path || "" : "서버 저장 실패";
  } catch (err) {
    state.recordingSavedPath = "서버 저장 실패";
  }
}
function downloadStreamingAudio() {
  if (!state.recordedBlob || !state.recordedAudioUrl) {
    toast("저장할 녹음 파일이 없습니다.", "bad");
    return;
  }
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
    toast(userErrorMessage(err, "실시간 STT/녹음을 시작하지 못했습니다. 브라우저 권한을 확인해 주세요."), "bad");
  }
  if (options.renderAfterStart !== false) renderCurrent();
}
function stopStreaming() {
  if (state.recognition) {
    state.recognition.onend = () => {
      state.listening = false;
      state.streamingInterim = "";
      if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
      state.recognition = null;
      renderCurrent();
    };
    if (state.listening) {
      try { state.recognition.stop(); } catch (_) { /* ignore */ }
    } else {
      state.recognition = null;
    }
  }
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") state.mediaRecorder.stop();
  state.listening = false;
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
  return translateUploadText();
}
async function translateUploadText() {
  const text = uploadTranslationSourceText();
  if (!text) {
    toast("번역할 한국어 전사문이 없습니다.", "bad");
    return;
  }
  if (!requireLogin()) return;
  state.uploadTranslationStatus = "번역 중";
  renderApp();
  try {
    const res = await apiFetch("/api/translate", {
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
  renderApp();
}
function clearUploadTranslation() {
  state.uploadTranslationText = "";
  state.uploadTranslation = "";
  state.uploadTranslationStatus = "대기";
  clearStreaming(false);
  renderApp();
}
async function startUploadStt() {
  if (state.practice.active) {
    toast("발표 연습이 진행 중입니다. 연습을 먼저 종료해 주세요.", "bad");
    return;
  }
  clearStreaming(false);
  await startStreaming({ record: false });
  renderApp();
}
function copyTranslation() {
  if (!state.uploadTranslation) return;
  navigator.clipboard?.writeText(state.uploadTranslation).then(() => toast("번역 결과를 복사했습니다.")).catch(() => toast("복사하지 못했습니다.", "bad"));
}
function saveTranslationText() {
  if (!state.uploadTranslation) return;
  const blob = new Blob([`[한국어 전사문]\n${uploadTranslationSourceText()}\n\n[${langName()} 번역]\n${state.uploadTranslation}\n`], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `translation-${state.targetLang}-${formatDate()}.txt`;
  link.click();
  URL.revokeObjectURL(url);
}
let trTick = 0;
function renderTranslate() {
  const timeline = state.streamingTimeline || [];
  const sourceText = uploadTranslationSourceText();
  const listening = state.listening;
  if (listening && !trTick) trTick = window.setInterval(() => { const el = $("trClock"); if (el) el.textContent = formatClock(streamingElapsedSec()); if (!state.listening) { clearInterval(trTick); trTick = 0; } }, 500);
  $("view").innerHTML = pageHead({
    crumbs: ["도구", "실시간 번역"],
    title: "실시간 번역",
    sub: "마이크로 말하면 한국어로 전사되고, 선택한 언어로 바로 번역됩니다. 녹음 파일 저장과 발표 구간 분석은 발표 연습에서 하세요.",
    actions: `<button class="btn outline" onclick="go('home')">${icon("arrowLeft")}홈으로</button>`,
    plain: true,
  }) + `
    <div class="page-body"><div class="container stack-24">
      <section class="card tr-toolbar">
        <div class="row">
          <button class="btn primary" onclick="startUploadStt()" ${listening ? "disabled" : ""}>${icon("mic")}실시간 STT 시작</button>
          <button class="btn outline" onclick="stopStreaming()" ${listening ? "" : "disabled"}>${icon("stop")}중지</button>
          ${listening ? `<span class="pill live">녹음 중 · <span id="trClock">${formatClock(streamingElapsedSec())}</span></span>` : timeline.length ? `<span class="pill done">${timeline.length}개 구간 전사됨</span>` : ""}
        </div>
        <div class="row">
          ${langSelect()}
          <button class="btn outline violet" onclick="translateUploadText()" ${state.uploadTranslationStatus === "번역 중" ? "disabled" : ""}>${icon("translate")}${state.uploadTranslationStatus === "번역 중" ? "번역 중..." : "번역하기"}</button>
          <button class="btn outline" onclick="clearUploadTranslation()">${icon("trash")}지우기</button>
        </div>
      </section>
      <div class="tr-grid">
        <section class="card tr-col">
          ${cardHead("한국어 전사문", "mic", badge(`${timeline.length}개 구간`, "violet"))}
          <div class="tr-list">
            ${timeline.length ? timeline.map((item) => `<div class="tr-seg"><b>${formatClock(item.start)} – ${formatClock(item.end)}</b><p>${html(item.text)}</p></div>`).join("") : ""}
            ${listening ? `<div class="tr-seg live"><b>${formatClock(streamingElapsedSec())} – 듣는 중</b><p>${html(state.streamingInterim) || `<span class="dots"><i></i><i></i><i></i></span>`}</p></div>` : ""}
            ${!timeline.length && !listening ? `<div class="tr-empty">실시간 STT 시작을 누르면 전사문이 표시됩니다. 아래 입력란에 직접 붙여넣기도 가능합니다.</div>` : ""}
          </div>
          <div class="field" style="margin-top:14px"><label>직접 수정 · 붙여넣기</label><textarea class="textarea" oninput="updateUploadTranslationText(this.value)" placeholder="번역할 전사문을 직접 수정하거나 붙여 넣을 수 있습니다.">${html(state.uploadTranslationText || (timeline.length ? "" : ""))}</textarea></div>
          <div class="tr-foot"><span>${sourceText.replace(/\s/g, "").length}자 · 음성 파일은 저장되지 않습니다</span></div>
        </section>
        <section class="card tr-col">
          ${cardHead(`번역 결과 · ${langName()}`, "globe", statusPill(state.uploadTranslationStatus))}
          <div class="tr-result ${state.uploadTranslation ? "" : "empty-txt"}">${html(state.uploadTranslation) || "번역하기를 누르면 결과가 표시됩니다."}</div>
          <div class="tr-foot"><span>${state.uploadTranslation ? `${state.uploadTranslation.length}자 번역됨` : "대기"}</span><div class="row" style="gap:8px"><button class="btn outline sm" onclick="copyTranslation()" ${state.uploadTranslation ? "" : "disabled"}>${icon("copy")}복사</button><button class="btn outline sm" onclick="saveTranslationText()" ${state.uploadTranslation ? "" : "disabled"}>${icon("download")}텍스트 저장</button></div></div>
        </section>
      </div>
    </div></div>`;
}

/* ==========================================================================
   ADMIN — 사용자 관리 · API 호출 관리 · 토큰 사용량
   ========================================================================== */
const ADMIN_TABS = [["users", "사용자 관리", "users"], ["usage", "API 호출 관리", "activity"], ["tokens", "토큰 사용량", "coins"]];
const FEATURES = ["발표 분석", "텍스트 분석", "번역", "답변 평가", "PDF 리포트", "자료 미리보기", "녹음 저장"];

function renderAdmin() {
  $("view").innerHTML = pageHead({
    crumbs: ["관리자"],
    title: "관리자 메뉴",
    sub: "계정을 발급하고, 계정별 API 사용 기록과 Claude 토큰 사용량을 확인합니다.",
    actions: `<button class="btn outline" onclick="go('app','dashboard')">${icon("arrowLeft")}서비스로 돌아가기</button>`,
    plain: true,
  }) + `
    <div class="page-body"><div class="container admin-layout">
      <nav class="admin-nav"><span class="k">관리</span>${ADMIN_TABS.map(([id, label, ic]) => `<button class="${state.adminTab === id ? "is-on" : ""}" onclick="go('admin','${id}')">${icon(ic)}${label}</button>`).join("")}</nav>
      <div id="adminBody" class="stack-24">${emptyState("불러오는 중", "잠시만 기다려 주세요.", "refresh")}</div>
    </div></div>`;
  if (state.adminTab === "users") loadAdminUsers();
  else if (state.adminTab === "usage") loadAdminUsage();
  else loadAdminTokens();
}
async function adminGet(url) {
  const res = await apiFetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}
async function adminSend(url, method, body) {
  const res = await apiFetch(url, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}
function adminError(err) {
  const body = $("adminBody");
  if (body) body.innerHTML = `<section class="card">${notice(`<b>불러오지 못했습니다.</b> ${html(userErrorMessage(err))}`, "bad", "alert")}</section>`;
}

/* ---------- users ---------- */
async function loadAdminUsers() {
  try {
    const data = await adminGet("/api/admin/users");
    state.admin.users = data.users || [];
    renderAdminUsers();
  } catch (err) {
    adminError(err);
  }
}
function renderAdminUsers() {
  const body = $("adminBody");
  if (!body) return;
  const ad = state.admin;
  const me = state.user?.id;
  const rows = ad.users.map((u) => {
    const self = u.id === me;
    const confirmDel = ad.confirm === u.id;
    const pw = ad.pwFor === u.id;
    return `
      <tr>
        <td><b>${html(u.id)}</b>${self ? ' <span class="badge violet">나</span>' : ""}</td>
        <td>${html(u.name || "-")}</td>
        <td><span class="role ${u.role}">${u.role === "admin" ? "관리자" : "일반"}</span></td>
        <td class="muted">${u.created_at ? formatDateTime(u.created_at) : "-"}<br><small>${html(u.created_by || "")}</small></td>
        <td class="muted">${u.last_login_at ? formatDateTime(u.last_login_at) : "없음"}</td>
        <td class="num">${Number(u.analyses || 0)}</td>
        <td>${u.disabled ? badge("비활성", "bad") : badge("사용 중", "good")}</td>
        <td>
          <div class="row-acts">
            ${pw ? `<form class="pw-form" onsubmit="adminResetPassword(event,'${html(u.id)}')"><input class="input sm" type="password" id="pwInput" placeholder="새 비밀번호 (10자 이상)" autocomplete="new-password"><button class="btn primary sm" type="submit">저장</button><button class="btn ghost sm" type="button" onclick="state.admin.pwFor=null;renderAdminUsers()">취소</button></form>`
              : confirmDel ? `<span class="inline-confirm">정말 삭제할까요? <button class="btn danger sm" onclick="adminDeleteUser('${html(u.id)}')">삭제</button><button class="btn ghost sm" onclick="state.admin.confirm=null;renderAdminUsers()">취소</button></span>`
              : `<button class="btn outline sm" onclick="state.admin.pwFor='${html(u.id)}';state.admin.confirm=null;renderAdminUsers()">${icon("key")}비밀번호</button>
                 ${self ? "" : `<button class="btn outline sm" onclick="adminToggleUser('${html(u.id)}',${u.disabled ? "false" : "true"})">${u.disabled ? "활성화" : "비활성화"}</button><button class="btn ghost sm" onclick="state.admin.confirm='${html(u.id)}';state.admin.pwFor=null;renderAdminUsers()">${icon("trash")}</button>`}`}
          </div>
        </td>
      </tr>`;
  }).join("");
  body.innerHTML = `
    <section class="card">
      ${cardHead("새 계정 발급", "plus", "회원가입은 없습니다. 관리자가 아이디와 비밀번호를 만들어 전달합니다.")}
      <form class="user-form" onsubmit="adminCreateUser(event)" autocomplete="off">
        <div class="field"><label for="nuId">아이디</label><input id="nuId" class="input sm" placeholder="예: codeday2 또는 이메일" required></div>
        <div class="field"><label for="nuName">이름</label><input id="nuName" class="input sm" placeholder="표시 이름" required></div>
        <div class="field"><label for="nuPw">초기 비밀번호</label><input id="nuPw" class="input sm" type="text" placeholder="10자 이상" required minlength="10" autocomplete="new-password"></div>
        <div class="field"><label for="nuRole">권한</label><select id="nuRole" class="select sm"><option value="user">일반</option><option value="admin">관리자</option></select></div>
        <button class="btn primary" type="submit" style="height:40px">${icon("plus")}발급</button>
      </form>
      <p class="form-error" id="nuError" style="margin-top:8px">${html(ad.error)}</p>
      ${ad.notice ? notice(ad.notice, "ok", "circleCheck") : ""}
    </section>
    <section class="card">
      ${cardHead("계정 목록", "users", `${ad.users.length}개`)}
      <div class="table-wrap nowrap"><table><thead><tr><th>아이디</th><th>이름</th><th>권한</th><th>생성</th><th>마지막 로그인</th><th class="num">분석</th><th>상태</th><th style="text-align:right">동작</th></tr></thead><tbody>${rows || `<tr><td colspan="8" class="table-empty">계정이 없습니다.</td></tr>`}</tbody></table></div>
      <p class="muted" style="font-size:13px;margin-top:12px">비활성화하면 그 계정은 즉시 로그인·API 호출이 막힙니다. 비밀번호를 바꾸면 다른 기기의 세션이 끊깁니다.</p>
    </section>`;
  if (ad.pwFor) { const el = $("pwInput"); if (el) el.focus(); }
}
async function adminCreateUser(event) {
  event.preventDefault();
  const id = $("nuId").value.trim();
  const name = $("nuName").value.trim();
  const password = $("nuPw").value;
  const role = $("nuRole").value;
  state.admin.error = "";
  state.admin.notice = "";
  if (password.length < 10) { state.admin.error = "비밀번호는 10자 이상이어야 합니다."; renderAdminUsers(); return; }
  try {
    const data = await adminSend("/api/admin/users", "POST", { id, name, password, role });
    state.admin.notice = `<b>${html(data.user.id)}</b> 계정을 발급했습니다. 아이디와 입력한 비밀번호를 사용자에게 전달하세요.`;
    toast("계정을 발급했습니다.");
    await loadAdminUsers();
  } catch (err) {
    state.admin.error = userErrorMessage(err);
    renderAdminUsers();
  }
}
async function adminResetPassword(event, id) {
  event.preventDefault();
  const password = $("pwInput").value;
  if (password.length < 10) { toast("비밀번호는 10자 이상이어야 합니다.", "bad"); return; }
  try {
    await adminSend(`/api/admin/users/${encodeURIComponent(id)}/password`, "POST", { password });
    state.admin.pwFor = null;
    toast(`${id} 비밀번호를 바꿨습니다.`);
    await loadAdminUsers();
  } catch (err) {
    toast(userErrorMessage(err), "bad");
  }
}
async function adminToggleUser(id, disabled) {
  try {
    await adminSend(`/api/admin/users/${encodeURIComponent(id)}/status`, "POST", { disabled });
    toast(disabled ? `${id} 계정을 비활성화했습니다.` : `${id} 계정을 활성화했습니다.`);
    await loadAdminUsers();
  } catch (err) {
    toast(userErrorMessage(err), "bad");
  }
}
async function adminDeleteUser(id) {
  try {
    await adminSend(`/api/admin/users/${encodeURIComponent(id)}`, "DELETE");
    state.admin.confirm = null;
    toast(`${id} 계정을 삭제했습니다.`);
    await loadAdminUsers();
  } catch (err) {
    toast(userErrorMessage(err), "bad");
  }
}

/* ---------- API usage log ---------- */
async function loadAdminUsage() {
  try {
    const f = state.admin.usageFilter;
    const qs = new URLSearchParams({ limit: "300" });
    if (f.user) qs.set("user", f.user);
    if (f.feature) qs.set("feature", f.feature);
    const [summary, log] = await Promise.all([adminGet("/api/admin/usage-summary"), adminGet(`/api/admin/usage-log?${qs}`)]);
    state.admin.usageSummary = summary;
    state.admin.usage = log.items || [];
    renderAdminUsage();
  } catch (err) {
    adminError(err);
  }
}
function setUsageFilter(key, value) {
  state.admin.usageFilter[key] = value;
  loadAdminUsage();
}
function detailText(detail) {
  if (!detail || typeof detail !== "object") return "";
  return Object.entries(detail).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(" · ");
}
function renderAdminUsage() {
  const body = $("adminBody");
  if (!body) return;
  const s = state.admin.usageSummary || { total: 0, by_user: [], by_feature: [] };
  const items = state.admin.usage;
  const f = state.admin.usageFilter;
  const users = (s.by_user || []).map((u) => u.user_id);
  const last = (s.by_user || []).map((u) => u.last_used_at).filter(Boolean).sort().pop();
  body.innerHTML = `
    <section class="admin-cards">
      <div class="card"><b>${Number(s.total || 0).toLocaleString("ko-KR")}</b><small>누적 호출 (로그인 계정)</small></div>
      <div class="card"><b>${(s.by_user || []).length}</b><small>호출한 계정 수</small></div>
      <div class="card"><b>${(s.by_feature || []).length}</b><small>사용된 기능 수</small></div>
      <div class="card"><b style="font-size:16px">${last ? formatDateTime(last) : "-"}</b><small>마지막 호출</small></div>
    </section>
    <div class="grid-2">
      <section class="card">${cardHead("계정별 사용량", "users")}<div class="table-wrap"><table><thead><tr><th>계정</th><th>권한</th><th class="num">호출</th><th class="num">성공</th><th class="num">실패</th><th>마지막 사용</th></tr></thead><tbody>${(s.by_user || []).map((u) => `<tr><td><b>${html(u.user_id)}</b></td><td><span class="role ${u.role === "admin" ? "admin" : "user"}">${u.role === "admin" ? "관리자" : "일반"}</span></td><td class="num">${u.calls}</td><td class="num tone-good">${u.ok}</td><td class="num ${u.failed ? "tone-bad" : ""}">${u.failed}</td><td class="muted">${u.last_used_at ? formatDateTime(u.last_used_at) : "-"}</td></tr>`).join("") || `<tr><td colspan="6" class="table-empty">아직 기록이 없습니다.</td></tr>`}</tbody></table></div></section>
      <section class="card">${cardHead("기능별 사용량", "activity")}<div class="table-wrap"><table><thead><tr><th>기능</th><th class="num">호출</th><th class="num">성공</th><th class="num">실패</th><th class="num">계정</th><th>마지막 사용</th></tr></thead><tbody>${(s.by_feature || []).map((x) => `<tr><td><b>${html(x.feature)}</b></td><td class="num">${x.calls}</td><td class="num tone-good">${x.ok}</td><td class="num ${x.failed ? "tone-bad" : ""}">${x.failed}</td><td class="num">${x.users ?? "-"}</td><td class="muted">${x.last_used_at ? formatDateTime(x.last_used_at) : "-"}</td></tr>`).join("") || `<tr><td colspan="6" class="table-empty">아직 기록이 없습니다.</td></tr>`}</tbody></table></div></section>
    </div>
    <section class="card">
      <div class="card-head"><span class="card-title">${icon("list")}호출 로그</span>
        <div class="log-filters">
          <select class="select sm" onchange="setUsageFilter('user',this.value)"><option value="">모든 계정</option>${users.map((u) => `<option value="${html(u)}" ${f.user === u ? "selected" : ""}>${html(u)}</option>`).join("")}</select>
          <select class="select sm" onchange="setUsageFilter('feature',this.value)"><option value="">모든 기능</option>${FEATURES.map((x) => `<option value="${x}" ${f.feature === x ? "selected" : ""}>${x}</option>`).join("")}</select>
          <button class="btn outline sm" onclick="loadAdminUsage()">${icon("refresh")}새로고침</button>
        </div>
      </div>
      <div class="table-wrap nowrap"><table><thead><tr><th>시각 (KST)</th><th>계정</th><th>기능</th><th>경로</th><th>결과</th><th class="num">소요(ms)</th><th class="num">입력(KB)</th><th>IP</th><th>상세</th></tr></thead><tbody>
        ${items.map((r) => `<tr class="${r.ok ? "" : "fail-row"}"><td class="muted" style="white-space:nowrap">${html(String(r.ts_kst || "").replace("T", " ").slice(0, 19))}</td><td><b>${html(r.user_id)}</b><br><small class="muted">${r.role === "admin" ? "관리자" : "일반"}</small></td><td>${html(r.feature)}</td><td><code style="font-size:12px">${html(r.path)}</code></td><td>${r.ok ? badge(`성공 ${r.status}`, "good") : badge(`실패 ${r.status}`, "bad")}</td><td class="num">${Number(r.elapsed_ms || 0).toLocaleString("ko-KR")}</td><td class="num">${(Number(r.bytes_in || 0) / 1024).toFixed(1)}</td><td class="muted">${html(r.ip || "")}</td><td class="muted wrap" style="font-size:12px;max-width:320px;word-break:break-all">${html(detailText(r.detail))}</td></tr>`).join("") || `<tr><td colspan="9" class="table-empty">기록된 호출이 없습니다. 사용자가 분석·번역·답변 평가를 쓰면 여기에 쌓입니다.</td></tr>`}
      </tbody></table></div>
      <p class="muted" style="font-size:13px;margin-top:12px">최신 300건까지 표시합니다. 원본은 서버의 output/api_usage.jsonl 파일입니다.</p>
    </section>`;
}

/* ---------- Claude token usage (ported from admin_token_check.html) ---------- */
const USAGE_FIELDS = [["uncached_input", "미캐시 입력"], ["cache_read", "캐시 읽기"], ["cache_write_5m", "캐시 쓰기(5m)"], ["cache_write_1h", "캐시 쓰기(1h)"], ["output", "출력"]];
const LOG_COLUMNS = [["호출시각(KST)", "called_at_kst", false], ["사용자ID", "user_id", false], ["분석ID", "analysis_id", false], ["용도", "purpose", false], ["대상", "target", false], ["제공사", "provider", false], ["모델", "model", false], ["입력토큰", "input_tokens", true], ["출력토큰", "output_tokens", true], ["캐시읽기", "cache_read_tokens", true], ["캐시쓰기", "cache_write_tokens", true], ["소요(초)", "duration_sec", true], ["성공", "success_label", false], ["실패유형", "failure_type", false], ["추정비용(USD)", "cost_usd", true]];
const num = (v) => (typeof v === "number" ? v.toLocaleString("ko-KR") : "-");
const cost = (v) => (typeof v === "number" ? `$${v.toFixed(2)}` : "-");
const costFine = (v) => (typeof v === "number" ? `$${v.toFixed(4)}` : "-");
function setTokensPeriod(period) {
  state.admin.tokensPeriod = period;
  loadAdminTokens();
}
async function loadAdminTokens() {
  const body = $("adminBody");
  if (!body) return;
  const period = state.admin.tokensPeriod;
  body.innerHTML = `
    <section class="card">
      <div class="card-head"><span class="card-title">${icon("coins")}Claude voice-up 토큰 사용량</span>
        <div class="row"><span class="segmented sm"><button class="${period === "30d" ? "is-on" : ""}" onclick="setTokensPeriod('30d')">최근 30일</button><button class="${period === "all" ? "is-on" : ""}" onclick="setTokensPeriod('all')">전체</button></span><button class="btn outline sm" onclick="loadAdminTokens()">${icon("refresh")}새로고침</button><a class="btn outline sm" id="xlsxBtn" href="/api/admin/org-usage.xlsx?period=${period}" hidden>${icon("download")}엑셀</a></div>
      </div>
      <div id="orgStatus" class="notice-box">${period === "all" ? "전체 기간 사용량 불러오는 중... (기간이 길면 몇 초 더 걸립니다)" : "계정 전체 사용량 불러오는 중..."}</div>
      <div id="tokenCards" class="admin-cards" style="margin-top:14px"></div>
      <div id="orgBody"></div>
    </section>
    <section class="card">
      <div class="card-head"><span class="card-title">${icon("list")}서버 호출 로그 (Claude · CLOVA)</span><span class="card-meta" id="logMeta">불러오는 중...</span></div>
      <div id="logBody"></div>
    </section>`;
  loadOrgUsage();
  loadCallLog();
}
let todayUtc = "";
let todaySource = "";
function tokenCards(data) {
  const t = (data.org_usage && data.org_usage.totals) || {};
  const c = data.cost && !data.cost.error ? data.cost : null;
  const costCard = c && c.estimated
    ? `<b>≈ ${cost(c.total_usd)}</b><small>voice-up 추정 비용 합계 (USD) · 사용량×단가</small>`
    : `<b>${cost(c && c.total_usd)}</b><small>비용 합계 (USD)</small>`;
  return `
    <div class="card"><b>${num(t.uncached_input)}</b><small>미캐시 입력토큰 (voice-up)</small></div>
    <div class="card"><b>${num(t.output)}</b><small>출력토큰 (voice-up)</small></div>
    <div class="card"><b>${num(t.cache_read)} / ${num((t.cache_write_5m || 0) + (t.cache_write_1h || 0))}</b><small>캐시 읽기/쓰기 토큰</small></div>
    <div class="card"><b>${(data.by_key || []).length}</b><small>voice-up API 키 수</small></div>
    <div class="card" style="border-color:var(--primary-90)">${costCard}</div>`;
}
function usageTables(summary, title, note) {
  if (!summary) return "";
  const headCols = USAGE_FIELDS.map(([, label]) => `<th class="num">${label}</th>`).join("");
  const modelRows = summary.models.map((m) => `<tr><td>${html(m.model)}</td>${USAGE_FIELDS.map(([k]) => `<td class="num">${num(m[k])}</td>`).join("")}<td class="num">${cost(m.est_cost_usd)}</td></tr>`).join("");
  const t = summary.totals;
  const knownCosts = summary.models.filter((m) => typeof m.est_cost_usd === "number");
  const costTotal = knownCosts.reduce((acc, m) => acc + m.est_cost_usd, 0);
  const costMark = knownCosts.length === summary.models.length ? "" : " *";
  const totalRow = `<tr class="total-row"><td><b>합계</b></td>${USAGE_FIELDS.map(([k]) => `<td class="num"><b>${num(t[k])}</b></td>`).join("")}<td class="num"><b>${cost(costTotal)}${costMark}</b></td></tr>`
    + (costMark ? `<tr><td colspan="7" class="muted">* 단가 미등록 모델은 합계에서 제외됨</td></tr>` : "");
  let dailyRows = summary.daily.map((d) => {
    const todayLabel = todaySource === "local_log" ? "오늘 · 진행 중 (서버 로그 추정)" : "오늘 · 진행 중 (추정)";
    const todayBadge = todayUtc && d.date === todayUtc ? ` ${badge(todayLabel, "violet")}` : "";
    return `<tr><td>${html(d.date)}${todayBadge}</td>${USAGE_FIELDS.map(([k]) => `<td class="num">${num(d[k])}</td>`).join("")}<td class="num">${cost(d.est_cost_usd)}</td></tr>`;
  }).join("");
  if (dailyRows) dailyRows += `<tr class="total-row"><td><b>합계</b></td>${USAGE_FIELDS.map(([k]) => `<td class="num"><b>${num(t[k])}</b></td>`).join("")}<td class="num"><b>${cost(costTotal)}${costMark}</b></td></tr>`;
  return `
    <h3 class="sub-title">${title} ${note ? `<small>· ${note}</small>` : ""}</h3>
    <div class="table-wrap"><table><thead><tr><th>모델</th>${headCols}<th class="num">추정비용(USD)</th></tr></thead><tbody>${modelRows || '<tr><td colspan="7" class="table-empty">사용량 없음</td></tr>'}${modelRows ? totalRow : ""}</tbody></table></div>
    ${dailyRows ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>날짜(UTC)</th>${headCols}<th class="num">추정비용(USD)</th></tr></thead><tbody>${dailyRows}</tbody></table></div>` : ""}`;
}
function byKeyTable(rows, matchedId) {
  if (!rows) return "";
  const headCols = USAGE_FIELDS.map(([, label]) => `<th class="num">${label}</th>`).join("");
  const body = rows.map((r) => {
    const isCurrent = matchedId && r.api_key_id === matchedId;
    const name = html(r.name || "-") + (r.hint ? ` <span class="muted">(${html(r.hint)})</span>` : "") + (isCurrent ? ` ${badge("현재 서버 키", "good")}` : "");
    return `<tr${isCurrent ? ' style="background:var(--primary-99)"' : ""}><td>${name}</td>${USAGE_FIELDS.map(([k]) => `<td class="num">${num(r[k])}</td>`).join("")}<td class="num">${cost(r.est_cost_usd)}</td></tr>`;
  }).join("");
  return `<h3 class="sub-title">API 키별 사용량 <small>· voice-up 키만 표시</small></h3><div class="table-wrap"><table><thead><tr><th>API 키</th>${headCols}<th class="num">추정비용(USD)</th></tr></thead><tbody>${body || '<tr><td colspan="7" class="table-empty">사용량 없음</td></tr>'}</tbody></table></div>`;
}
function costTables(costData) {
  if (!costData) return "";
  if (costData.error) return `<h3 class="sub-title">voice-up 비용</h3><div class="notice-box err">${html(costData.error)}</div>`;
  const byModel = Object.entries(costData.by_model || {}).map(([label, v]) => `<tr><td>${html(label)}</td><td class="num">${cost(v)}</td></tr>`).join("");
  let daily = (costData.daily || []).map((d) => `<tr><td>${html(d.date)}${todayUtc && d.date === todayUtc ? ` ${badge("오늘 · 진행 중", "violet")}` : ""}</td><td>${badge("추정", "violet")}</td><td class="num">${cost(d.amount_usd)}</td></tr>`).join("");
  if (daily) daily += `<tr class="total-row"><td><b>합계</b></td><td></td><td class="num"><b>≈ ${cost(costData.total_usd)}</b></td></tr>`;
  const note = costData.note ? `<div class="notice-box" style="margin-bottom:10px">${html(costData.note)}</div>` : "";
  return `
    <h3 class="sub-title">voice-up 비용 <small>· 합계 ≈ <b>${cost(costData.total_usd)}</b> · Cost API는 키별 필터를 지원하지 않아 사용량×단가 추정치입니다</small></h3>
    ${note}
    <div class="table-wrap"><table><thead><tr><th>모델</th><th class="num">추정비용(USD)</th></tr></thead><tbody>${byModel || '<tr><td colspan="2" class="table-empty">비용 없음</td></tr>'}</tbody></table></div>
    ${daily ? `<div class="table-wrap" style="margin-top:10px"><table><thead><tr><th>날짜(UTC)</th><th>구분</th><th class="num">추정비용(USD)</th></tr></thead><tbody>${daily}</tbody></table></div>` : ""}`;
}
async function loadOrgUsage() {
  const status = $("orgStatus");
  const body = $("orgBody");
  const cards = $("tokenCards");
  const xlsx = $("xlsxBtn");
  if (!status || !body) return;
  try {
    const res = await apiFetch(`/api/admin/org-usage?period=${state.admin.tokensPeriod}`);
    const data = await res.json();
    if (!data.ok) {
      status.className = `notice-box ${data.admin_key_missing ? "" : "err"}`;
      status.innerHTML = data.admin_key_missing
        ? `<b>Admin API 키가 필요합니다.</b><br>${html(data.error)}<br>· 일반 <code>CLAUDE_API_KEY</code>로는 과거 전체 내역을 조회할 수 없습니다. Console(Settings → Organization → API keys)에서 Admin 키를 발급해 <code>.env</code>의 <code>ANTHROPIC_ADMIN_KEY</code>에 넣고 서버를 재시작하세요.<br>· 키 없이 확인하려면 Console의 Usage/Cost 페이지에서 같은 데이터를 볼 수 있습니다. 아래 서버 호출 로그는 키 없이도 보입니다.`
        : html(data.error);
      return;
    }
    const mk = data.matched_key;
    todayUtc = data.today_date || "";
    todaySource = data.today_source || "";
    if (xlsx) xlsx.hidden = false;
    status.className = data.stale ? "notice-box" : "notice-box ok";
    const staleNote = data.stale ? `⚠️ 방금 조회가 실패해(호출 한도 등) <b>마지막 성공 데이터</b>를 표시 중입니다. 잠시 후 새로고침하면 갱신됩니다.<br>` : "";
    status.innerHTML = staleNote + (mk
      ? `현재 서버의 API 키: <b>${html(mk.name || "(이름 없음)")}</b> (<code>${html(mk.hint || mk.id)}</code>) · ${html(data.period_label || "최근 30일")} 집계 · 데이터 조회 시각 ${html(data.fetched_at_kst || "")}`
      : `voice-up 키 중 현재 서버의 CLAUDE_API_KEY와 일치하는 항목이 없습니다. 아래에는 <b>voice-up</b> 키 사용량을 표시합니다.`);
    if (todaySource === "local_log") status.innerHTML += `<br>오늘 사용량은 Admin API 집계 지연(~1시간)을 보완하기 위해 <b>이 서버의 호출 로그</b> 기반 추정치입니다.`;
    if (cards) cards.innerHTML = tokenCards(data);
    body.innerHTML = byKeyTable(data.by_key, mk ? mk.id : null)
      + (mk ? usageTables(data.key_usage, "이 API 키 사용량 (모든 PC/서비스 포함)", "Anthropic 집계 기준") : "")
      + usageTables(data.org_usage, "voice-up 전체 사용량", "voice-up 키 합산")
      + costTables(data.cost);
  } catch (err) {
    status.className = "notice-box err";
    status.textContent = `계정 전체 사용량 조회 실패: ${userErrorMessage(err)}`;
  }
}
async function loadCallLog() {
  const meta = $("logMeta");
  const body = $("logBody");
  if (!meta || !body) return;
  try {
    const res = await apiFetch("/api/admin/call-log?limit=200");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "호출 로그를 불러오지 못했습니다.");
    const s = data.summary || {};
    meta.innerHTML = `총 ${num(data.total)}건 중 최신 ${num(data.rows.length)}건 · 성공 ${num(s.success_calls)} / 실패 ${num(s.failed_calls)} · 누적 추정비용 ${costFine(s.cost_usd)}`;
    if (!data.rows.length) {
      body.innerHTML = `<div class="table-empty">기록된 호출이 없습니다. 분석/번역/STT 기능을 사용하면 이곳에 쌓입니다.</div>`;
      return;
    }
    const head = `<tr>${LOG_COLUMNS.map(([label, , isNum]) => `<th${isNum ? ' class="num"' : ""}>${label}</th>`).join("")}</tr>`;
    const rowsHtml = data.rows.map((row) => {
      const cells = LOG_COLUMNS.map(([, key, isNum]) => {
        if (key === "success_label") return `<td>${row.success ? badge("성공", "good") : badge("실패", "bad")}</td>`;
        const v = row[key];
        let text;
        if (v === null || v === undefined || v === "") text = "-";
        else if (key === "cost_usd") text = costFine(v);
        else if (typeof v === "number") text = num(v);
        else text = html(String(v));
        return `<td${isNum ? ' class="num"' : ""}>${text}</td>`;
      }).join("");
      return `<tr class="${row.success ? "" : "fail-row"}">${cells}</tr>`;
    }).join("");
    body.innerHTML = `<div class="table-wrap nowrap"><table><thead>${head}</thead><tbody>${rowsHtml}</tbody></table></div>`;
  } catch (err) {
    meta.textContent = `호출 로그 조회 실패: ${userErrorMessage(err)}`;
    body.innerHTML = "";
  }
}

boot();
