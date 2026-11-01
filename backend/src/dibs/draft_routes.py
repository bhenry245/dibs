# Scanned bills: read a receipt into a DRAFT, let the Captain correct it, then open it to the crew.

import logging
import uuid
from datetime import timedelta
from functools import lru_cache
from typing import Annotated, Any

import anthropic
from botocore.exceptions import BotoCoreError
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dibs.config import settings
from dibs.live import live_updates
from dibs.models import Bill, LineItem, ReceiptScan, ReceiptUpload
from dibs.receipt_storage import (
    ReceiptPhotoMissingError,
    ReceiptPhotoTooLargeError,
    ReceiptStorageError,
    create_s3_client,
    create_upload_form,
    download_photo,
)
from dibs.receipts import (
    Receipt,
    ReceiptServiceError,
    ReceiptUnreadableError,
    create_client,
    detect_media_type,
    parse_receipt,
)
from dibs.routes import (
    CurrentCrewMember,
    Session,
    add_captain_row,
    add_items,
    apply_details,
    build_bill_out,
    find_or_create_captain,
)
from dibs.schemas import (
    BillDetails,
    BillOut,
    DraftCreated,
    DraftOut,
    ReceiptScanRequest,
    ReceiptUploadOut,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Any fixed numbers work. Each just has to mean the same counter everywhere it's used.
SCAN_COUNT_LOCK = 3147
UPLOAD_COUNT_LOCK = 3148
POSTGRES_INT_MAX = 2_147_483_647


@lru_cache
def get_cached_client() -> anthropic.AsyncAnthropic:
    return create_client()


def get_receipt_client() -> anthropic.AsyncAnthropic:
    if not settings.anthropic_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Receipt scanning isn't set up.")
    return get_cached_client()


ReceiptClient = Annotated[anthropic.AsyncAnthropic, Depends(get_receipt_client)]


def get_s3_client() -> Any:
    if not settings.receipts_bucket:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Receipt scanning isn't set up.")
    try:
        return create_s3_client()
    except BotoCoreError as error:
        logger.exception("Could not create the S3 client")
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Receipt scanning isn't available right now."
        ) from error


S3Client = Annotated[Any, Depends(get_s3_client)]


# Records a scan, or refuses it once today's limit is reached. The lock makes concurrent scans
# take turns, so two requests can't both see one slot left and both use it.
async def count_scan(session: AsyncSession) -> None:
    await session.execute(select(func.pg_advisory_xact_lock(SCAN_COUNT_LOCK)))
    recent_scans = await session.scalar(
        select(func.count())
        .select_from(ReceiptScan)
        .where(ReceiptScan.created_at > func.now() - timedelta(days=1))
    )
    if recent_scans >= settings.receipt_daily_limit:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many receipts have been scanned today. Type this one in instead.",
        )
    session.add(ReceiptScan())
    # Committed before calling Claude, so a scan is counted even if the request then fails.
    await session.commit()


# Fits what Claude read into the same rules as a typed bill. A negative amount has already been
# flagged as a warning, so it starts at zero for the Captain to fix.
def receipt_to_details(receipt: Receipt) -> BillDetails:
    try:
        return BillDetails(
            restaurant_name=(receipt.restaurant_name or "").strip()[:200] or None,
            tax_cents=max(receipt.tax_cents or 0, 0),
            tip_cents=max(receipt.tip_cents or 0, 0),
            fees_cents=max(receipt.fees_cents or 0, 0),
            items=[
                {"description": item.description.strip()[:255], "price_cents": item.price_cents}
                for item in receipt.items
            ],
        )
    except ValidationError as error:
        raise ReceiptUnreadableError(
            "This receipt couldn't be read. Try another photo, or type it in."
        ) from error


def build_draft_out(bill_out: BillOut, bill: Bill) -> DraftOut:
    return DraftOut(
        bill=bill_out,
        warnings=bill.receipt_warnings,
        printed_total_cents=bill.printed_total_cents,
    )


# The bill, if the caller is its Captain. The row stays locked until the request finishes, so
# saving corrections and opening the bill can't interleave.
async def get_captains_bill(
    share_code: str, crew_member: CurrentCrewMember, session: Session
) -> Bill:
    bill = await session.scalar(select(Bill).where(Bill.share_code == share_code).with_for_update())
    if bill is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "bill not found")
    if crew_member.bill_id != bill.id or not crew_member.is_captain:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only this bill's Captain can do that")
    return bill


CaptainsBill = Annotated[Bill, Depends(get_captains_bill)]


def require_draft(bill: Bill) -> None:
    if bill.status != "DRAFT":
        raise HTTPException(status.HTTP_409_CONFLICT, "bill is already open")


