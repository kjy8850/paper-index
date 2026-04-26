from google import genai
from google.genai import types
from . import config

_client: genai.Client | None = None


def client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(
            vertexai=True,
            project=config.GCP_PROJECT,
            location=config.GCP_LOCATION,
        )
    return _client


def create_batch(gcs_uri: str, display_name: str, model: str) -> str:
    job = client().batches.create(
        model=model,
        src=gcs_uri,
        config=types.CreateBatchJobConfig(display_name=display_name),
    )
    return job.name


def get_batch(job_name: str):
    return client().batches.get(name=job_name)


def download_output(gcs_uri: str, dst: str):
    """Download batch output from GCS URI to local file."""
    from google.cloud import storage as gcs
    # gcs_uri: gs://bucket/path/to/output/
    parts = gcs_uri.removeprefix("gs://").split("/", 1)
    bucket_name, prefix = parts[0], parts[1] if len(parts) > 1 else ""
    gcs_client = gcs.Client()
    bucket = gcs_client.bucket(bucket_name)
    blobs = list(bucket.list_blobs(prefix=prefix))
    # collect all output lines
    with open(dst, "wb") as out:
        for blob in blobs:
            out.write(blob.download_as_bytes())
