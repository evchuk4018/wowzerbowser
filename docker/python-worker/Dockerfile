FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1 \
    NUMEXPR_NUM_THREADS=1 \
    VECLIB_MAXIMUM_THREADS=1 \
    TOKENIZERS_PARALLELISM=false

WORKDIR /app

RUN groupadd --system --gid 1000 pythonworker \
  && useradd --system --uid 1000 --gid pythonworker --home-dir /workspaces --create-home pythonworker \
  && mkdir -p /workspaces \
  && chown pythonworker:pythonworker /workspaces

# Keep the trusted package set in the image layer so normal executions do not
# need to compile or download packages. User-requested packages are installed
# later into per-conversation virtual environments.
RUN python -m pip install --no-cache-dir --disable-pip-version-check \
    numpy \
    scipy \
    sympy \
    pandas \
    matplotlib \
    pillow \
    pypdf \
    pymupdf \
    pdfplumber \
    reportlab \
    python-docx \
    docx2txt \
    openpyxl \
    lxml

COPY docker/python-worker/server.py ./server.py
RUN chown -R pythonworker:pythonworker /app

USER pythonworker
EXPOSE 5003

ENTRYPOINT ["python", "/app/server.py"]
