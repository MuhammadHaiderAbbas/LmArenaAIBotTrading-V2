FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

# tesseract-ocr: OCR fallback for scanned PDFs; libgomp1: LightGBM OpenMP runtime.
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 tesseract-ocr \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 aurex
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY alembic.ini pyproject.toml ./
COPY alembic ./alembic
COPY app ./app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER aurex
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/v1/system/health').status==200 else 1)"
ENTRYPOINT ["docker-entrypoint.sh"]
# Only trust X-Forwarded-For from the reverse proxy; otherwise any client could spoof its IP and
# dodge per-IP rate limits or forge audit records. Override with the proxy's address or subnet.
ENV FORWARDED_ALLOW_IPS=127.0.0.1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--no-server-header"]


# Operations image: the API image plus the PostgreSQL client, for the backup / restore-drill
# scheduler (infrastructure/backup). Build with: docker build --target ops -t aurex-ops ./backend
FROM base AS ops
# The client must match the server's major version: newer pg_dump output can contain settings an
# older server rejects on restore. Installed from the PostgreSQL project's apt repository.
ARG PG_MAJOR=16
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}" rclone \
    && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/lib/postgresql/${PG_MAJOR}/bin:${PATH}"
COPY --chown=aurex:aurex ops/backup /opt/aurex/backup
USER aurex
ENTRYPOINT []
CMD ["/opt/aurex/backup/schedule.sh"]

# Default target: the API (declared last so a plain `docker build` produces it).
FROM base AS runtime
