# -*- coding: utf-8 -*-
"""
논문 통계 독립 검증 스크립트 (verify_paper_stats.py)
====================================================
목적: Claude(챗)가 계산해 논문에 실은 모든 수치를, 회사 시스템에서
      원본 CSV로부터 처음부터 재계산하여 일치 여부를 O/X로 판정한다.

입력: stt_model_transcripts_and_cer_details.csv  (evaluation/results/ 안)
실행: python3 verify_paper_stats.py [CSV경로]
출력: 화면 O/X 판정 + verification_report.txt

의존성: numpy, scipy  (pip install numpy scipy)
"""
import sys, csv, re, itertools
from pathlib import Path
from collections import Counter
import numpy as np
from scipy import stats as st

ENGINES = ["clova", "azure", "whisper", "google", "assemblyai"]

# ---------------- 논문에 실린 기대값 (Claude 계산분) ----------------
EXPECTED = {
    "repro_matches": 100,           # 기존 파이프라인 재현 (100행 전부)
    "n_files": 20,
    "cer_mean": {"clova": 4.65, "azure": 5.76, "whisper": 7.89, "google": 6.70, "assemblyai": 8.70},
    "cer_sd":   {"clova": 3.75, "azure": 4.07, "whisper": 6.46, "google": 4.51, "assemblyai": 6.46},
    "cer_friedman_chi2": 5.749, "cer_friedman_p": 0.2187, "cer_kendall_w": 0.072,
    "cer_ranks": {"clova": 2.00, "azure": 2.65, "whisper": 2.95, "google": 3.35, "assemblyai": 4.05},
    "cer_holm_sig_pairs": 0,        # 유의쌍 없음
    "fpr_n_files": 10,
    "fpr_mean": {"clova": 86.7, "azure": 92.5, "whisper": 19.2, "google": 84.2, "assemblyai": 2.5},
    "fpr_friedman_chi2": 34.692, "fpr_friedman_p": 5.374e-07, "fpr_kendall_w": 0.867,
    # FPR 유의쌍(Holm<0.05): 보존군{clova,azure,google} x 삭제군{whisper,assemblyai} 교차 6쌍
    "fpr_holm_sig_pairs": 6,
}

# ---------------- 파이프라인과 동일한 정규화 ----------------
def their_norm(t: str) -> str:
    """run_stt_model_cer_benchmark.py 의 normalize_text 와 동일."""
    t = (t or "").lower()
    t = re.sub(r"\s+", "", t)
    return re.sub(r"[^0-9a-z가-힣]", "", t)

def clean_ref(t: str) -> str:
    """교정: 이중전사→철자형, 잡음코드 제거, 간투어 슬래시 해소 (논문 §5)."""
    t = re.sub(r"\(([^)]*)\)/\(([^)]*)\)", r"\1", t or "")
    t = re.sub(r"\b[bnlou]/", " ", t)
    return t.replace("/", " ")

def lev(a: str, b: str) -> int:
    n, m = len(a), len(b)
    d = np.zeros((n + 1, m + 1), dtype=np.int32)
    d[:, 0] = np.arange(n + 1); d[0, :] = np.arange(m + 1)
    for i in range(1, n + 1):
        ai = a[i - 1]
        for j in range(1, m + 1):
            d[i, j] = min(d[i-1, j] + 1, d[i, j-1] + 1, d[i-1, j-1] + (ai != b[j-1]))
    return int(d[n, m])

CODES = {"b", "n", "l", "o", "u"}
def ref_fillers(t: str):
    t = re.sub(r"\(([^)]*)\)/\(([^)]*)\)", r"\1", t or "")
    return [x for x in re.findall(r"([가-힣]+)/", t) if x not in CODES]

def holm(ps):
    order = np.argsort(ps); m = len(ps); adj = [0.0]*m; mx = 0.0
    for k, idx in enumerate(order):
        mx = max(mx, ps[idx] * (m - k)); adj[idx] = min(mx, 1.0)
    return adj

def check(name, got, want, tol, lines):
    ok = abs(got - want) <= tol
    lines.append(f"  [{'O' if ok else 'X'}] {name}: 계산값={got:.4g}  논문값={want:.4g}")
    return ok

