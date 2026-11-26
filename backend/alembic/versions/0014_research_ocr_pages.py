"""record which research pages came from OCR

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-25 14:00:00.000000

Scanned PDFs are now OCR'd on ingestion. The list of OCR-derived page numbers is
stored on the document so reports can be audited for provenance.
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = '0014'
down_revision: str | None = '0013'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('research_documents',
                  sa.Column('ocr_pages', postgresql.ARRAY(sa.Integer()),
                            nullable=False, server_default='{}'))
    op.execute("ALTER TABLE research_documents ALTER COLUMN ocr_pages DROP DEFAULT")


def downgrade() -> None:
    op.drop_column('research_documents', 'ocr_pages')
