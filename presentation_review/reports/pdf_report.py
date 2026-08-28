from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Any


BUNDLED_KOREAN_FONT = Path(__file__).resolve().parents[2] / "app" / "assets" / "fonts" / "NotoSansKR-Regular.ttf"

KOREAN_FONT_CANDIDATES = [
    str(BUNDLED_KOREAN_FONT),  # 저장소 번들 폰트 — OS 에 한글 폰트가 없어도 PDF 한글 렌더링 보장
    "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
    "/System/Library/Fonts/Supplemental/NotoSansGothic-Regular.ttf",
    "/Library/Fonts/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/malgun.ttf",
]


def text_value(value: Any, default: str = "-") -> str:
    if value is None:
        return default
    if isinstance(value, (str, int, float, bool)):
        text = str(value).strip()
        return text if text else default
    if isinstance(value, list):
        text = ", ".join(text_value(item, "") for item in value)
        return text.strip(", ") or default
    if isinstance(value, dict):
        for key in ("title", "question", "detail", "fix", "summary", "text", "value", "name"):
            if value.get(key):
                return text_value(value.get(key), default)
    return default


def clipped(value: Any, limit: int = 600) -> str:
    text = text_value(value, "")
    return text[:limit] + ("..." if len(text) > limit else "")


def register_korean_font() -> str:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    for font_path in KOREAN_FONT_CANDIDATES:
        if Path(font_path).exists():
            pdfmetrics.registerFont(TTFont("ReportKorean", font_path))
            return "ReportKorean"
    return "Helvetica"


def paragraph(text: Any, style):
    from reportlab.platypus import Paragraph

    escaped = (
        text_value(text, "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "<br/>")
    )
    return Paragraph(escaped or "-", style)


def metric_table(analysis: dict[str, Any], styles):
    from reportlab.platypus import Table
    from reportlab.lib import colors

    match = analysis.get("document_match") if isinstance(analysis.get("document_match"), dict) else {}
    rows = [
        ["종합 점수", f"{text_value(analysis.get('score'))}/100"],
        ["등급", text_value(analysis.get("grade"))],
        ["상태", text_value(analysis.get("status"))],
        ["평균 WPM", text_value(analysis.get("wpm"))],
        ["추임새", f"{text_value(analysis.get('filler_total'), '0')}회"],
        ["자료 일치율", f"{text_value(match.get('score'))}%" if match.get("available") else "자료 없음"],
    ]
    table = Table([[paragraph(a, styles["CellHead"]), paragraph(b, styles["Cell"])] for a, b in rows], colWidths=[95, 360])
    table.setStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#EEF2FF")),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.HexColor("#111827")),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D0D5DD")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ])
    return table


def bullet_section(title: str, items: Any, styles, limit: int = 6):
    from reportlab.platypus import Spacer

    flowables = [paragraph(title, styles["SectionTitle"])]
    rows = items if isinstance(items, list) else []
    if not rows:
        flowables.append(paragraph("표시할 항목이 없습니다.", styles["Muted"]))
    for index, item in enumerate(rows[:limit], 1):
        if isinstance(item, dict):
            main = text_value(item.get("title") or item.get("question") or item.get("original") or item.get("word"))
            detail = text_value(item.get("fix") or item.get("detail") or item.get("reason") or item.get("replacement"), "")
            prefix = text_value(item.get("level") or item.get("category") or item.get("impact"), "")
            line = f"{index}. {f'[{prefix}] ' if prefix else ''}{main}"
            if detail:
                line += f" - {detail}"
        else:
            line = f"{index}. {text_value(item)}"
        flowables.append(paragraph(line, styles["Body"]))
    flowables.append(Spacer(1, 8))
    return flowables


def build_report_pdf(analysis: dict[str, Any]) -> bytes:
    try:
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import SimpleDocTemplate, Spacer
    except ImportError as exc:
        raise RuntimeError("PDF 리포트 생성을 위해 reportlab 설치가 필요합니다. pip install -r requirements.txt 를 실행해 주세요.") from exc

    font_name = register_korean_font()
    base = getSampleStyleSheet()
    styles = {
        "Title": ParagraphStyle("ReportTitle", parent=base["Title"], fontName=font_name, fontSize=19, leading=25, textColor=colors.HexColor("#101828")),
        "SectionTitle": ParagraphStyle("SectionTitle", parent=base["Heading2"], fontName=font_name, fontSize=13, leading=18, spaceBefore=12, spaceAfter=6, textColor=colors.HexColor("#1D4ED8")),
        "Body": ParagraphStyle("ReportBody", parent=base["BodyText"], fontName=font_name, fontSize=9.5, leading=14, textColor=colors.HexColor("#111827")),
        "Muted": ParagraphStyle("Muted", parent=base["BodyText"], fontName=font_name, fontSize=9, leading=13, textColor=colors.HexColor("#667085")),
        "CellHead": ParagraphStyle("CellHead", parent=base["BodyText"], fontName=font_name, fontSize=9, leading=13, textColor=colors.HexColor("#344054")),
        "Cell": ParagraphStyle("Cell", parent=base["BodyText"], fontName=font_name, fontSize=9, leading=13, textColor=colors.HexColor("#111827")),
    }

    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=18 * mm,
        leftMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
        title="Presentation Review Report",
    )

    story = [
        paragraph("STT Presentation Review Report", styles["Title"]),
        paragraph(f"분석 파일: {text_value(analysis.get('audio_name'))}", styles["Muted"]),
        Spacer(1, 10),
        metric_table(analysis, styles),
        paragraph("종합 의견", styles["SectionTitle"]),
        paragraph(clipped(analysis.get("summary"), 1200), styles["Body"]),
    ]

    story.extend(bullet_section("발견된 문제점", analysis.get("problems"), styles))
    story.extend(bullet_section("개선 우선순위", analysis.get("improvement_priorities"), styles))
    story.extend(bullet_section("어휘 개선 제안", analysis.get("vocab_suggestions"), styles))
    story.extend(bullet_section("예상 심사위원 질문", analysis.get("questions"), styles, limit=10))

    transcript = clipped(analysis.get("transcript"), 1800)
    if transcript:
        story.extend([
            paragraph("전사문 요약", styles["SectionTitle"]),
            paragraph(transcript, styles["Body"]),
        ])

    doc.build(story)
    return buffer.getvalue()
