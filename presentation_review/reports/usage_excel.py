"""토큰 사용량 엑셀(xlsx) 생성. 외부 라이브러리 없이 표준 zipfile로 최소 OOXML을 만든다."""

import zipfile
from datetime import datetime
from io import BytesIO
from typing import Any
from xml.sax.saxutils import escape

from ..shared.token_usage import KST

_CONTENT_TYPES_HEAD = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>"""

_ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

_STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>"""


def _column_letter(index: int) -> str:
    letters = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def _cell_xml(row_number: int, column_index: int, value: Any) -> str:
    ref = f"{_column_letter(column_index)}{row_number}"
    if value is None or value == "":
        return f'<c r="{ref}"/>'
    if isinstance(value, bool):
        value = "예" if value else "아니오"
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>'


def _sheet_xml(headers: list[str], rows: list[list[Any]]) -> str:
    all_rows = [headers] + rows
    body = "".join(
        f'<row r="{row_index}">' + "".join(_cell_xml(row_index, col, value) for col, value in enumerate(row)) + "</row>"
        for row_index, row in enumerate(all_rows, start=1)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{body}</sheetData></worksheet>"
    )


def build_xlsx(sheets: list[tuple[str, list[str], list[list[Any]]]]) -> bytes:
    """sheets: [(시트이름, 헤더, 데이터행들), ...] — 최소 OOXML 통합문서를 만든다."""
    content_types = [_CONTENT_TYPES_HEAD]
    workbook_sheets = []
    workbook_rels = []
    for index, (name, _, _) in enumerate(sheets, start=1):
        content_types.append(
            f'<Override PartName="/xl/worksheets/sheet{index}.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
        workbook_sheets.append(f'<sheet name="{escape(name)}" sheetId="{index}" r:id="rId{index}"/>')
        workbook_rels.append(
            f'<Relationship Id="rId{index}" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{index}.xml"/>'
        )
    styles_rid = len(sheets) + 1
    workbook_rels.append(
        f'<Relationship Id="rId{styles_rid}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    )

    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<sheets>{"".join(workbook_sheets)}</sheets></workbook>'
    )
    workbook_rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'{"".join(workbook_rels)}</Relationships>'
    )

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "".join(content_types) + "</Types>")
        archive.writestr("_rels/.rels", _ROOT_RELS)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels_xml)
        archive.writestr("xl/styles.xml", _STYLES)
        for index, (_, headers, rows) in enumerate(sheets, start=1):
            archive.writestr(f"xl/worksheets/sheet{index}.xml", _sheet_xml(headers, rows))
    return buffer.getvalue()


_USAGE_HEADERS = ["미캐시입력토큰", "캐시읽기토큰", "캐시쓰기토큰(5m)", "캐시쓰기토큰(1h)", "출력토큰"]
_USAGE_FIELDS = ("uncached_input", "cache_read", "cache_write_5m", "cache_write_1h", "output")


def _usage_values(row: dict[str, Any]) -> list[Any]:
    return [row.get(field, 0) for field in _USAGE_FIELDS]


def _money(value: Any) -> Any:
    """비용은 Console 표기와 동일하게 소수점 2자리로 반올림한다."""
    return round(value, 2) if isinstance(value, (int, float)) else value


def _date_label(date: Any, today: str | None) -> Any:
    return f"{date} (오늘, 진행 중·추정)" if today and date == today else date


def _daily_sheet_rows(summary: dict[str, Any], today: str | None = None) -> list[list[Any]]:
    """일별 행 + 합계 행. 단가 미등록 모델이 섞인 날이 있으면 합계 비용은 비워 둔다."""
    daily = summary.get("daily") or []
    rows = [[_date_label(row.get("date"), today), *_usage_values(row), _money(row.get("est_cost_usd"))] for row in daily]
    if rows:
        known = [row.get("est_cost_usd") for row in daily if isinstance(row.get("est_cost_usd"), (int, float))]
        total_cost = _money(sum(known)) if len(known) == len(daily) else None
        rows.append(["합계", *_usage_values(summary.get("totals") or {}), total_cost])
    return rows


