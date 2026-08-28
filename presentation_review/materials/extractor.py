import re
import zipfile
from io import BytesIO
from typing import Any
from xml.etree import ElementTree as ET


def extract_pptx_text(data: bytes) -> list[dict[str, Any]]:
    slides: list[dict[str, Any]] = []
    try:
        with zipfile.ZipFile(BytesIO(data)) as archive:
            names = sorted(
                [name for name in archive.namelist() if re.match(r"ppt/slides/slide\d+\.xml$", name)],
                key=lambda value: int(re.search(r"slide(\d+)\.xml$", value).group(1)),
            )
            ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
            for idx, name in enumerate(names, 1):
                root = ET.fromstring(archive.read(name))
                texts = [node.text.strip() for node in root.findall(".//a:t", ns) if node.text and node.text.strip()]
                text = " ".join(texts).strip()
                if text:
                    slides.append({"page": idx, "title": f"Slide {idx}", "text": text})
    except Exception:
        return []
    return slides


def extract_pdf_text(data: bytes) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    try:
        try:
            from pypdf import PdfReader
        except Exception:
            from PyPDF2 import PdfReader

        reader = PdfReader(BytesIO(data))
        for idx, page in enumerate(reader.pages, 1):
            text = (page.extract_text() or "").strip()
            if text:
                pages.append({"page": idx, "title": f"Page {idx}", "text": re.sub(r"\s+", " ", text)})
    except Exception:
        return []
    return pages


def extract_material_text(material: Any | None) -> dict[str, Any]:
    if not material:
        return {"name": "", "type": "", "sections": [], "text": "", "error": ""}

    name = str(getattr(material, "name", "") or "uploaded-document")
    suffix = name.lower().rsplit(".", 1)[-1] if "." in name else ""
    data = material.getvalue()
    sections: list[dict[str, Any]] = []
    error = ""

    if suffix == "pptx":
        sections = extract_pptx_text(data)
        if not sections:
            error = "PPTX 텍스트를 추출하지 못했습니다. 이미지로만 구성된 자료일 수 있습니다."
    elif suffix == "pdf":
        sections = extract_pdf_text(data)
        if not sections:
            error = "PDF 텍스트를 추출하지 못했습니다. 스캔 이미지 PDF이거나 PDF 파서가 필요합니다."
    else:
        error = "지원하는 자료 형식은 PDF 또는 PPTX입니다."

    text = "\n".join(section.get("text", "") for section in sections).strip()
    return {"name": name, "type": suffix.upper(), "sections": sections, "text": text, "error": error}
