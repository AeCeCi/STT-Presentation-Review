# -*- coding: utf-8 -*-
"""
CER + Filler-Preservation benchmark kit (offline).
폴더 구조:
  refs/<파일명>.txt                # 정답 전사 (파일별 1개)
  hyps/<엔진명>/<파일명>.txt        # 엔진별 전사 (refs와 같은 파일명)
실행:  python3 compute_cer.py
출력:  results_per_file.csv, results_summary.csv, stats.txt, fig_cer_box.png
"""
import os, re, csv, itertools, unicodedata
import numpy as np
from scipy import stats as st

# ---------- 정규화 규칙 (논문 Methods에 그대로 기재할 것) ----------
NORM_REMOVE_SPACE = True      # 띄어쓰기 제거 (한국어 CER 표준적 처리)
NORM_REMOVE_PUNCT = True      # 문장부호 제거
FILLER_LEXICON = ["어", "아", "그", "음", "이제", "저기", "뭐"]  # §4와 동일하게 유지

def normalize(s, keep_fillers=True):
    s = unicodedata.normalize("NFC", s)
    if NORM_REMOVE_PUNCT:
        s = re.sub(r"[^\w\s가-힣]", "", s)
    if NORM_REMOVE_SPACE:
        s = re.sub(r"\s+", "", s)
    return s

def cer(ref, hyp):
    r, h = normalize(ref), normalize(hyp)
    n, m = len(r), len(h)
    if n == 0: return float("nan")
    d = np.zeros((n+1, m+1), dtype=np.int32)
    d[:,0] = np.arange(n+1); d[0,:] = np.arange(m+1)
    for i in range(1, n+1):
        for j in range(1, m+1):
            c = 0 if r[i-1]==h[j-1] else 1
            d[i,j] = min(d[i-1,j]+1, d[i,j-1]+1, d[i-1,j-1]+c)
    return d[n,m]/n

def filler_preservation(ref, hyp):
    """정답에 등장한 필러 토큰 중 가설 전사에 보존된 비율(재현율)."""
    def count(s):
        toks = re.findall(r"[가-힣]+", s)
        return sum(1 for t in toks for f in FILLER_LEXICON if t==f)
    fr = count(ref)
    if fr == 0: return float("nan")
    fh = count(hyp)
    return min(fh, fr)/fr   # 보수적: 과잉 삽입은 1.0 상한

def main():
    engines = sorted(os.listdir("hyps"))
    files = sorted(f for f in os.listdir("refs") if f.endswith(".txt"))
    assert engines and files, "refs/ 와 hyps/<engine>/ 에 파일을 넣으세요"
    refs = {f: open(f"refs/{f}", encoding="utf-8").read() for f in files}

    per = []  # rows: file, engine, CER, FPR
    for e in engines:
        for f in files:
            p = f"hyps/{e}/{f}"
            if not os.path.exists(p):
                print(f"[경고] 누락: {p}"); continue
            hyp = open(p, encoding="utf-8").read()
            per.append([f, e, cer(refs[f], hyp), filler_preservation(refs[f], hyp)])

    with open("results_per_file.csv","w",newline="",encoding="utf-8-sig") as fp:
        w=csv.writer(fp); w.writerow(["file","engine","CER","FPR"]); w.writerows(per)

    # summary
    summ=[]
    for e in engines:
        c=[r[2] for r in per if r[1]==e and not np.isnan(r[2])]
        fpr=[r[3] for r in per if r[1]==e and not np.isnan(r[3])]
        ci=1.96*np.std(c,ddof=1)/np.sqrt(len(c)) if len(c)>1 else 0
        summ.append([e,len(c),np.mean(c)*100,np.std(c,ddof=1)*100,
                     (np.mean(c)-ci)*100,(np.mean(c)+ci)*100,
                     np.mean(fpr)*100 if fpr else float("nan")])
    with open("results_summary.csv","w",newline="",encoding="utf-8-sig") as fp:
        w=csv.writer(fp)
        w.writerow(["engine","N","meanCER%","SD%","CI95_lo%","CI95_hi%","FPR%"])
        w.writerows([[s[0],s[1]]+[f"{x:.2f}" for x in s[2:]] for s in summ])

    # Friedman + pairwise Wilcoxon (Holm)
    mat = np.array([[dict((r[0],r[2]) for r in per if r[1]==e)[f] for f in files] for e in engines])
    out=[]
    if len(engines) >= 3:
        fr = st.friedmanchisquare(*[mat[i] for i in range(len(engines))])
        out.append(f"Friedman chi2={fr.statistic:.3f}, p={fr.pvalue:.4g}  (N={len(files)} files x {len(engines)} engines)")
    else:
        out.append(f"[참고] 엔진 {len(engines)}개 — Friedman은 3개 이상에서 산출됩니다. 쌍별 Wilcoxon만 보고.")
    pairs=list(itertools.combinations(range(len(engines)),2))
    ps=[]
    for i,j in pairs:
        try: p=st.wilcoxon(mat[i],mat[j]).pvalue
        except ValueError: p=1.0
        ps.append(p)
    order=np.argsort(ps); m=len(ps); adj=[None]*m; mx=0
    for k,idx in enumerate(order):
        mx=max(mx, ps[idx]*(m-k)); adj[idx]=min(mx,1.0)
    for (i,j),p,a in zip(pairs,ps,adj):
        out.append(f"{engines[i]} vs {engines[j]}: p={p:.4g}  Holm-adj={a:.4g}")
    open("stats.txt","w",encoding="utf-8").write("\n".join(out))
    print("\n".join(out))

    # boxplot
    import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
    fig,ax=plt.subplots(figsize=(7.5,4),dpi=140)
    ax.boxplot([mat[i]*100 for i in range(len(engines))], labels=engines, showmeans=True)
    ax.set_ylabel("CER (%)"); ax.set_title("Per-file CER distribution by engine")
    plt.xticks(rotation=15); plt.tight_layout(); plt.savefig("fig_cer_box.png")
    print("saved: results_per_file.csv / results_summary.csv / stats.txt / fig_cer_box.png")

if __name__=="__main__":
    main()
