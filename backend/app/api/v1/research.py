import asyncio
import time
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import current_user, get_audit_context, require_admin
from app.core.config import get_settings
from app.core.errors import BusinessRuleViolation, NotFound, RateLimited
from app.core.rate_limit import SlidingWindowLimiter
from app.database.session import get_db
from app.market.service import MarketService, ProviderUnavailable
from app.models import ResearchDocument, ResearchReport, User
from app.research import extract as ex
from app.research import fetch as rf
from app.research.classify import DOC_TYPES
from app.research.embeddings import get_embedder
from app.research.fundamentals import FundamentalService
from app.research.llm import claude_draft, credential_status
from app.research.reports import build_report, extractive_draft
from app.research.service import ResearchService
from app.research.text import normalise
from app.schemas.common import Page
from app.schemas.research import (
    AskRequest,
    ChunkRead,
    DocumentCreate,
    DocumentDetail,
    DocumentRead,
    FetchRequest,
    FundamentalAnalysisRead,
    IngestResult,
    ReportRead,
    ReportSummary,
    ResearchStatus,
    SearchHit,
)
from app.services.audit_service import AuditContext, AuditService

router = APIRouter(prefix="/research", tags=["research"])
ask_limiter = SlidingWindowLimiter("research_ask")
DOC_RESOURCE = "research_document"


