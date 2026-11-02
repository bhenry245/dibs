# Locking a bill and settling up: amounts become final, then the crew pay and the Captain confirms.

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from dibs.draft_routes import CaptainsBill
from dibs.live import live_updates
from dibs.models import Bill, Claim, CrewMember, LineItem, Settlement
from dibs.routes import (
    CurrentCrewMember,
    Session,
    VisibleBill,
    build_bill_out,
    calculate_totals,
    load_crew,
)
from dibs.schemas import BillOut, BillTotals, LockRequest, SettlementOut

router = APIRouter()


# Checks where the Captain wants unclaimed items to go. Claims can't change during this, because
# CaptainsBill holds the bill's row lock. An item that's since been claimed means the Captain was
# looking at an old screen, so they should see it again instead of overriding someone's dibs.
async def check_assignments(session: AsyncSession, bill: Bill, body: LockRequest) -> None:
    if bill.status != "OPEN":
        raise HTTPException(status.HTTP_409_CONFLICT, "bill is not open")
    totals = await calculate_totals(session, bill)
    if not body.assignments.keys() <= set(totals.unclaimed_item_ids):
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Someone just claimed one of those items. Check it again."
        )
    crew_ids = {person.crew_member_id for person in totals.people}
    if not set(body.assignments.values()) <= crew_ids:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "That person isn't on this bill."
        )


# What everyone would owe if the bill locked like this. It's a POST because the assignments are a
# body, but it changes nothing.
@router.post("/bills/{share_code}/lock/preview")
async def preview_lock(body: LockRequest, bill: CaptainsBill, session: Session) -> BillTotals:
    await check_assignments(session, bill, body)
    return await calculate_totals(session, bill, assignments=body.assignments)


# Makes the amounts final. Unclaimed items go to whoever the Captain chose, or to the Captain. The
# amounts are stored rather than worked out again later, so nothing can change what someone was told
# they owe. Claims take a shared lock on the bill's row, and this holds the exclusive one, so a
# claim that arrives at the same moment either finishes first and counts, or waits and gets refused.
@router.post("/bills/{share_code}/lock")
async def lock_bill(body: LockRequest, bill: CaptainsBill, session: Session) -> BillOut:
    # Locking twice is fine, so a double tap can't show an error.
    if bill.status in ("LOCKED", "SETTLED"):
        return await build_bill_out(session, bill)
    await check_assignments(session, bill, body)

    totals = await calculate_totals(session, bill, assignments=body.assignments)
    crew = await load_crew(session, bill.id)
    captain = next(member for member in crew if member.is_captain)

    # Written as real claims, so the bill still shows who ended up with each item.
    session.add_all(
        Claim(
            line_item_id=item_id,
            crew_member_id=body.assignments.get(item_id, captain.id),
            assigned_at_lock=True,
        )
        for item_id in totals.unclaimed_item_ids
    )
    # The Captain already paid the restaurant, and someone who owes nothing has nothing to settle.
    settlements = [
        Settlement(
            bill_id=bill.id,
            crew_member_id=person.crew_member_id,
            subtotal_cents=person.subtotal_cents,
            tax_cents=person.tax_cents,
            tip_cents=person.tip_cents,
            fees_cents=person.fees_cents,
            total_cents=person.total_cents,
        )
        for person in totals.people
        if person.crew_member_id != captain.id and person.total_cents > 0
    ]
    session.add_all(settlements)
    bill.status = "LOCKED" if settlements else "SETTLED"
    bill.locked_at = func.now()
    await session.flush()
    bill_out = await build_bill_out(session, bill)
    await session.commit()
    await live_updates.notify(bill.id)
    return bill_out


# For rare fixes (design §6). Refused once anyone has paid, because reopening would throw away the
# record of that money. Items the lock assigned go back to being unclaimed, so nobody who claims one
# afterwards ends up splitting it by accident.
@router.post("/bills/{share_code}/reopen")
async def reopen_bill(bill: CaptainsBill, session: Session) -> BillOut:
    if bill.status == "OPEN":
        return await build_bill_out(session, bill)
    if bill.status != "LOCKED":
        raise HTTPException(status.HTTP_409_CONFLICT, "This bill is settled.")
    paid = await session.scalar(
        select(func.count())
        .select_from(Settlement)
        .where(Settlement.bill_id == bill.id, Settlement.status != "OWED")
    )
    if paid:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "Someone has already paid, so this bill can't be reopened."
        )

    await session.execute(delete(Settlement).where(Settlement.bill_id == bill.id))
    await session.execute(
        delete(Claim).where(
            Claim.assigned_at_lock,
            Claim.line_item_id.in_(select(LineItem.id).where(LineItem.bill_id == bill.id)),
        )
    )
    bill.status = "OPEN"
    bill.locked_at = None
    await session.flush()
    bill_out = await build_bill_out(session, bill)
    await session.commit()
    await live_updates.notify(bill.id)
    return bill_out


