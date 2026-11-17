FROM python:3.12-alpine
LABEL org.opencontainers.image.title="fone" \
      org.opencontainers.image.description="fone's server: a streamer's recorded commentary in step with F1 TV, live timing, danmaku" \
      org.opencontainers.image.source="https://github.com/Gilbert-Wang-30/f1tv-commentary-sync" \
      org.opencontainers.image.licenses="MIT"
# ffmpeg: audio extraction, video remux, ad/backfill decoding. tesseract: screen clock OCR.
RUN apk add --no-cache ffmpeg tzdata tesseract-ocr tesseract-ocr-data-eng
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY fone ./fone
ENV PYTHONUNBUFFERED=1
# The release's version (release.yml passes the tag's); /api/health reports it. Last, so a new
# version reuses every layer above.
ARG FONE_VERSION=dev
ENV FONE_VERSION=$FONE_VERSION
LABEL org.opencontainers.image.version=$FONE_VERSION
EXPOSE 8788
# python, not wget/curl: the one client every build of this image is sure to have.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8788/api/health', timeout=4)"]
CMD ["uvicorn", "fone.app:app", "--host", "0.0.0.0", "--port", "8788", "--no-access-log"]
