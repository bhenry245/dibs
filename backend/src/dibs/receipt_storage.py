# Receipt photos in S3. The browser uploads straight to the bucket with a signed permission from the
# API, so large images never pass through the API (design doc §10).

import asyncio
from functools import lru_cache
from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from dibs.config import settings
from dibs.receipts import MAX_IMAGE_BYTES

# Long enough to upload on slow restaurant Wi-Fi, short enough that a leaked link soon stops.
UPLOAD_EXPIRES_SECONDS = 300
# The browser converts every photo to JPEG before uploading.
UPLOAD_CONTENT_TYPE = "image/jpeg"


# The photo isn't in the bucket, usually because the upload never finished.
class ReceiptPhotoMissingError(Exception):
    pass


# The photo is bigger than Claude accepts. The upload's signed limit should already prevent this.
class ReceiptPhotoTooLargeError(Exception):
    pass


# S3 couldn't be reached or refused, such as with an expired login, so trying later might work.
class ReceiptStorageError(Exception):
    pass


# One client per process, because creating one is slow. It finds its credentials the standard way:
# the profile in .env locally, and the server's own role in production.
@lru_cache
def create_s3_client() -> Any:
    session = boto3.Session(profile_name=settings.aws_profile, region_name=settings.aws_region)
    return session.client(
        "s3", config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"})
    )


# A signed permission to upload one file. The limits are part of what's signed, so the browser can't
# change them, and creating it doesn't contact AWS or give the browser any credentials.
def create_upload_form(client: Any, key: str) -> dict:
    try:
        return client.generate_presigned_post(
            Bucket=settings.receipts_bucket,
            Key=key,
            Fields={"Content-Type": UPLOAD_CONTENT_TYPE},
            Conditions=[
                {"Content-Type": UPLOAD_CONTENT_TYPE},
                ["content-length-range", 1, MAX_IMAGE_BYTES],
            ],
            ExpiresIn=UPLOAD_EXPIRES_SECONDS,
        )
    except (BotoCoreError, ClientError) as error:
        raise ReceiptStorageError("Couldn't start the upload right now.") from error


def _download(client: Any, key: str) -> bytes:
    response = client.get_object(Bucket=settings.receipts_bucket, Key=key)
    if response["ContentLength"] > MAX_IMAGE_BYTES:
        raise ReceiptPhotoTooLargeError
    return response["Body"].read()


# boto3 blocks while it waits on the network, so this runs in a thread to keep the server
# responsive.
async def download_photo(client: Any, key: str) -> bytes:
    try:
        return await asyncio.to_thread(_download, client, key)
    except ClientError as error:
        if error.response["Error"]["Code"] in ("NoSuchKey", "404"):
            raise ReceiptPhotoMissingError from error
        raise ReceiptStorageError("Couldn't read the receipt right now.") from error
    except BotoCoreError as error:
        raise ReceiptStorageError("Couldn't read the receipt right now.") from error
