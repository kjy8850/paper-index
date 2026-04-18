FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# 빌드타임 모델 워밍업 (첫 요청 지연 방지)
RUN python -c "from docling.document_converter import DocumentConverter; DocumentConverter()"
COPY main.py .
EXPOSE 8089
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8089", "--timeout-keep-alive", "300"]
