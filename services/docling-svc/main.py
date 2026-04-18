import tempfile
import time
from pathlib import Path
from fastapi import FastAPI, File, UploadFile, HTTPException
from docling.document_converter import DocumentConverter
from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import PdfFormatOption

VERSION = "1.0.0"

app = FastAPI(title="docling-svc", version=VERSION)

_pipeline_options = PdfPipelineOptions()
_pipeline_options.do_ocr = False
_pipeline_options.do_table_structure = True

_converter = DocumentConverter(
    format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=_pipeline_options)
    }
)


@app.get("/healthz")
def healthz():
    return {"ok": True, "version": VERSION}


@app.post("/convert")
async def convert(file: UploadFile = File(...)):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=422, detail={"error": "빈 파일"})

    t0 = time.time()
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tmp:
            tmp.write(content)
            tmp.flush()
            result = _converter.convert(
                source=Path(tmp.name),
                raises_on_error=True,
            )
    except Exception as e:
        raise HTTPException(status_code=422, detail={"error": str(e)})

    doc = result.document
    markdown = doc.export_to_markdown()
    elapsed_ms = int((time.time() - t0) * 1000)

    tables = len(doc.tables) if hasattr(doc, "tables") else 0
    figures = len(doc.pictures) if hasattr(doc, "pictures") else 0
    pages = len(doc.pages) if hasattr(doc, "pages") else 0

    return {
        "markdown": markdown,
        "pages": pages,
        "tables": tables,
        "figures": figures,
        "elapsed_ms": elapsed_ms,
    }