@router.get("/fundamentals", response_model=FundamentalAnalysisRead)
async def fundamentals(symbol: str = Query(..., max_length=32),
                       _: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    """Ratios/valuation with explicit provenance; never silently mixes vendor and parsed figures."""
    market = MarketService(db)
    inst = await market.get(symbol)
    try:
        last = float((await market.quote(inst)).last)
    except ProviderUnavailable:
        last = None
    analysis = await FundamentalService().analyse(inst, last, db)
    return FundamentalAnalysisRead.model_validate(analysis.as_dict())


@router.get("/status", response_model=ResearchStatus)
async def research_status(_: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    s = get_settings()
    stats = await ResearchService(db).stats()
    creds = credential_status()
    return ResearchStatus(
        engine=s.research_engine, model=s.llm_model if s.research_engine == "claude" else None,
        llm_key_configured=creds["configured"], llm_key_source=creds["source"],
        embedding_model=get_embedder().name, url_ingestion_enabled=bool(s.research_allowed_hosts),
        **stats)


# --- corpus ------------------------------------------------------------------------------
@router.get("/documents", response_model=Page[DocumentRead])
async def list_documents(
    q: str | None = Query(None, max_length=100), doc_type: str | None = Query(None),
    symbol: str | None = Query(None, max_length=32),
    limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
    _: User = Depends(current_user), db: AsyncSession = Depends(get_db),
):
    if doc_type and doc_type not in DOC_TYPES:
        raise BusinessRuleViolation(f"doc_type must be one of {', '.join(DOC_TYPES)}")
    rows, total = await ResearchService(db).list_documents(
        q=q, doc_type=doc_type, symbol=symbol, limit=limit, offset=offset)
    return Page(items=rows, total=total, limit=limit, offset=offset)


@router.get("/documents/{doc_id}", response_model=DocumentDetail)
async def get_document(doc_id: uuid.UUID, _: User = Depends(current_user),
                       db: AsyncSession = Depends(get_db)):
    svc = ResearchService(db)
    doc = await svc.get(doc_id)
    return DocumentDetail(**DocumentRead.model_validate(doc).model_dump(),
                          chunks=[ChunkRead.model_validate(c) for c in await svc.chunks_of(doc_id)])


async def _finish(db: AsyncSession, ctx: AuditContext, docs: list[tuple[ResearchDocument, bool]],
                  via: str) -> IngestResult:
    created = [d for d, new in docs if new]
    for d in created:
        await AuditService(db).record(
            ctx, "research.document.add", resource_type=DOC_RESOURCE, resource_id=d.id,
            details={"title": d.title, "via": via})
    await db.commit()
    return IngestResult(created=len(created), duplicates=len(docs) - len(created),
                        documents=[DocumentRead.model_validate(d) for d, _ in docs])


@router.post("/documents", response_model=IngestResult, status_code=status.HTTP_201_CREATED)
async def add_document(data: DocumentCreate, admin: User = Depends(require_admin),
                       ctx: AuditContext = Depends(get_audit_context),
                       db: AsyncSession = Depends(get_db)):
    if bool(data.text) == bool(data.html):
        raise BusinessRuleViolation("Provide exactly one of `text` or `html`")
    if data.html:
        extracted = ex.extract(data.html.encode(), "text/html", data.title)
        extracted.title = data.title
    else:
        extracted = ex.Extracted(data.title, [ex.Section(normalise(data.text or ""))], "text/plain")
    doc = await ResearchService(db).ingest(
        extracted, source_name=data.source_name, source_url=data.source_url,
        published_at=data.published_at, doc_type=data.doc_type, created_by=admin.id,
        ocr_pages=extracted.ocr_pages)
    return await _finish(db, ctx, [doc], "manual")


@router.post("/documents/upload", response_model=IngestResult,
             status_code=status.HTTP_201_CREATED)
async def upload_document(
    file: UploadFile = File(...), source_name: str = Form(..., max_length=120),
    title: str | None = Form(None, max_length=300), published_at: datetime | None = Form(None),
    doc_type: str | None = Form(None), admin: User = Depends(require_admin),
    ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db),
):
    data = await file.read(ex.MAX_BYTES + 1)
    ctype = ex.sniff(file.content_type, file.filename, data)
    if ctype == "application/rss+xml":
        raise BusinessRuleViolation("Upload feeds via /research/documents/fetch")
    extracted = await asyncio.to_thread(ex.extract, data, ctype, title or (file.filename or "upload"))
    if title:
        extracted.title = title
    if published_at and published_at.tzinfo is None:
        published_at = published_at.replace(tzinfo=UTC)
    doc = await ResearchService(db).ingest(
        extracted, source_name=source_name, source_url=None, published_at=published_at,
        doc_type=doc_type, created_by=admin.id, ocr_pages=extracted.ocr_pages)
    return await _finish(db, ctx, [doc], f"upload:{ctype}")


@router.post("/documents/fetch", response_model=IngestResult, status_code=status.HTTP_201_CREATED)
async def fetch_document(data: FetchRequest, admin: User = Depends(require_admin),
                         ctx: AuditContext = Depends(get_audit_context),
                         db: AsyncSession = Depends(get_db)):
    """Ingest a web page, PDF or RSS/Atom feed from an allow-listed https host."""
    raw, header_ct = await rf.fetch(data.url)
    ctype = ex.sniff(header_ct, data.url, raw)
    host = data.url.split("/")[2]
    svc = ResearchService(db)
    results = []
    if ctype == "application/rss+xml":
        for item in rf.parse_feed(raw):
            try:
                results.append(await svc.ingest(
                    ex.Extracted(item.title, [ex.Section(item.text)], "text/plain"),
                    source_name=data.source_name or host, source_url=item.link,
                    published_at=item.published_at, doc_type=None, created_by=admin.id))
            except BusinessRuleViolation:
                continue  # e.g. an item with too little text
    else:
        extracted = await asyncio.to_thread(ex.extract, raw, ctype, data.url)
        results.append(await svc.ingest(
        extracted, source_name=data.source_name or host, source_url=data.url,
        published_at=None, doc_type=None, created_by=admin.id,
        ocr_pages=extracted.ocr_pages))
    return await _finish(db, ctx, results, "fetch")


@router.delete("/documents/{doc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_document(doc_id: uuid.UUID, _: User = Depends(require_admin),
                          ctx: AuditContext = Depends(get_audit_context),
                          db: AsyncSession = Depends(get_db)):
    doc = await ResearchService(db).get(doc_id)
    await AuditService(db).record(ctx, "research.document.delete", resource_type=DOC_RESOURCE,
                                  resource_id=doc.id, details={"title": doc.title})
    await db.delete(doc)
    await db.commit()


@router.post("/samples", response_model=IngestResult)
async def load_samples(admin: User = Depends(require_admin),
                       ctx: AuditContext = Depends(get_audit_context),
                       db: AsyncSession = Depends(get_db)):
    """Load the clearly-labelled FICTIONAL sample corpus (idempotent)."""
    created = await ResearchService(db).load_samples(admin.id)
    if created:
        await AuditService(db).record(ctx, "research.samples.load", details={"documents": created})
    await db.commit()
    rows = await db.scalars(select(ResearchDocument).where(ResearchDocument.is_sample.is_(True)))
    docs = list(rows)
    return IngestResult(created=created, duplicates=len(docs) - created,
                        documents=[DocumentRead.model_validate(d) for d in docs])


# --- retrieval & reports ---------------------------------------------------------------
@router.get("/search", response_model=list[SearchHit])
async def search(q: str = Query(min_length=2, max_length=300),
                 symbols: str | None = Query(None, max_length=200),
                 k: int = Query(8, ge=1, le=30),
                 _: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    syms = [s.strip() for s in (symbols or "").split(",") if s.strip()]
    now = datetime.now(UTC)
    hits = await ResearchService(db).search(q, k=k, symbols=syms or None)
    return [SearchHit(chunk_id=h.chunk.id, document=DocumentRead.model_validate(h.document),
                      text=h.chunk.text, page=h.chunk.page, paragraph=h.chunk.paragraph,
                      score=h.score, stale=h.stale(now)) for h in hits]


@router.post("/ask", response_model=ReportRead, status_code=status.HTTP_201_CREATED)
async def ask(data: AskRequest, user: User = Depends(current_user),
              ctx: AuditContext = Depends(get_audit_context), db: AsyncSession = Depends(get_db)):
    s = get_settings()
    if not await ask_limiter.hit(str(user.id), s.research_asks_per_hour, 3600):
        raise RateLimited("Research question limit reached for this hour")
    started = time.perf_counter()
    question = data.question.strip()
    evidence = await ResearchService(db).search(
        question, k=s.research_top_k, symbols=data.symbols or None,
        max_age_days=data.max_age_days)
    if not evidence:
        draft = None
    elif s.research_engine == "claude":
        draft = await claude_draft(question, evidence)
    else:
        draft = extractive_draft(question, evidence)
    body = build_report(question, evidence, draft)
    report = ResearchReport(
        user_id=user.id, question=question, symbols=data.symbols, engine=body["engine"],
        confidence=body["confidence"]["score"], insufficient_evidence=body["insufficient_evidence"],
        body=body, latency_ms=int((time.perf_counter() - started) * 1000))
    db.add(report)
    await db.flush()
    await AuditService(db).record(ctx, "research.ask", resource_type="research_report",
                                  resource_id=report.id,
                                  details={"engine": report.engine, "sources": len(evidence),
                                           "facts": len(body["facts"])})
    await db.commit()
    return ReportRead.model_validate(report, from_attributes=True)


@router.get("/reports", response_model=Page[ReportSummary])
async def list_reports(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0),
                       user: User = Depends(current_user), db: AsyncSession = Depends(get_db)):
    base = select(ResearchReport).where(ResearchReport.user_id == user.id)
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    rows = await db.scalars(base.order_by(ResearchReport.created_at.desc()).limit(limit)
                            .offset(offset))
    return Page(items=[ReportSummary.model_validate(r, from_attributes=True) for r in rows],
                total=int(total or 0), limit=limit, offset=offset)


@router.get("/reports/{report_id}", response_model=ReportRead)
async def get_report(report_id: uuid.UUID, user: User = Depends(current_user),
                     db: AsyncSession = Depends(get_db)):
    r = await db.get(ResearchReport, report_id)
    if r is None or r.user_id != user.id:
        raise NotFound("Report not found")
    return ReportRead.model_validate(r, from_attributes=True)
