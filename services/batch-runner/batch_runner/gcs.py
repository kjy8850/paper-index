from google.cloud import storage
from . import config

_client: storage.Client | None = None


def client() -> storage.Client:
    global _client
    if _client is None:
        _client = storage.Client()
    return _client


def upload(local_path: str, blob_name: str) -> str:
    """Upload file to GCS and return gs:// URI."""
    bucket = client().bucket(config.GCS_BUCKET)
    blob = bucket.blob(blob_name)
    blob.upload_from_filename(local_path)
    return f"gs://{config.GCS_BUCKET}/{blob_name}"


def delete(blob_name: str):
    bucket = client().bucket(config.GCS_BUCKET)
    blob = bucket.blob(blob_name)
    if blob.exists():
        blob.delete()
