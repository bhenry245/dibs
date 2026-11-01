# Scanned bills: read a receipt into a DRAFT, let the Captain correct it, then open it to the crew.

from datetime import timedelta
from functools import lru_cache
from typing import Annotated

import anthropic
from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile, status
from pydantic import ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dibs.config import settings
from dibs.models import Bill, LineItem, ReceiptScan
from dibs.receipts import (
    MAX_IMAGE_BYTES,
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
from dibs.schemas import BillDetails, BillOut, DraftCreated, DraftOut, Email, Name

router = APIRouter()

# Any fixed number works. It just has to mean "the scan counter" everywhere it's used.
SCAN_COUNT_LOCK = 3147
POSTGRES_INT_MAX = 2_147_483_647


@lru_cache
def get_cached_client() -> anthropic.AsyncAnthropic:
    return create_client()


def get_receipt_client() -> anthropic.AsyncAnthropic:
    if not settings.anthropic_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Receipt scanning isn't set up.")
    return get_cached_client()


ReceiptClient = Annotated[anthropic.AsyncAnthropic, Depends(get_receipt_client)]


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


# The photo comes straight to the API for now. S3 later changes how it arrives, not what happens
# to it. Claude reads it during the request, so this can take a while.
@router.post("/bills/from-receipt", status_code=status.HTTP_201_CREATED)
async def create_bill_from_receipt(
    photo: UploadFile,
    captain_email: Annotated[Email, Form()],
    captain_name: Annotated[Name, Form()],
    session: Session,
    client: ReceiptClient,
) -> DraftCreated:
    image = await photo.read(MAX_IMAGE_BYTES + 1)
    if len(image) > MAX_IMAGE_BYTES:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Use a photo under 5 MB.")
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

    captain = await find_or_create_captain(session, captain_email, captain_name)
    printed_total = receipt.total_cents
    bill = Bill(
        captain_id=captain.id,
        status="DRAFT",
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
    captain_row, token = add_captain_row(session, bill, captain_name, captain_email)
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
    return bill_out