def _model_sheet_rows(summary: dict[str, Any]) -> list[list[Any]]:
    """모델별 행 + 합계 행. 단가 미등록 모델이 있으면 합계 비용은 비워 둔다."""
    models = summary.get("models") or []
    rows = [[row.get("model"), *_usage_values(row), _money(row.get("est_cost_usd"))] for row in models]
    if rows:
        known = [row.get("est_cost_usd") for row in models if isinstance(row.get("est_cost_usd"), (int, float))]
        total_cost = _money(sum(known)) if len(known) == len(models) else None
        rows.append(["합계", *_usage_values(summary.get("totals") or {}), total_cost])
    return rows


def build_org_usage_xlsx(report: dict[str, Any]) -> bytes:
    """Admin API 조회 결과(report)를 시트별로 담은 엑셀을 만든다."""
    matched = report.get("matched_key") or {}
    cost = report.get("cost") or {}
    org = report.get("org_usage") or {}
    key_usage = report.get("key_usage") or {}
    today = report.get("today_date")

    summary_rows: list[list[Any]] = [
        ["조회 기간", report.get("period_label") or "최근 30일"],
        ["생성 시각(KST)", datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S")],
        ["현재 서버 API 키", f"{matched.get('name', '-')} ({matched.get('hint', '-')})" if matched else "조직 키 목록에서 미확인"],
    ]
    if report.get("today_source") == "local_log":
        summary_rows.append(["오늘 사용량 출처", "서버 호출 로그 기반 추정 (Admin API 집계 지연 보완, 이 서버를 거친 호출만 포함)"])
    if "error" in cost:
        summary_rows.append(["voice-up 비용(USD)", f"조회 실패: {cost.get('error')}"])
    else:
        summary_rows.append(["voice-up 추정 비용(USD, 사용량×단가, 오늘 포함)", _money(cost.get("total_usd"))])
    if cost.get("note"):
        summary_rows.append(["비용 참고", cost.get("note")])
    summary_rows.append(["비고", "이 리포트는 voice-up API 키의 사용량만 담습니다. 추정비용(USD)은 사용일 기준 단가(sonnet-5 인트로 할인 반영)로 계산한 추정치이며, 배치 할인 등은 반영되지 않아 실제 청구액과 다를 수 있습니다. Cost API(실측 청구액)는 API 키별 필터를 지원하지 않아 사용하지 않습니다."])
    sheets: list[tuple[str, list[str], list[list[Any]]]] = [("요약", ["항목", "값"], summary_rows)]

    by_key_rows = [
        [row.get("name"), row.get("hint"), row.get("api_key_id"), *_usage_values(row), _money(row.get("est_cost_usd"))]
        for row in report.get("by_key") or []
    ]
    sheets.append(("API키별사용량", ["API키(voice-up)", "키힌트", "API키ID", *_USAGE_HEADERS, "추정비용(USD)"], by_key_rows))

    sheets.append(("모델별_voice-up", ["모델", *_USAGE_HEADERS, "추정비용(USD)"], _model_sheet_rows(org)))
    sheets.append(("일별_voice-up", ["날짜(UTC)", *_USAGE_HEADERS, "추정비용(USD)"], _daily_sheet_rows(org, today)))

    if matched and key_usage:
        sheets.append(("모델별_현재키", ["모델", *_USAGE_HEADERS, "추정비용(USD)"], _model_sheet_rows(key_usage)))
        sheets.append(("일별_현재키", ["날짜(UTC)", *_USAGE_HEADERS, "추정비용(USD)"], _daily_sheet_rows(key_usage, today)))

    if "error" not in cost:
        sheets.append((
            "추정비용_모델별",
            ["모델", "추정비용(USD)"],
            [[label, _money(value)] for label, value in (cost.get("by_model") or {}).items()],
        ))
        daily_cost_rows = [[_date_label(row.get("date"), today), _money(row.get("amount_usd"))] for row in cost.get("daily") or []]
        if daily_cost_rows:
            daily_cost_rows.append(["합계", _money(cost.get("total_usd"))])
        sheets.append(("추정비용_일별", ["날짜(UTC)", "추정비용(USD)"], daily_cost_rows))

    return build_xlsx(sheets)
