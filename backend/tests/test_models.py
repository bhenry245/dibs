# The database's own safety net, tested with API validation out of the way: these rules hold
# even if the app code has a bug.

import uuid
from collections.abc import Callable

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dibs.models import Bill, Captain, Claim, CrewMember, LineItem, generate_share_code

pytestmark = pytest.mark.anyio


@pytest.fixture
async def rows(session: AsyncSession) -> dict:
    """One Captain with a bill, a line item, a Captain crew row, a crew member and a claim."""
    captain = Captain(email=f"{uuid.uuid4()}@example.com", display_name="Cap")
    session.add(captain)
    await session.flush()
    bill = Bill(captain_id=captain.id)
    session.add(bill)
    await session.flush()
    item = LineItem(bill_id=bill.id, description="Nachos", price_cents=900, position=0)
    captain_row = CrewMember(bill_id=bill.id, name="Cap", is_captain=True)
    ana = CrewMember(bill_id=bill.id, name="Ana")
    session.add_all([item, captain_row, ana])
    await session.flush()
    claim = Claim(line_item_id=item.id, crew_member_id=captain_row.id)
    session.add(claim)
    await session.flush()
    return {
        "captain": captain,
        "bill": bill,
        "item": item,
        "captain_row": captain_row,
        "ana": ana,
        "claim": claim,
    }


async def test_server_defaults(session: AsyncSession, rows: dict):
    await session.refresh(rows["bill"])
    await session.refresh(rows["claim"])
    await session.refresh(rows["ana"])

    assert rows["bill"].status == "DRAFT"
    assert rows["bill"].split_tip is True
    assert rows["bill"].tax_cents == 0
    assert rows["bill"].created_at is not None
    assert rows["claim"].shares == 1
    assert rows["ana"].is_captain is False


def test_share_codes_are_random_and_long_enough():
    # 16 random bytes come out as 22 URL-safe characters, which is the 128 bits design §15 wants.
    codes = {generate_share_code() for _ in range(100)}

    assert len(codes) == 100
    assert all(len(code) == 22 for code in codes)


def _set(attribute: str, name: str, value: object) -> Callable[[dict], None]:
    def apply(rows: dict) -> None:
        setattr(rows[attribute], name, value)

    return apply


@pytest.mark.parametrize(
    ("change", "constraint"),
    [
        (_set("bill", "status", "NOPE"), "ck_bill_status_valid"),
        (_set("bill", "subtotal_cents", -1), "ck_bill_amounts_not_negative"),
        (_set("bill", "tax_cents", -1), "ck_bill_amounts_not_negative"),
        (_set("bill", "tip_cents", -1), "ck_bill_amounts_not_negative"),
        (_set("bill", "total_cents", -1), "ck_bill_amounts_not_negative"),
        (_set("item", "price_cents", -1), "ck_line_item_price_not_negative"),
        (_set("claim", "shares", 0), "ck_claim_shares_at_least_one"),
        (_set("ana", "is_captain", True), "uq_crew_member_one_captain_per_bill"),
    ],
)
async def test_database_rejects_bad_updates(
    session: AsyncSession, rows: dict, change: Callable[[dict], None], constraint: str
):
    with pytest.raises(IntegrityError, match=constraint):
        async with session.begin_nested():
            change(rows)
            await session.flush()


async def test_person_cannot_claim_the_same_item_twice(session: AsyncSession, rows: dict):
    with pytest.raises(IntegrityError, match="uq_claim_line_item_id_crew_member_id"):
        async with session.begin_nested():
            session.add(Claim(line_item_id=rows["item"].id, crew_member_id=rows["captain_row"].id))
            await session.flush()


async def test_two_people_can_claim_the_same_item(session: AsyncSession, rows: dict):
    session.add(Claim(line_item_id=rows["item"].id, crew_member_id=rows["ana"].id))

    await session.flush()


async def test_share_codes_are_unique(session: AsyncSession, rows: dict):
    with pytest.raises(IntegrityError, match="uq_bill_share_code"):
        async with session.begin_nested():
            session.add(Bill(captain_id=rows["captain"].id, share_code=rows["bill"].share_code))
            await session.flush()


async def test_bill_needs_a_real_captain(session: AsyncSession):
    with pytest.raises(IntegrityError, match="fk_bill_captain_id_captain"):
        async with session.begin_nested():
            session.add(Bill(captain_id=uuid.uuid4()))
            await session.flush()


async def test_cannot_delete_a_captain_who_has_bills(session: AsyncSession, rows: dict):
    with pytest.raises(IntegrityError, match="fk_bill_captain_id_captain"):
        async with session.begin_nested():
            await session.delete(rows["captain"])
            await session.flush()


async def test_deleting_a_bill_removes_its_items_crew_and_claims(session: AsyncSession, rows: dict):
    bill_id = rows["bill"].id
    item_id = rows["item"].id

    await session.delete(rows["bill"])
    await session.flush()
    session.expire_all()

    assert (await session.scalars(select(LineItem).where(LineItem.bill_id == bill_id))).all() == []
    assert (
        await session.scalars(select(CrewMember).where(CrewMember.bill_id == bill_id))
    ).all() == []
    assert (await session.scalars(select(Claim).where(Claim.line_item_id == item_id))).all() == []
