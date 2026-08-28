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

function bar(label, value, tone = "cyan") {
  const n = scoreOf(value);
  return `<div class="scorebar"><p>${html(label)}<b>${n}점</b></p><span><i class="${tone}" style="width:${n}%"></i></span></div>`;
}

function card(title, body, cls = "") {
  return `<article class="card ${cls}"><h3>${html(title)}</h3>${body}</article>`;
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

function renderHome() {
  const a = state.analysis;
  const voices = ready() ? displayVoiceScores(a) : {
    "발표 흐름": 0,
    "내용 전달력": 0,
    "Q&A 대응": 0,
    "시간 관리": 0,
  };
  $("homeView").innerHTML = `
    <section class="hero">
      <div class="hero-copy">
        <span class="eyebrow">AI 발표평가 사전심사</span>
        <h1>실전 발표 전,<br><em>AI 심사위원</em>과 연습하세요</h1>
        <p>발표자료를 띄워 실제처럼 연습하고, 페이지별 체류시간과 실시간 음성 전사를 함께 기록해 발표 구간을 분석합니다.</p>
        <button class="primary" onclick="setView('demo','upload')">사전심사 시작</button>
        <div class="hero-stats">
          <span><b>${ready() ? html(a.filler_total) : "-"}</b>추임새</span>
          <span><b>${ready() ? html(a.wpm) : "-"}</b>WPM</span>
          <span><b>${ready() ? html(a.document_match?.score ?? "-") : "-"}</b>자료 일치율</span>
        </div>
      </div>
      <div class="hero-report">
        <div class="report-top">
          <span class="iconbox">R</span>
          <div><b>발표평가 결과</b><small>AI 사전심사 리포트</small></div>
          <strong>${ready() ? html(a.score) : "--"}<small>/100점</small></strong>
        </div>
        ${Object.entries(voices).map(([k, v], i) => bar(k, v, i === 3 ? "yellow" : "blue")).join("")}
        <p class="notice">${ready() ? html(a.summary || "분석이 완료되었습니다.") : "파일 업로드 전에는 평가 수치를 표시하지 않습니다."}</p>
      </div>
    </section>
    <section class="section">
      <h2>발표평가 사전심사 프로세스</h2>
      <p>자료 등록, 발표 연습, 예상 질문, 분석 결과, 종합 리포트까지 한 화면에서 이어집니다.</p>
      <div class="grid4">
        ${[
          ["발표자료 등록", "PPT/PDF와 음성 파일 선택"],
          ["발표 연습", "자료 페이지와 실시간 음성 구간 기록"],
          ["AI 분석", "STT + Python 정량 계산 + Claude 평가"],
          ["종합 리포트", "점수와 개선안 PDF 추출"],
        ].map((item, i) => `<article class="mini"><span>Step ${i + 1}</span><b>${item[0]}</b><small>${item[1]}</small></article>`).join("")}
      </div>
    </section>
    <section class="section">
      <h2>실전과 동일한 심사위원 구성</h2>
      <div class="grid3">
        ${card("투자 심사역 AI", "<span class='badge green'>VC</span><p>투자 매력도, ROI, Exit 전략을 검토합니다.</p>")}
        ${card("기술 전문가 AI", "<span class='badge blue'>TE</span><p>기술 실현 가능성, 특허, R&D 역량을 검토합니다.</p>")}
        ${card("산업 전문가 AI", "<span class='badge sky'>IE</span><p>시장성, 경쟁 환경, 진입 장벽을 검토합니다.</p>")}
      </div>
    </section>`;
}

function tabs() {
  const items = [
    ["upload", "등록 발표자료"],
    ["practice", "발표 연습"],
    ["questions", "예상질문준비"],
    ["analysis", "분석결과"],
    ["summary", "종합결과"],
  ];
  return `<div class="tabs">${items.map(([id, label]) => `<button class="${state.tab === id ? "active" : ""}" onclick="setTab('${id}')">${label}</button>`).join("")}</div>`;
}

function renderDemo() {
  $("demoView").innerHTML = `
    <header class="page-head">
      <button class="link" onclick="setView('home')">← 발표평가로 돌아가기</button>
      <div><p>발표 음성 / 발표자료 / 실시간 연습</p></div>
      <button class="outline" onclick="downloadReport()">리포트 다운로드</button>
    </header>
    ${tabs()}
    <div id="tabBody"></div>`;
  renderTab();
}

function renderTab() {
  if (state.tab === "upload") renderUpload();
  if (state.tab === "practice") renderPractice();
  if (state.tab === "questions") renderQuestions();
  if (state.tab === "analysis") renderAnalysis();
  if (state.tab === "summary") renderSummary();
}

function renderUpload() {
  const a = state.analysis;
  const audioName = state.selectedFile ? state.selectedFile.name : "M4A, MP3, WAV 파일을 선택하거나 끌어다 놓으세요";
  const materialName = state.selectedMaterial ? state.selectedMaterial.name : "PPTX 또는 PDF 파일을 선택하거나 끌어다 놓으세요";
  $("tabBody").innerHTML = `
    <section class="upload-layout">
      <div class="slide-preview">
        <div class="brain">AI</div>
        <h1>발표자료 등록</h1>
        <p>음성 파일 없이도 발표 연습 탭에서 실시간 STT로 녹음하고 전사할 수 있습니다. PPT/PDF를 함께 올리면 페이지별 발표 구간을 기록합니다.</p>
        <div class="upload-duo">
          <label class="upload-box" for="audioInput" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handleAudioDrop(event)">
            <input id="audioInput" type="file" accept=".mp3,.wav,.m4a,.aac,.flac,audio/*" onchange="handleAudioSelected(this)">
            <span>발표 음성 업로드</span><small>${html(audioName)}</small>
          </label>
          <label class="upload-box" for="materialInput" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handleMaterialDrop(event)">
            <input id="materialInput" type="file" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onchange="handleMaterialSelected(this)">
            <span>PPT/PDF 발표자료 업로드</span><small>${html(materialName)}</small>
          </label>
        </div>
        <div class="action-row center">
          <button class="primary" onclick="setTab('practice')">발표 연습으로 이동</button>
          <button class="outline" onclick="analyzePresentation()" ${state.busy ? "disabled" : ""}>${state.busy ? "분석 중..." : "바로 분석하기"}</button>
        </div>
      </div>
      <aside class="side-panel">
        <h3>${a ? html(a.audio_name) : "분석 대기"}</h3>
        <div class="metric3">
          <b>${a ? html(a.score) : "-"}</b><b>${a ? html(a.wpm) : "-"}</b><b>${a?.document_match?.available ? html(a.document_match.score) : "-"}</b>
          <small>종합점수</small><small>WPM</small><small>자료 일치율</small>
        </div>
        ${a ? Object.entries(displayVoiceScores(a)).map(([k, v], i) => bar(k, v, i === 3 ? "yellow" : "cyan")).join("") : "<p class='muted'>발표자료를 업로드하고 발표 연습을 시작하면 페이지별 체류시간과 음성 구간이 기록됩니다.</p>"}
      </aside>
    </section>
    ${renderUploadTranslatePanel()}`;
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
        <h2>발표 연습 자료 첨부</h2>
        <p>이 탭에서 사용할 PPT/PDF를 별도로 첨부하세요. 기존 등록 발표자료 기능은 그대로 유지됩니다.</p>
        <label class="upload-box practice-upload" for="practiceMaterialInput" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handlePracticeMaterialDrop(event)">
          <input id="practiceMaterialInput" type="file" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onchange="handlePracticeMaterialSelected(this)">
          <span>PPT/PDF 발표자료 첨부</span>
          <small>발표 연습에서만 사용하는 자료입니다.</small>
        </label>
      </section>`;
    return;
  }
  if (!state.practicePreview) {
    $("tabBody").innerHTML = `<section class="empty">발표자료를 불러오는 중입니다.</section>`;
    try {
      await preparePracticePreview();
    } catch (err) {
      $("tabBody").innerHTML = `<section class="empty">${html(userErrorMessage(err, "발표자료를 불러오지 못했습니다. 파일 형식을 확인해 주세요."))}</section>`;
      return;
    }
  }

  const preview = state.practicePreview || {};
  const total = Math.max(1, Number(preview.page_count || preview.sections?.length || 1));
  const current = Math.min(Math.max(1, state.practice.currentPage), total);
  state.practice.currentPage = current;
  $("tabBody").innerHTML = `
    <section class="practice-layout">
      <article class="practice-stage">
        <div class="practice-toolbar">
          <div>
            <b>${html(state.practiceMaterial.name)}</b>
            <span>${html(preview.type || "")} · ${current}/${total} 페이지</span>
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
          <button id="practicePrevBtn" class="outline" onclick="prevPracticePage()" ${current <= 1 || state.practice.active ? "disabled" : ""}>이전 페이지</button>
          <div class="page-dots">${Array.from({ length: total }, (_, i) => `<button class="${i + 1 === current ? "active" : ""}" onclick="jumpPracticePage(${i + 1})" ${state.practice.active ? "disabled" : ""}>${i + 1}</button>`).join("")}</div>
          <button id="practiceNextBtn" class="outline" onclick="nextPracticePage()" ${!state.practice.active && current >= total ? "disabled" : ""}>다음 페이지</button>
        </div>
      </article>
      <aside class="practice-side">
        <h3>실시간 발표 기록</h3>
        <div class="metric2">
          <b id="practiceSideClock">${formatClock(practiceElapsedSec())}</b><b id="practiceSegmentCount">${state.streamingTimeline.length}</b>
          <small>녹음/전사 시간</small><small>전사 구간</small>
        </div>
        <div class="action-row">
          <button id="practiceStartBtn" class="primary" onclick="startPractice()" ${state.practice.active ? "disabled" : ""}>발표 시작</button>
          <button id="practiceFinishBtn" class="outline" onclick="finishPractice()" ${!state.practice.active ? "disabled" : ""}>발표 종료</button>
          <button id="practiceAnalyzeBtn" class="outline" onclick="analyzePractice()" ${state.busy || state.practice.active || !practiceTranscript().trim() ? "disabled" : ""}>${state.busy ? "분석 중..." : "연습 분석하기"}</button>
        </div>
        <p class="muted">발표 시작을 누르면 마이크 녹음과 전사가 함께 시작됩니다. 다음 페이지를 누를 때마다 해당 페이지 체류시간과 음성 구간이 저장됩니다.</p>
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
            <button class="outline compact" onclick="setPracticePdfZoom(-0.15)">축소</button>
            <span>${Math.round(state.practicePdfZoom * 100)}%</span>
            <button class="outline compact" onclick="setPracticePdfZoom(0.15)">확대</button>
            <button class="outline compact" onclick="resetPracticePdfZoom()">맞춤</button>
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
  if (!allRows.length) return `<p class="muted">아직 기록된 페이지 구간이 없습니다. 발표 시작 후 실시간 로그가 표시됩니다.</p>`;
  return `${allRows.map((r) => `
    <div class="practice-record">
      <b>Page ${html(r.page)}${r.live ? " · 진행 중" : ""}</b>
      <span>${html(formatClock(r.start))}-${html(formatClock(r.end))} · ${html(formatDuration(r.duration))}</span>
      <small>${html(r.transcript || "해당 구간 전사문 없음")}</small>
    </div>`).join("")}`;
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

function renderUploadTranslatePanel() {
  const timeline = state.streamingTimeline || [];
  return `
    <section class="streaming-panel translate-only-panel">
      <div class="panel-head">
        <h2>실시간 한국어 STT / 번역</h2>
        <span>${state.listening ? "전사 중" : html(state.uploadTranslationStatus)}</span>
      </div>
      <p class="muted">등록 발표자료 탭에서는 실시간 STT 전사와 번역만 진행합니다. 녹음 파일 저장과 발표 구간 분석은 발표 연습 탭에서 사용하세요.</p>
      <div class="streaming-actions">
        <button class="primary" onclick="startUploadStt()" ${state.listening ? "disabled" : ""}>실시간 STT 시작</button>
        <button class="outline" onclick="stopStreaming()" ${!state.listening ? "disabled" : ""}>중지</button>
        <label class="streaming-select">번역 언어
          <select onchange="setTargetLang(this.value)">
            ${[
              ["en", "영어"], ["ja", "일본어"], ["zh", "중국어 간체"], ["es", "스페인어"],
              ["fr", "프랑스어"], ["de", "독일어"], ["vi", "베트남어"], ["id", "인도네시아어"],
            ].map(([value, label]) => `<option value="${value}" ${state.targetLang === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <button class="primary" onclick="translateUploadText()">번역하기</button>
        <button class="outline" onclick="clearUploadTranslation()">지우기</button>
      </div>
      <div class="streaming-grid">
        <article class="stream-box">
          <h3>한국어 전사문 <span>${timeline.length}개 구간</span></h3>
          <div class="stream-timeline">
            ${timeline.length ? timeline.map((item, index) => `
              <div class="stream-timeline-item">
                <b>${html(item.time)}</b>
                <span>구간 ${index + 1}</span>
                <p>${html(item.text)}</p>
              </div>`).join("") : `<p class="muted">실시간 STT 시작을 누르면 전사문이 표시됩니다. 직접 붙여넣기도 가능합니다.</p>`}
            ${state.streamingInterim ? `<div class="stream-timeline-item interim"><b>${html(formatClock(streamingElapsedSec()))}</b><span>인식 중</span><p>${html(state.streamingInterim)}</p></div>` : ""}
          </div>
          <textarea class="manual-transcript" oninput="updateUploadTranslationText(this.value)" placeholder="번역할 전사문을 직접 수정하거나 붙여 넣을 수 있습니다.">${html(uploadTranslationSourceText())}</textarea>
          <p class="muted">${uploadTranslationSourceText().replace(/\s/g, "").length}자 · 음성 파일 저장 없음</p>
        </article>
        <article class="stream-box">
          <h3>번역 결과 <span>${html(state.uploadTranslationStatus)}</span></h3>
          <div class="translation-box">${html(state.uploadTranslation)}</div>
        </article>
      </div>
    </section>`;
}

async function startUploadStt() {
  clearStreaming(false);
  await startStreaming({ record: false });
  renderUpload();
}

function renderStreamingPanel(compact = false) {
  const timeline = state.streamingTimeline || [];
  const recordingStatus = state.listening ? "녹음 중" : state.recordedBlob ? "녹음 완료" : "녹음 대기";
  return `
    <section id="streamingPanel" class="streaming-panel ${compact ? "compact" : ""}">
      <div class="panel-head">
        <h2>실시간 한국어 STT</h2>
        <span>${state.listening ? "전사/녹음 중" : "대기 중"}</span>
      </div>
      <div class="streaming-actions">
        <button class="primary" onclick="startStreaming()" ${state.listening ? "disabled" : ""}>실시간 STT 시작</button>
        <button class="outline" onclick="stopStreaming()" ${!state.listening ? "disabled" : ""}>중지</button>
        <button class="outline" onclick="clearStreaming()">전사문 지우기</button>
        ${state.recordedBlob ? `<button class="outline" onclick="downloadStreamingAudio()">녹음 파일 다운로드</button>` : ""}
        <label class="streaming-select">번역 언어
          <select onchange="setTargetLang(this.value)">
            ${[
              ["en", "영어"], ["ja", "일본어"], ["zh", "중국어 간체"], ["es", "스페인어"],
              ["fr", "프랑스어"], ["de", "독일어"], ["vi", "베트남어"], ["id", "인도네시아어"],
            ].map(([value, label]) => `<option value="${value}" ${state.targetLang === value ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <button class="outline" onclick="translateStreaming()">번역하기</button>
      </div>
      <div class="streaming-grid">
        <article class="stream-box">
          <h3>한국어 전사문 <span>${timeline.length}개 구간</span></h3>
          <div class="stream-timeline">
            ${timeline.length ? timeline.map((item, index) => `
              <div class="stream-timeline-item">
                <b>${html(item.time)}</b>
                <span>구간 ${index + 1}${item.page ? ` · Page ${html(item.page)}` : ""}</span>
                <p>${html(item.text)}</p>
              </div>`).join("") : `<p class="muted">실시간 STT 시작을 누르면 타임라인별 전사문이 표시됩니다.</p>`}
            ${state.streamingInterim ? `<div class="stream-timeline-item interim"><b>${html(formatClock(streamingElapsedSec()))}</b><span>인식 중</span><p>${html(state.streamingInterim)}</p></div>` : ""}
          </div>
          <textarea id="streamingText" class="manual-transcript" oninput="updateStreamingText(this.value)" placeholder="필요하면 전사문을 직접 수정할 수 있습니다.">${html(state.streamingTranscript)}</textarea>
          <p class="muted">${state.streamingTranscript.replace(/\s/g, "").length}자 · ${recordingStatus}${state.recordingSavedPath ? ` · 서버 저장 완료: ${html(state.recordingSavedPath)}` : ""}</p>
          ${state.recordedAudioUrl ? `<audio class="recorded-audio" controls src="${state.recordedAudioUrl}"></audio>` : ""}
        </article>
        <article class="stream-box">
          <h3>번역 결과 <span>${html(state.translationStatus)}</span></h3>
          <div class="translation-box">${html(state.translation)}</div>
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
  renderUpload();
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
  renderUpload();
}

function clearUploadTranslation() {
  state.uploadTranslationText = "";
  state.uploadTranslation = "";
  state.uploadTranslationStatus = "대기";
  renderUpload();
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

async function analyzePresentation() {
  const transcript = state.streamingTranscript.trim();
  if (!state.selectedFile && !transcript) {
    alert("발표 음성 파일을 선택하거나 발표 연습/실시간 STT 전사문을 생성하세요.");
    return;
  }
  state.busy = true;
  renderTab();
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
  return `<article class="answer-card"><h3>AI 답변 평가 <span>${scoreOf(r.score)}점</span></h3><div class="two"><div><b>강점</b><ul>${(r.strengths || []).map((x) => `<li>${html(x)}</li>`).join("") || "<li>분석 결과 없음</li>"}</ul></div><div><b>개선점</b><ul>${(r.improvements || []).map((x) => `<li>${html(x)}</li>`).join("") || "<li>분석 결과 없음</li>"}</ul></div></div><p><b>모범 답변 예시</b><br>${html(r.model_answer || "")}</p></article>`;
}

function renderQuestions() {
  const list = questions();
  const idx = Math.min(state.qaIndex, list.length - 1);
  const item = list[idx];
  const result = state.qaResults[idx];
  $("tabBody").innerHTML = `
    <section class="qa-layout">
      <div>
        <div class="question-stage">
          <span class="pill">예상 질문 #${idx + 1}</span>
          <div class="qicon">Q</div>
          <p>[${html(item.category)}]</p>
          <h1>${html(item.question)}</h1>
          <small>권장 답변 시간: 90초 · ${html(item.level)}</small>
        </div>
        <div class="question-nav">
          <button class="outline" onclick="moveQuestion(-1)">이전 질문</button>
          <div class="dot-nav">${list.map((_, i) => `<button class="dot-btn ${i === idx ? "active" : ""}" onclick="goQuestion(${i})">${i + 1}</button>`).join("")}</div>
          <button class="outline" onclick="moveQuestion(1)">다음 질문</button>
        </div>
        <h2>내 답변 및 AI 분석</h2>
        <textarea id="answerText" placeholder="질문에 대한 답변을 입력하세요.">${html(state.qaAnswers[idx] || "")}</textarea>
        <button class="primary" onclick="evaluateAnswer()">답변 평가하기</button>
        ${result ? renderAnswerResult(result) : ""}
      </div>
      <aside class="side-panel">
        <h3>예상질문 연습</h3>
        <div class="metric2">
          <b>${Object.keys(state.qaResults).length}/${list.length}</b><b>${result ? scoreOf(result.score) : "-"}</b>
          <small>완료한 질문</small><small>현재 점수</small>
        </div>
        ${["논리성", "구체성", "자신감", "시간 관리"].map((k, i) => bar(k, result ? scoreOf(result[k] || result.score || 0) : 0, i === 3 ? "yellow" : "cyan")).join("")}
      </aside>
    </section>`;
}

function renderAnalysis() {
  const a = state.analysis;
  if (!a) {
    $("tabBody").innerHTML = `<section class="empty">발표 음성 또는 실시간 전사문을 분석하면 결과가 표시됩니다.</section>`;
    return;
  }
  const matchCard = a.document_match?.available ? card("자료-음성 일치율", renderDocumentMatch(a.document_match), "full") : "";
  const llmFailed = Boolean(a.llm_error);
  const llmErrorCard = llmFailed ? card("AI 종합평가 실패", `<p>${html(a.llm_error)}</p><p class="muted">아래 내용은 CLOVA 전사문과 Python 측정 지표만으로 표시된 결과입니다.</p>`, "full") : "";
  $("tabBody").innerHTML = `
    ${llmErrorCard}
    <section class="metrics">
      ${card("종합 점수", llmFailed ? `<strong>-<small> 평가 실패</small></strong>` : `<strong>${html(a.score)}<small>/100</small></strong>`)}
      ${card("평균 발화속도", `<strong>${html(a.wpm)}<small> WPM</small></strong>`)}
      ${card("추임새 단어", `<strong>${html(a.filler_total)}<small>회</small></strong>`)}
      ${card("어휘 문제", llmFailed ? `<strong>-<small> 평가 실패</small></strong>` : `<strong>${metricCount(a.vocab_issues, a.vocab_suggestions)}<small>건</small></strong>`)}
    </section>
    ${matchCard}
    ${a.practice_summary ? card("발표 연습 구간 매칭", `<p>${html(a.practice_summary)}</p>${renderPracticeAnalysisTable(a.practice_segments || [])}`, "full") : ""}
    <section class="analysis-grid">
      ${card("발화 속도 분석", `<canvas id="paceChart" width="720" height="360"></canvas><p class="muted">권장 범위: 120-150 WPM</p>`, "chart-card")}
      ${card("음성 품질 분석", llmFailed ? `<p class="muted">AI 평가 실패로 음성 품질 점수를 제공할 수 없습니다.</p>` : Object.entries(displayVoiceScores(a)).map(([k, v], i) => bar(k, v, i === 3 ? "yellow" : "cyan")).join(""))}
      ${card("추임새 단어 분석", renderFillers(a.filler_words || []))}
      ${card("어휘 개선 제안", llmFailed ? `<p class="muted">AI 평가 실패로 어휘 개선 제안을 제공할 수 없습니다.</p>` : renderVocab(a.vocab_suggestions || []))}
    </section>
    <section class="analysis-grid">
      ${card("화자별 분석", renderSpeakers(a.speaker_stats || []))}
      ${card("문장별 타임라인", renderTimeline(a.sentence_segments || []))}
    </section>
    ${card("슬라이드별 분석", renderSlideRows(a.slide_rows || []), "full")}`;
  drawPaceChart(a.pace_series || [], a.wpm || 140);
}

function renderPracticeAnalysisTable(rows) {
  if (!rows.length) return "";
  return `<table><thead><tr><th>페이지</th><th>시작</th><th>종료</th><th>체류시간</th><th>전사 구간</th></tr></thead><tbody>${rows.map((r) => `<tr><td>Page ${html(r.page)}</td><td>${html(formatClock(r.start))}</td><td>${html(formatClock(r.end))}</td><td>${html(formatDuration(r.duration))}</td><td>${html(r.transcript || "-")}</td></tr>`).join("")}</tbody></table>`;
}

function renderDocumentMatch(match) {
  return `<div class="match-icons"><span>문서</span><i>${html(match.score)}%</i><span>발표 음성</span></div><p>${html(match.summary || "")}</p><div class="metric3"><b>${html(match.document_coverage)}%</b><b>${html(match.speech_extra_ratio)}%</b><b>${html(match.sections?.length || 0)}</b><small>자료 반영률</small><small>자료 외 발화 추정</small><small>페이지/슬라이드</small></div><div class="two"><div><b>자료에는 있지만 발표에서 약한 키워드</b><p>${(match.missing_terms || []).map(html).join(", ") || "없음"}</p></div><div><b>발표에는 있지만 자료에 약한 키워드</b><p>${(match.extra_terms || []).map(html).join(", ") || "없음"}</p></div></div>${renderDocumentSections(match.sections || [])}`;
}

function renderDocumentSections(rows) {
  if (!rows.length) return "";
  return `<table><thead><tr><th>자료 구간</th><th>일치율</th><th>상태</th><th>누락 키워드</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${html(r.title || r.page)}</td><td>${html(r.score)}%</td><td>${html(r.status)}</td><td>${(r.missing || []).map(html).join(", ")}</td></tr>`).join("")}</tbody></table>`;
}

function renderFillers(items) {
  if (!items.length) return "<p class='muted'>감지된 추임새 단어가 없습니다.</p>";
  return items.map((x) => `<div class="row"><b>"${html(x.word)}"</b><span class="tag">${html(x.severity)}</span><strong>${html(x.count)}회</strong></div>`).join("");
}

function renderVocab(items) {
  const rows = cleanVocabItems(items);
  if (!rows.length) return "<p class='muted'>감지된 어휘 개선 항목이 없습니다.</p>";
  return rows.map((x) => {
    const body = x.replacement
      ? `<p class="vocab-pair"><b>${html(x.original || "-")}</b><span>→</span><em>${html(x.replacement)}</em></p>`
      : `<p class="vocab-single"><b>${html(x.original || x.reason || "-")}</b></p>`;
    return `<div class="vocab"><small>개선 표현</small>${body}${x.reason && x.reason !== x.original ? `<span>${html(x.reason)}</span>` : ""}</div>`;
  }).join("");
}

function renderSpeakers(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "<p class='muted'>화자 분리 정보가 없습니다.</p>";
  return `<table><thead><tr><th>화자</th><th>문장</th><th>발화시간</th><th>WPM</th><th>추임새</th></tr></thead><tbody>${rows.map((s) => `<tr><td>${html(cleanSpeaker(s.speaker))}</td><td>${html(s.sentences)}</td><td>${html(s.seconds)}초</td><td>${html(s.wpm)}</td><td>${html(s.fillers)}회</td></tr>`).join("")}</tbody></table>`;
}

function formatGap(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  return number < 1 ? number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "") : number.toFixed(1).replace(/\.0$/, "");
}

function renderTimeline(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "<p class='muted'>문장별 timestamp가 없습니다.</p>";
  return `<p class="muted">전체 ${rows.length}개 문장</p><div class="timeline-list">${rows.map((x) => `<div class="timeline-item"><b>${html(x.time)}</b><span>${html(cleanSpeaker(x.speaker))} · 구간 ${html(x.section)} · 공백 ${html(formatGap(x.gap_before))}초</span><p>${html(x.text)}</p></div>`).join("")}</div>`;
}

function renderSlideRows(rows) {
  if (!rows.length) return "<p class='muted'>구간별 분석이 없습니다.</p>";
  return `<table><thead><tr><th>슬라이드</th><th>체류시간</th><th>권장시간</th><th>발화속도</th><th>추임새</th><th>피드백</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${html(r.slide)}</td><td>${html(r.duration)}</td><td>${html(r.recommended)}</td><td>${html(r.wpm)}</td><td>${html(r.fillers)}</td><td>${html(r.feedback)}</td></tr>`).join("")}</tbody></table>`;
}

function drawPaceChart(series, fallbackWpm) {
  const canvas = $("paceChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const pad = { l: 58, r: 24, t: 34, b: 58 };
  const data = (series.length ? series : [{ time: "0:00", wpm: fallbackWpm }]).map((d, i) => ({ time: String(d.time || `${i}:00`), wpm: Number(d.wpm || fallbackWpm || 0) }));
  const values = data.map((d) => d.wpm).filter(Number.isFinite);
  const min = Math.max(0, Math.floor((Math.min(...values, 120) - 20) / 10) * 10);
  const max = Math.max(min + 60, Math.ceil((Math.max(...values, 150) + 20) / 10) * 10);
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const yFor = (v) => pad.t + (1 - (v - min) / Math.max(1, max - min)) * plotH;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#344054";
  ctx.font = "13px Arial";
  ctx.textAlign = "left";
  ctx.fillText("WPM", pad.l, 18);
  const step = Math.max(10, Math.round((max - min) / 4 / 10) * 10);
  for (let t = min; t <= max; t += step) {
    const y = yFor(t);
    ctx.strokeStyle = "#e5e9f2";
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillStyle = "#667085";
    ctx.textAlign = "right";
    ctx.fillText(String(t), pad.l - 10, y + 4);
  }
  ctx.fillStyle = "rgba(37,99,235,.10)";
  ctx.fillRect(pad.l, yFor(150), plotW, Math.max(1, yFor(120) - yFor(150)));
  ctx.strokeStyle = "#2563eb";
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((d, i) => {
    const x = pad.l + (i / Math.max(1, data.length - 1)) * plotW;
    const y = yFor(d.wpm);
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  });
  ctx.stroke();
  data.forEach((d, i) => {
    const x = pad.l + (i / Math.max(1, data.length - 1)) * plotW;
    const y = yFor(d.wpm);
    ctx.fillStyle = "#7c3aed";
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    if (i % Math.max(1, Math.ceil(data.length / 6)) === 0 || i === data.length - 1) {
      ctx.fillStyle = "#667085";
      ctx.textAlign = "center";
      ctx.font = "11px Arial";
      ctx.fillText(d.time, x, h - 24);
    }
  });
}

function renderSummary() {
  const a = state.analysis;
  if (!a) {
    $("tabBody").innerHTML = `<section class="empty">분석 후 종합 결과가 표시됩니다.</section>`;
    return;
  }
  const problems = cleanProblems(a.problems || []);
  const priorities = cleanPriorities(a.improvement_priorities || []);
  const summaryQuestions = cleanQuestions(a.questions || []);
  const llmFailed = Boolean(a.llm_error);
  const llmUnavailable = "<p class='muted'>AI 평가 실패로 제공되지 않습니다.</p>";
  const llmErrorCard = llmFailed ? card("AI 종합평가 실패", `<p>${html(a.llm_error)}</p><p class="muted">전사문과 Python 측정 지표는 분석 결과 탭에서 확인할 수 있습니다.</p>`, "full") : "";
  const documentBlock = a.document_match?.available
    ? card("자료 간 매칭 분석", renderDocumentMatch(a.document_match), "full")
    : card("자료 간 매칭 분석", "<p class='muted'>PPT/PDF 발표자료를 함께 업로드하면 음성 전사와 자료 일치율을 비교합니다.</p>", "full");
  $("tabBody").innerHTML = `
    ${llmErrorCard}
    ${documentBlock}
    <section class="analysis-grid">
      ${card("발견된 문제점", llmFailed ? llmUnavailable : problems.map((p) => `<div class="problem"><span class="tag">${html(p.level)}</span><b>${html(p.title)}</b><small>${html(p.fix)}</small></div>`).join("") || "<p class='muted'>문제점 없음</p>")}
      ${card("보완 사항", llmFailed ? llmUnavailable : priorities.map((p, i) => `<div class="priority"><b>${i + 1}. ${html(p.title || p.detail)}</b><span>${html(p.impact)}</span><small>${html(p.title ? p.detail : "")}</small></div>`).join("") || "<p class='muted'>보완 사항 없음</p>")}
    </section>
    ${card("AI 예상 심사위원 질문", llmFailed ? llmUnavailable : summaryQuestions.map((q, i) => `<div class="row"><span>${i + 1}</span><b>${html(q.category)}</b><p>${html(q.question)}</p><em>${html(q.level)}</em></div>`).join("") || "<p class='muted'>예상 질문 없음</p>", "full")}
    ${card("AI 종합 의견", `<p>${html(a.summary || "")}</p><div class="final-score"><b>${html(a.grade || "-")}</b><b>${llmFailed ? "-" : html(a.score) + "/100"}</b><b>${html(a.status)}</b></div>`, "full glow")}`;
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
  if (state.view === "home") renderHome();
  if (state.view === "demo") renderDemo();
}

document.addEventListener("dragover", (event) => event.preventDefault());
document.addEventListener("drop", (event) => event.preventDefault());

render();
