FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/opendataloader \
    XDG_CACHE_HOME=/var/cache/opendataloader \
    HF_HOME=/var/cache/opendataloader/huggingface \
    TORCH_HOME=/var/cache/opendataloader/torch \
    CUDA_VISIBLE_DEVICES="" \
    TOKENIZERS_PARALLELISM=false

RUN apt-get update \
  && apt-get install -y --no-install-recommends openjdk-17-jre-headless ca-certificates libgl1 libxcb1 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 opendataloader \
  && useradd --system --uid 10001 --gid opendataloader --create-home --home-dir /home/opendataloader opendataloader \
  && mkdir -p /var/cache/opendataloader \
  && chown -R opendataloader:opendataloader /var/cache/opendataloader /home/opendataloader \
  && pip install --no-cache-dir --disable-pip-version-check --index-url https://download.pytorch.org/whl/cpu "torch==2.13.0+cpu" "torchvision==0.28.0+cpu" \
  && printf '%s\n' 'torch==2.13.0+cpu' 'torchvision==0.28.0+cpu' > /tmp/pytorch-constraints.txt \
  && pip install --no-cache-dir --disable-pip-version-check --extra-index-url https://download.pytorch.org/whl/cpu --constraint /tmp/pytorch-constraints.txt "opendataloader-pdf[hybrid]==2.5.0" \
  && python -c "import cv2, easyocr" \
  && rm -f /tmp/pytorch-constraints.txt

USER opendataloader
WORKDIR /home/opendataloader

CMD ["opendataloader-pdf-hybrid", "--host", "0.0.0.0", "--port", "5002", "--device", "cpu", "--ocr-engine", "easyocr", "--ocr-lang", "en", "--max-file-size", "25", "--log-level", "info"]
