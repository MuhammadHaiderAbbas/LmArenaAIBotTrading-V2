import hashlib
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import BusinessRuleViolation, NotFound
from app.models import Instrument, ResearchChunk, ResearchDocument
from app.research import classify as cls
from app.research.chunking import chunk_sections
from app.research.embeddings import get_embedder
from app.research.extract import Extracted, Section
from app.research.samples import SAMPLES, SOURCE
from app.research.text import normalise, tokens

MAX_TEXT_CHARS = 2_000_000


@dataclass
class Evidence:
    chunk: ResearchChunk
    document: ResearchDocument
    score: float
    semantic: float | None
    lexical_rank: int | None

    def age_days(self, now: datetime) -> int | None:
        ref = self.document.published_at
        return None if ref is None else max(0, (now - ref).days)

    def stale(self, now: datetime) -> bool:
        age = self.age_days(now)
        limit = cls.STALE_AFTER_DAYS.get(self.document.doc_type, 365)
        return age is not None and age > limit


async def instrument_aliases(db: AsyncSession) -> dict[str, list[str]]:
    rows = await db.scalars(select(Instrument).where(Instrument.is_active.is_(True)))
    out: dict[str, list[str]] = {}
    for i in rows:
        names = {i.symbol, i.symbol.replace("/", "")}
        if i.asset_class == "CRYPTO":
            names |= {i.base_currency, i.asset.name}
        elif i.asset_class in ("STOCK", "ETF"):
            names |= {i.display_name, i.symbol.split(".")[0]}
        out[i.symbol] = sorted(names, key=len, reverse=True)
    return out