def build_settlement_out(settlement: Settlement, name: str) -> SettlementOut:
    return SettlementOut(
        id=settlement.id,
        crew_member_id=settlement.crew_member_id,
        name=name,
        subtotal_cents=settlement.subtotal_cents,
        tax_cents=settlement.tax_cents,
        tip_cents=settlement.tip_cents,
        fees_cents=settlement.fees_cents,
        total_cents=settlement.total_cents,
        status=settlement.status,
    )


# Who owes what and who's paid. Anyone with the share code can already see these amounts.
@router.get("/bills/{share_code}/settlements")
async def get_settlements(bill: VisibleBill, session: Session) -> list[SettlementOut]:
    rows = await session.execute(
        select(Settlement, CrewMember.name)
        .join(CrewMember, Settlement.crew_member_id == CrewMember.id)
        .where(Settlement.bill_id == bill.id)
        .order_by(CrewMember.created_at, CrewMember.id)
    )
    return [build_settlement_out(settlement, name) for settlement, name in rows]


# "I paid". Dibs never touches the money, so this only records what someone says they did.
@router.post("/bills/{share_code}/settlements/mine/paid")
async def mark_paid(
    bill: VisibleBill, crew_member: CurrentCrewMember, session: Session
) -> SettlementOut:
    if crew_member.bill_id != bill.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "you aren't on this bill")
    settlement = await session.scalar(
        select(Settlement).where(Settlement.crew_member_id == crew_member.id).with_for_update()
    )
    if settlement is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "You have nothing to pay.")
    # Only from OWED, so a late tap can't undo the Captain's confirmation.
    if settlement.status == "OWED":
        settlement.status = "MARKED_PAID"
        settlement.marked_paid_at = func.now()
        await session.flush()
    out = build_settlement_out(settlement, crew_member.name)
    await session.commit()
    await live_updates.notify(bill.id)
    return out


async def get_settlement_on_bill(
    settlement_id: uuid.UUID, bill: CaptainsBill, session: Session
) -> Settlement:
    settlement = await session.get(Settlement, settlement_id)
    if settlement is None or settlement.bill_id != bill.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "settlement not found")
    return settlement


SettlementOnBill = Annotated[Settlement, Depends(get_settlement_on_bill)]


# The Captain saw the money arrive. This also works from OWED, for someone who paid in cash and
# never tapped "I paid" (design §7). Once everyone is confirmed, the bill is settled.
@router.post("/bills/{share_code}/settlements/{settlement_id}/confirm")
async def confirm_payment(
    settlement: SettlementOnBill, bill: CaptainsBill, session: Session
) -> SettlementOut:
    if settlement.status != "CONFIRMED":
        settlement.status = "CONFIRMED"
        settlement.confirmed_at = func.now()
        await session.flush()
    still_open = await session.scalar(
        select(func.count())
        .select_from(Settlement)
        .where(Settlement.bill_id == bill.id, Settlement.status != "CONFIRMED")
    )
    if not still_open:
        bill.status = "SETTLED"
    name = await session.get_one(CrewMember, settlement.crew_member_id)
    out = build_settlement_out(settlement, name.name)
    await session.commit()
    await live_updates.notify(bill.id)
    return out


# The Captain looked and the money isn't there, so it goes back to owed.
@router.post("/bills/{share_code}/settlements/{settlement_id}/not-received")
async def payment_not_received(
    settlement: SettlementOnBill, bill: CaptainsBill, session: Session
) -> SettlementOut:
    if settlement.status == "CONFIRMED":
        raise HTTPException(status.HTTP_409_CONFLICT, "This payment is already confirmed.")
    settlement.status = "OWED"
    settlement.marked_paid_at = None
    name = await session.get_one(CrewMember, settlement.crew_member_id)
    await session.flush()
    out = build_settlement_out(settlement, name.name)
    await session.commit()
    await live_updates.notify(bill.id)
    return out