def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if path is None:
        for cand in [Path("stt_model_transcripts_and_cer_details.csv"),
                     Path("evaluation/results/stt_model_transcripts_and_cer_details.csv"),
                     Path("results/stt_model_transcripts_and_cer_details.csv")]:
            if cand.exists(): path = cand; break
    if path is None or not path.exists():
        print("CSV를 찾지 못했습니다. 사용법: python3 verify_paper_stats.py <details CSV 경로>"); sys.exit(1)

    rows = [r for r in csv.DictReader(open(path, encoding="utf-8-sig")) if r["audio_id"] != "AVERAGE"]
    lines = [f"검증 대상: {path}", f"행 수(AVERAGE 제외): {len(rows)}", ""]
    allok = True

    # ---- 1단계: 기존 파이프라인 재현 ----
    matches = 0
    for r in rows:
        ref, hyp = their_norm(r["reference_text"]), their_norm(r["hypothesis_text"])
        c = round(lev(ref, hyp) / len(ref) * 100, 2) if ref else 0.0
        matches += abs(c - float(r["cer"])) <= 0.02
    lines.append(f"1단계 — 기존 파이프라인 재현: {matches}/{len(rows)} 행 일치")
    allok &= check("재현 일치 수", matches, EXPECTED["repro_matches"], 0, lines); lines.append("")

    # ---- 2단계: 교정 CER (N=20) ----
    data = {}
    for r in rows:
        ref = their_norm(clean_ref(r["reference_text"])); hyp = their_norm(r["hypothesis_text"])
        data.setdefault(r["audio_id"], {})[r["engine"]] = lev(ref, hyp) / len(ref) * 100
    ids = sorted(data); M = np.array([[data[i][e] for i in ids] for e in ENGINES])
    lines.append(f"2단계 — 교정 CER (N={len(ids)})")
    allok &= check("파일 수 N", len(ids), EXPECTED["n_files"], 0, lines)
    for i, e in enumerate(ENGINES):
        allok &= check(f"{e} 평균CER%", M[i].mean(), EXPECTED["cer_mean"][e], 0.01, lines)
        allok &= check(f"{e} SD", M[i].std(ddof=1), EXPECTED["cer_sd"][e], 0.01, lines)
    fr = st.friedmanchisquare(*M); W = fr.statistic / (len(ids) * 4)
    allok &= check("CER Friedman chi2", fr.statistic, EXPECTED["cer_friedman_chi2"], 0.01, lines)
    allok &= check("CER Friedman p", fr.pvalue, EXPECTED["cer_friedman_p"], 0.001, lines)
    allok &= check("CER Kendall W", W, EXPECTED["cer_kendall_w"], 0.005, lines)
    ranks = np.mean(np.argsort(np.argsort(M, axis=0), axis=0) + 1, axis=1)
    for e, rk in zip(ENGINES, ranks):
        allok &= check(f"{e} 평균순위", rk, EXPECTED["cer_ranks"][e], 0.01, lines)
    ps = []
    for i, j in itertools.combinations(range(5), 2):
        try: ps.append(st.wilcoxon(M[i], M[j]).pvalue)
        except ValueError: ps.append(1.0)
    nsig = sum(1 for a in holm(ps) if a < 0.05)
    allok &= check("CER Holm 유의쌍 수", nsig, EXPECTED["cer_holm_sig_pairs"], 0, lines); lines.append("")

    # ---- 3단계: FPR ----
    fp = {}
    for r in rows:
        F = ref_fillers(r["reference_text"])
        if not F: continue
        cf, ch = Counter(F), Counter(re.findall(r"[가-힣]+", r["hypothesis_text"] or ""))
        fp.setdefault(r["audio_id"], {})[r["engine"]] = sum(min(cf[t], ch[t]) for t in cf) / len(F)
    fids = sorted(fp); FM = np.array([[fp[i][e] for i in fids] for e in ENGINES])
    lines.append(f"3단계 — 필러 보존율 FPR (필러 파일 N={len(fids)})")
    allok &= check("FPR 파일 수", len(fids), EXPECTED["fpr_n_files"], 0, lines)
    for i, e in enumerate(ENGINES):
        allok &= check(f"{e} 평균FPR%", FM[i].mean() * 100, EXPECTED["fpr_mean"][e], 0.1, lines)
    frf = st.friedmanchisquare(*FM); Wf = frf.statistic / (len(fids) * 4)
    allok &= check("FPR Friedman chi2", frf.statistic, EXPECTED["fpr_friedman_chi2"], 0.01, lines)
    allok &= check("FPR Kendall W", Wf, EXPECTED["fpr_kendall_w"], 0.005, lines)
    ok_p = frf.pvalue < 1e-5
    lines.append(f"  [{'O' if ok_p else 'X'}] FPR Friedman p < 1e-5: 계산값={frf.pvalue:.3g}")
    allok &= ok_p
    psf = []
    for i, j in itertools.combinations(range(5), 2):
        try: psf.append(st.wilcoxon(FM[i], FM[j]).pvalue)
        except ValueError: psf.append(1.0)
    nsigf = sum(1 for a in holm(psf) if a < 0.05)
    allok &= check("FPR Holm 유의쌍 수", nsigf, EXPECTED["fpr_holm_sig_pairs"], 0, lines)

    lines += ["", "=" * 46,
              "최종 판정: " + ("전 항목 일치 — 논문 수치 검증 통과 (O)" if allok
                              else "불일치 항목 존재 — 위 X 항목을 Claude에게 회신 (X)"),
              "=" * 46]
    report = "\n".join(lines)
    print(report)
    Path("verification_report.txt").write_text(report, encoding="utf-8")
    print("\n저장됨: verification_report.txt")

if __name__ == "__main__":
    main()