# Hands the browser a signed permission to upload one photo, under a name the API chooses. Limited
# because anyone can ask for one, and the lock works the same way as the scan limit's.
@router.post("/receipts/upload-url", status_code=status.HTTP_201_CREATED)
async def create_receipt_upload(session: Session, s3: S3Client) -> ReceiptUploadOut:
    await session.execute(select(func.pg_advisory_xact_lock(UPLOAD_COUNT_LOCK)))
    recent_uploads = await session.scalar(
        select(func.count())
        .select_from(ReceiptUpload)
        .where(ReceiptUpload.created_at > func.now() - timedelta(days=1))
    )
    if recent_uploads >= settings.receipt_upload_daily_limit:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "Too many receipts have been scanned today. Type this one in instead.",
        )

    upload_id = uuid.uuid4()
    key = f"receipts/{upload_id}.jpg"
    try:
        form = create_upload_form(s3, key)
    except ReceiptStorageError as error:
        logger.exception("Could not sign a receipt upload")
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(error)) from error
    session.add(ReceiptUpload(id=upload_id, s3_key=key))
    await session.commit()
    return ReceiptUploadOut(upload_id=upload_id, url=form["url"], fields=form["fields"])


# Marks an upload as used and returns its key. A single UPDATE, so two requests at once can't both
# use it, and each photo can only cost one Claude call.
async def use_upload(session: AsyncSession, upload_id: uuid.UUID) -> str:
    key = await session.scalar(
        update(ReceiptUpload)
        .where(ReceiptUpload.id == upload_id, ReceiptUpload.used_at.is_(None))
        .values(used_at=func.now())
        .returning(ReceiptUpload.s3_key)
    )
    if key is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "This photo can't be used. Scan it again."
        )
    await session.commit()
    return key


# Reads a photo the browser has already uploaded to S3. Claude reads it during the request, so
# this can take a while.
@router.post("/bills/from-receipt", status_code=status.HTTP_201_CREATED)
async def create_bill_from_receipt(
    body: ReceiptScanRequest,
    session: Session,
    client: ReceiptClient,
    s3: S3Client,
) -> DraftCreated:
    key = await use_upload(session, body.upload_id)
    try:
        image = await download_photo(s3, key)
    except ReceiptPhotoMissingError as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "The photo didn't finish uploading. Scan it again.",
        ) from error
    except ReceiptPhotoTooLargeError as error:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Use a photo under 5 MB."
        ) from error
    except ReceiptStorageError as error:
        logger.exception("Could not download a receipt photo")
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(error)) from error

    media_type = detect_media_type(image)
    if media_type is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "Use a JPEG, PNG, WebP or GIF photo."
        )

    await count_scan(session)
    try:
        receipt = await parse_receipt(image, media_type, client)
        details = receipt_to_details(receipt)
    except ReceiptUnreadableError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error
    except ReceiptServiceError as error:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(error)) from error

    captain = await find_or_create_captain(session, body.captain_email, body.captain_name)
    printed_total = receipt.total_cents
    bill = Bill(
        captain_id=captain.id,
        status="DRAFT",
        receipt_s3_key=key,
        receipt_warnings=receipt.warnings,
        printed_total_cents=(
            printed_total
            if printed_total is not None and 0 <= printed_total <= POSTGRES_INT_MAX
            else None
        ),
    )
    apply_details(bill, details)
    session.add(bill)
    await session.flush()

    add_items(session, bill, details)
    captain_row, token = add_captain_row(session, bill, body.captain_name, body.captain_email)
    await session.flush()
    draft = build_draft_out(await build_bill_out(session, bill), bill)
    await session.commit()
    return DraftCreated(draft=draft, crew_member_id=captain_row.id, token=token)


@router.get("/bills/{share_code}/draft")
async def get_draft(bill: CaptainsBill, session: Session) -> DraftOut:
    require_draft(bill)
    return build_draft_out(await build_bill_out(session, bill), bill)


# Replaces the bill's details with the Captain's corrections. Nobody has claimed anything yet,
# because the crew can't see a draft, so replacing the items can't lose anyone's dibs.
@router.put("/bills/{share_code}/draft")
async def update_draft(body: BillDetails, bill: CaptainsBill, session: Session) -> DraftOut:
    require_draft(bill)
    await session.execute(delete(LineItem).where(LineItem.bill_id == bill.id))
    apply_details(bill, body)
    add_items(session, bill, body)
    await session.flush()
    draft = build_draft_out(await build_bill_out(session, bill), bill)
    await session.commit()
    return draft


# Makes the QR code live. Opening twice is fine, so a double tap can't show an error.
@router.post("/bills/{share_code}/open")
async def open_bill(bill: CaptainsBill, session: Session) -> BillOut:
    if bill.status not in ("DRAFT", "OPEN"):
        raise HTTPException(status.HTTP_409_CONFLICT, "bill is already locked")
    bill.status = "OPEN"
    await session.flush()
    bill_out = await build_bill_out(session, bill)
    await session.commit()
    await live_updates.notify(bill.id)
    return bill_out
