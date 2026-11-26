import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Computed,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import Base, UUIDPk, utcnow
from app.research.embeddings import DIM


class ResearchDocument(UUIDPk, Base):
    __tablename__ = "research_documents"
    __table_args__ = (
        CheckConstraint(
            "doc_type IN ('earnings','filing','central_bank','economic_data','news',"
            "'analysis','other')",
            name="doc_type_valid"),
        Index("ix_research_documents_symbols", "symbols", postgresql_using="gin"),
    )

    title: Mapped[str] = mapped_column(String(300), nullable=False)
    source_name: Mapped[str] = mapped_column(String(120), nullable=False)
    source_url: Mapped[str | None] = mapped_column(String(1000))
    doc_type: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    content_type: Mapped[str] = mapped_column(String(40), nullable=False)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    retrieved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    word_count: Mapped[int] = mapped_column(Integer, nullable=False)
    page_count: Mapped[int | None] = mapped_column(Integer)
    ocr_pages: Mapped[list[int]] = mapped_column(ARRAY(Integer), nullable=False, default=list)
    symbols: Mapped[list[str]] = mapped_column(ARRAY(String(32)), nullable=False, default=list)
    sentiment: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    is_sample: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow)

    chunks: Mapped[list["ResearchChunk"]] = relationship(
        back_populates="document", cascade="all, delete-orphan", passive_deletes=True,
        order_by="ResearchChunk.ordinal", lazy="noload")


class ResearchChunk(UUIDPk, Base):
    __tablename__ = "research_chunks"
    __table_args__ = (
        Index("ix_research_chunks_tsv", "tsv", postgresql_using="gin"),
        Index("ix_research_chunks_embedding", "embedding", postgresql_using="hnsw",
              postgresql_ops={"embedding": "vector_cosine_ops"}),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("research_documents.id", ondelete="CASCADE"), nullable=False, index=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    page: Mapped[int | None] = mapped_column(Integer)
    paragraph: Mapped[int] = mapped_column(Integer, nullable=False)
    sentiment: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    embedding: Mapped[list[float]] = mapped_column(Vector(DIM), nullable=False)
    embedding_model: Mapped[str] = mapped_column(String(40), nullable=False)
    tsv: Mapped[Any] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english', text)", persisted=True), nullable=False)

    document: Mapped[ResearchDocument] = relationship(back_populates="chunks", lazy="joined")


class ResearchReport(UUIDPk, Base):
    """A persisted, cited research answer. Never linked to order execution."""

    __tablename__ = "research_reports"

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    question: Mapped[str] = mapped_column(String(1000), nullable=False)
    symbols: Mapped[list[str]] = mapped_column(ARRAY(String(32)), nullable=False, default=list)
    engine: Mapped[str] = mapped_column(String(60), nullable=False)
    confidence: Mapped[float] = mapped_column(Float, nullable=False)
    insufficient_evidence: Mapped[bool] = mapped_column(Boolean, nullable=False)
    body: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), default=utcnow,
        index=True)
