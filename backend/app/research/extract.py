"""Turn uploaded/fetched bytes into text sections (with page numbers for PDFs).

PDFs with an embedded text layer use pypdf. Pages with no usable text are rendered
with PyMuPDF and read with Tesseract OCR, so scanned filings can be indexed. OCR
is bounded by ``AUREX_OCR_MAX_PAGES`` and labeled in the returned ``ocr_pages``.
"""

import io
import logging
from dataclasses import dataclass, field

from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation
from app.research.text import html_to_text, normalise

log = logging.getLogger("aurex.research.extract")

MAX_BYTES = 10 * 1024 * 1024
MAX_PDF_PAGES = 400
MIN_TEXT_CHARS = 20                    # below this a page is treated as scanned


@dataclass
class Section:
    text: str
    page: int | None = None


@dataclass
class Extracted:
    title: str
    sections: list[Section]
    content_type: str
    ocr_pages: list[int] = field(default_factory=list)


def _ocr_pages(data: bytes, pages: list[int], dpi: int, language: str) -> dict[int, str]:
    """Render selected 1-based PDF pages and OCR them. Failures degrade to no text."""
    if not pages:
        return {}
    try:
        import pymupdf
        import pytesseract
        from PIL import Image
    except ImportError as e:
        log.warning("OCR dependencies missing: %s", e)
        return {}
    out: dict[int, str] = {}
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
        for page_no in pages:
            if page_no > len(doc):
                continue
            try:
                pix = doc[page_no - 1].get_pixmap(dpi=dpi, alpha=False)
                image = Image.open(io.BytesIO(pix.tobytes("png")))
                text = pytesseract.image_to_string(image, lang=language, config="--psm 3")
                if text.strip():
                    out[page_no] = normalise(text)
            except Exception as e:  # noqa: BLE001 - one bad page must not fail ingestion
                log.warning("OCR failed on page %s: %s", page_no, e.__class__.__name__)
        doc.close()
    except Exception as e:  # noqa: BLE001 - damaged/incompatible PDFs keep their text layer
        log.warning("OCR could not open PDF: %s", e.__class__.__name__)
    return out


def sniff(content_type: str | None, filename: str | None, data: bytes) -> str:
    ct = (content_type or "").split(";")[0].strip().lower()
    name = (filename or "").lower()
    if data[:5] == b"%PDF-" or ct == "application/pdf" or name.endswith(".pdf"):
        return "application/pdf"
    head = data[:512].lstrip().lower()
    if ct in ("text/html", "application/xhtml+xml") or name.endswith((".html", ".htm")) \
            or head.startswith((b"<!doctype html", b"<html")):
        return "text/html"
    if ct in ("application/rss+xml", "application/atom+xml") or head.startswith(b"<?xml") \
            and (b"<rss" in data[:2048] or b"<feed" in data[:2048]):
        return "application/rss+xml"
    if ct.startswith("text/") or name.endswith((".txt", ".md")) or not ct:
        return "text/plain"
    raise BusinessRuleViolation(f"Unsupported content type {ct or 'unknown'}")


def _decode(data: bytes) -> str:
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def extract(data: bytes, content_type: str, fallback_title: str = "") -> Extracted:
    if len(data) > MAX_BYTES:
        raise BusinessRuleViolation("Document exceeds the 10 MB limit")
    if content_type == "application/pdf":
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError

        try:
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                raise BusinessRuleViolation("Encrypted PDFs are not supported")
            pages = reader.pages[:MAX_PDF_PAGES]
            sections = [Section(normalise(p.extract_text() or ""), i + 1)
                        for i, p in enumerate(pages)]
            meta_title = (reader.metadata.title if reader.metadata else None) or ""
        except PdfReadError as e:
            raise BusinessRuleViolation(f"Could not read PDF: {e}") from e
        s = get_settings()
        ocr_pages: list[int] = []
        if s.ocr_enabled:
            candidates = [i + 1 for i, sec in enumerate(sections)
                          if len(sec.text.strip()) < MIN_TEXT_CHARS][: s.ocr_max_pages]
            recognised = _ocr_pages(data, candidates, s.ocr_dpi, s.ocr_language)
            for page_no, text in recognised.items():
                sections[page_no - 1] = Section(text, page_no)
                ocr_pages.append(page_no)
        sections = [sec for sec in sections if sec.text]
        if not sections:
            raise BusinessRuleViolation(
                "No extractable text in PDF, and OCR found no text")
        return Extracted(meta_title.strip() or fallback_title, sections, content_type, ocr_pages)
    if content_type == "text/html":
        title, text = html_to_text(_decode(data))
        return Extracted(title or fallback_title, [Section(text)], content_type)
    text = normalise(_decode(data))
    return Extracted(fallback_title, [Section(text)], "text/plain")