class ResearchService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.embedder = get_embedder()

    # -- ingestion -----------------------------------------------------------------
    async def ingest(
        self, extracted: Extracted, *, source_name: str, source_url: str | None,
        published_at: datetime | None, doc_type: str | None, created_by: uuid.UUID | None,
        is_sample: bool = False, ocr_pages: list[int] | None = None,
    ) -> tuple[ResearchDocument, bool]:
        """Returns (document, created). Identical content is deduplicated by hash."""
        full = "\n\n".join(s.text for s in extracted.sections)
        if len(full) > MAX_TEXT_CHARS:
            raise BusinessRuleViolation("Document text is too long")
        words = len(full.split())
        if words < 5:
            raise BusinessRuleViolation("Document has too little text to index")
        digest = hashlib.sha256(normalise(full).encode()).hexdigest()
        existing = await self.db.scalar(
            select(ResearchDocument).where(ResearchDocument.content_hash == digest))
        if existing:
            return existing, False

        title = (extracted.title or full.split("\n", 1)[0])[:300].strip() or "(untitled)"
        if doc_type and doc_type not in cls.DOC_TYPES:
            raise BusinessRuleViolation(f"doc_type must be one of {', '.join(cls.DOC_TYPES)}")
        aliases = await instrument_aliases(self.db)
        doc = ResearchDocument(
            title=title, source_name=source_name[:120], source_url=source_url,
            doc_type=doc_type or cls.classify(title, full), content_type=extracted.content_type,
            published_at=published_at, retrieved_at=datetime.now(UTC), content_hash=digest,
            word_count=words,
            page_count=max((s.page or 0 for s in extracted.sections), default=0) or None,
            ocr_pages=ocr_pages or [],
            symbols=cls.tag_instruments(f"{title}\n{full}", aliases),
            sentiment=cls.sentiment(full), is_sample=is_sample, created_by=created_by,
        )
        self.db.add(doc)
        await self.db.flush()
        chunks = chunk_sections(extracted.sections)
        vectors = self.embedder.embed([f"{title}\n{c.text}" for c in chunks])
        for c, v in zip(chunks, vectors, strict=True):
            self.db.add(ResearchChunk(
                document_id=doc.id, ordinal=c.ordinal, text=c.text, page=c.page,
                paragraph=c.paragraph, sentiment=cls.sentiment(c.text), embedding=v,
                embedding_model=self.embedder.name))
        await self.db.flush()
        return doc, True

    async def load_samples(self, created_by: uuid.UUID | None) -> int:
        now = datetime.now(UTC)
        created = 0
        for title, doc_type, age, body in SAMPLES:
            _, new = await self.ingest(
                Extracted(title, [Section(normalise(body))], "text/plain"),
                source_name=SOURCE, source_url=None, published_at=now - age,
                doc_type=doc_type, created_by=created_by, is_sample=True)
            created += new
        return created

    # -- reads ---------------------------------------------------------------------
    async def get(self, doc_id: uuid.UUID) -> ResearchDocument:
        doc = await self.db.get(ResearchDocument, doc_id)
        if doc is None:
            raise NotFound("Research document not found")
        return doc

    async def chunks_of(self, doc_id: uuid.UUID) -> list[ResearchChunk]:
        rows = await self.db.scalars(select(ResearchChunk).where(
            ResearchChunk.document_id == doc_id).order_by(ResearchChunk.ordinal))
        return list(rows)

    async def list_documents(self, *, q: str | None, doc_type: str | None, symbol: str | None,
                   limit: int, offset: int) -> tuple[list[ResearchDocument], int]:
        stmt = select(ResearchDocument)
        if q:
            stmt = stmt.where(func.lower(ResearchDocument.title).contains(q.lower()))
        if doc_type:
            stmt = stmt.where(ResearchDocument.doc_type == doc_type)
        if symbol:
            stmt = stmt.where(ResearchDocument.symbols.any(symbol))
        total = await self.db.scalar(select(func.count()).select_from(stmt.subquery()))
        rows = await self.db.scalars(stmt.order_by(
            ResearchDocument.published_at.desc().nulls_last(), ResearchDocument.created_at.desc())
            .limit(limit).offset(offset))
        return list(rows), int(total or 0)

    async def stats(self) -> dict:
        docs = await self.db.scalar(select(func.count()).select_from(ResearchDocument))
        chunks = await self.db.scalar(select(func.count()).select_from(ResearchChunk))
        return {"documents": int(docs or 0), "chunks": int(chunks or 0)}

    # -- retrieval -----------------------------------------------------------------
    async def search(self, query: str, *, k: int = 8, symbols: list[str] | None = None,
                     max_age_days: int | None = None, candidates: int = 40) -> list[Evidence]:
        """Hybrid retrieval: pgvector cosine + Postgres full text, fused with RRF (k=60)."""
        terms = [t for t in dict.fromkeys(tokens(query)) if re.fullmatch(r"[a-z0-9]+", t)]
        if not terms:
            raise BusinessRuleViolation("Query has no searchable terms")
        qvec = self.embedder.embed([query])[0]
        filters = ["1=1"]
        params: dict = {"qvec": str(qvec), "n": candidates, "model": self.embedder.name}
        if symbols:
            filters.append("d.symbols && CAST(:symbols AS varchar(32)[])")
            params["symbols"] = symbols
        if max_age_days:
            filters.append("d.published_at >= :since")
            params["since"] = datetime.now(UTC) - timedelta(days=max_age_days)
        where = " AND ".join(filters)
        semantic = (await self.db.execute(text(f"""
            SELECT c.id, 1 - (c.embedding <=> CAST(:qvec AS vector)) AS sim
            FROM research_chunks c JOIN research_documents d ON d.id = c.document_id
            WHERE {where} AND c.embedding_model = :model
            ORDER BY c.embedding <=> CAST(:qvec AS vector) LIMIT :n"""), params)).all()  # noqa: S608  # nosec B608 - fixed fragments, bound params
        params["tsq"] = " | ".join(terms[:30])
        lexical = (await self.db.execute(text(f"""
            SELECT c.id, ts_rank_cd(c.tsv, to_tsquery('english', :tsq)) AS r
            FROM research_chunks c JOIN research_documents d ON d.id = c.document_id
            WHERE {where} AND c.tsv @@ to_tsquery('english', :tsq)
            ORDER BY r DESC LIMIT :n"""), params)).all()  # noqa: S608  # nosec B608 - fixed fragments, bound params

        fused: dict[uuid.UUID, float] = {}
        sem_score = {row.id: float(row.sim) for row in semantic}
        lex_rank: dict[uuid.UUID, int] = {}
        for rank, row in enumerate(semantic):
            if row.sim > 0.05:
                fused[row.id] = fused.get(row.id, 0) + 1 / (60 + rank)
        for rank, row in enumerate(lexical):
            lex_rank[row.id] = rank
            fused[row.id] = fused.get(row.id, 0) + 1 / (60 + rank)
        top = sorted(fused, key=fused.__getitem__, reverse=True)[:k]
        if not top:
            return []
        chunks = {c.id: c for c in await self.db.scalars(
            select(ResearchChunk).where(ResearchChunk.id.in_(top)))}
        return [Evidence(chunks[i], chunks[i].document, round(fused[i] * 1000, 3),
                         sem_score.get(i), lex_rank.get(i)) for i in top if i in chunks]
