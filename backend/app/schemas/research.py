import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.schemas.common import ORMModel


class DocumentRead(ORMModel):
    id: uuid.UUID
    title: str
    source_name: str
    source_url: str | None
    doc_type: str
    content_type: str
    published_at: datetime | None
    retrieved_at: datetime
    word_count: int
    page_count: int | None
    ocr_pages: list[int] = []
    symbols: list[str]
    sentiment: float
    is_sample: bool


class ChunkRead(ORMModel):
    id: uuid.UUID
    ordinal: int
    text: str
    page: int | None
    paragraph: int
    sentiment: float


class DocumentDetail(DocumentRead):
    chunks: list[ChunkRead]


class DocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    text: str | None = Field(default=None, max_length=2_000_000)
    html: str | None = Field(default=None, max_length=5_000_000)
    source_name: str = Field(min_length=1, max_length=120)
    source_url: str | None = Field(default=None, max_length=1000, pattern=r"^https?://")
    published_at: datetime | None = None
    doc_type: str | None = None

    @field_validator("published_at")
    @classmethod
    def _tz(cls, v: datetime | None) -> datetime | None:
        if v is not None and v.tzinfo is None:
            raise ValueError("published_at must include a timezone")
        return v


class IngestResult(BaseModel):
    created: int
    duplicates: int
    documents: list[DocumentRead]


class FetchRequest(BaseModel):
    url: str = Field(max_length=1000)
    source_name: str | None = Field(default=None, max_length=120)


class SearchHit(BaseModel):
    chunk_id: uuid.UUID
    document: DocumentRead
    text: str
    page: int | None
    paragraph: int
    score: float
    stale: bool


class AskRequest(BaseModel):
    question: str = Field(min_length=3, max_length=1000)
    symbols: list[str] = Field(default_factory=list, max_length=10)
    max_age_days: int | None = Field(default=None, ge=1, le=3650)


class ReportSummary(BaseModel):
    id: uuid.UUID
    question: str
    symbols: list[str]
    engine: str
    confidence: float
    insufficient_evidence: bool
    created_at: datetime


class ReportRead(ReportSummary):
    body: dict[str, Any]
    latency_ms: int


class FundamentalAnalysisRead(BaseModel):
    symbol: str
    source: str
    as_of: datetime
    ratios: dict[str, float] = {}
    valuation: dict[str, float] = {}
    evidence: list[dict[str, Any]] = []
    warnings: list[str] = []


class ResearchStatus(BaseModel):
    engine: str
    model: str | None
    llm_key_configured: bool = False
    llm_key_source: str = "none"
    embedding_model: str
    documents: int
    chunks: int
    url_ingestion_enabled: bool
