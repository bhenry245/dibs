# The core API: create a bill, join it, call dibs, and see what everyone owes.

import hashlib
import secrets
import uuid
from collections import defaultdict
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from dibs.db import get_session
from dibs.live import live_updates
from dibs.models import Bill, Captain, Claim, CrewMember, LineItem
from dibs.money import Item, split_bill
from dibs.schemas import (
    BillCreate,
    BillCreated,
    BillDetails,
    BillOut,
    BillTotals,
    ClaimOut,
    ClaimRequest,
    ClaimResponse,
    CrewMemberOut,
    JoinRequest,
    JoinResponse,
    LineItemOut,
    MyClaimsRequest,
    PersonTotalOut,
)

router = APIRouter()

# Stands in for whoever ends up with the unclaimed items, so they take their part of the tax and
# fees and everyone else's amounts are the same as they'll be after the lock.
UNCLAIMED = uuid.UUID(int=0)

Session = Annotated[AsyncSession, Depends(get_session)]
# auto_error=False lets us answer a missing token with our own 401.
Credentials = Annotated[HTTPAuthorizationCredentials | None, Depends(HTTPBearer(auto_error=False))]


# SHA-256 is enough here because tokens are long and random. Slow hashes like bcrypt exist to
# protect short, guessable passwords.
def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# The crew member a request's bearer token belongs to.
async def get_current_crew_member(credentials: Credentials, session: Session) -> CrewMember:
    if credentials is not None:
        crew_member = await session.scalar(
            select(CrewMember).where(CrewMember.token_hash == hash_token(credentials.credentials))
        )
        if crew_member is not None:
            return crew_member
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing or invalid token")


CurrentCrewMember = Annotated[CrewMember, Depends(get_current_crew_member)]


# A bill the crew can see. Drafts count as not found because the Captain is still reviewing them.
async def get_visible_bill(share_code: str, session: Session) -> Bill:
    bill = await session.scalar(select(Bill).where(Bill.share_code == share_code))
    if bill is None or bill.status == "DRAFT":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "bill not found")
    return bill


VisibleBill = Annotated[Bill, Depends(get_visible_bill)]


# Joining and claiming only happen while a bill is OPEN. After the lock, amounts are final.
def require_open(bill: Bill) -> None:
    if bill.status != "OPEN":
        raise HTTPException(status.HTTP_409_CONFLICT, "bill is not open")


# An item the caller may claim. An item on another bill gets the same 404 as one that doesn't
# exist, so nobody can use this to find out what's on other people's bills.
async def get_claimable_item(
    item_id: uuid.UUID, crew_member: CurrentCrewMember, session: Session
) -> LineItem:
    item = await session.get(LineItem, item_id)
    if item is None or item.bill_id != crew_member.bill_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item not found")
    require_open(await session.get_one(Bill, item.bill_id))
    return item


ClaimableItem = Annotated[LineItem, Depends(get_claimable_item)]


async def load_items(session: AsyncSession, bill_id: uuid.UUID) -> list[LineItem]:
    items = await session.scalars(
        select(LineItem).where(LineItem.bill_id == bill_id).order_by(LineItem.position)
    )
    return list(items)


# Captain first, because split_bill gives them any tied cent.
async def load_crew(session: AsyncSession, bill_id: uuid.UUID) -> list[CrewMember]:
    crew = await session.scalars(
        select(CrewMember)
        .where(CrewMember.bill_id == bill_id)
        .order_by(CrewMember.is_captain.desc(), CrewMember.created_at, CrewMember.id)
    )
    return list(crew)


async def load_claims_by_item(
    session: AsyncSession, bill_id: uuid.UUID
) -> dict[uuid.UUID, list[Claim]]:
    claims = await session.scalars(
        select(Claim).join(LineItem).where(LineItem.bill_id == bill_id).order_by(Claim.id)
    )
    by_item: dict[uuid.UUID, list[Claim]] = defaultdict(list)
    for claim in claims:
        by_item[claim.line_item_id].append(claim)
    return by_item


async def build_bill_out(session: AsyncSession, bill: Bill) -> BillOut:
    claims_by_item = await load_claims_by_item(session, bill.id)
    return BillOut(
        share_code=bill.share_code,
        status=bill.status,
        restaurant_name=bill.restaurant_name,
        subtotal_cents=bill.subtotal_cents,
        tax_cents=bill.tax_cents,
        tip_cents=bill.tip_cents,
        fees_cents=bill.fees_cents,
        total_cents=bill.total_cents,
        split_tip=bill.split_tip,
        venmo_handle=bill.venmo_handle,
        cashapp_tag=bill.cashapp_tag,
        zelle_contact=bill.zelle_contact,
        items=[
            LineItemOut(
                id=item.id,
                description=item.description,
                price_cents=item.price_cents,
                position=item.position,
                claims=[
                    ClaimOut(crew_member_id=claim.crew_member_id, shares=claim.shares)
                    for claim in claims_by_item[item.id]
                ],
            )
            for item in await load_items(session, bill.id)
        ],
        crew=[
            CrewMemberOut(id=member.id, name=member.name, is_captain=member.is_captain)
            for member in await load_crew(session, bill.id)
        ],
    )


# Finds the Captain by email, or creates them. There are no logins until Milestone 8, so an
# existing Captain's details are never changed here: anyone can type anyone's email.
async def find_or_create_captain(session: AsyncSession, email: str, name: str) -> Captain:
    # ON CONFLICT, not "select then insert": two requests at once could both find nobody, and
    # the second insert would crash on the unique email.
    await session.execute(
        insert(Captain)
        .values(email=email, display_name=name)
        .on_conflict_do_nothing(index_elements=[Captain.email])
    )
    return (await session.scalars(select(Captain).where(Captain.email == email))).one()


# Sets everything a bill's details decide. The server works out the totals, so they can't disagree
# with the items.
def apply_details(bill: Bill, details: BillDetails) -> None:
    subtotal_cents = sum(item.price_cents for item in details.items)
    bill.restaurant_name = details.restaurant_name
    bill.subtotal_cents = subtotal_cents
    bill.tax_cents = details.tax_cents
    bill.tip_cents = details.tip_cents
    bill.fees_cents = details.fees_cents
    bill.total_cents = subtotal_cents + details.tax_cents + details.tip_cents + details.fees_cents
    bill.split_tip = details.split_tip
    bill.venmo_handle = details.venmo_handle
    bill.cashapp_tag = details.cashapp_tag
    bill.zelle_contact = details.zelle_contact


def add_items(session: AsyncSession, bill: Bill, details: BillDetails) -> None:
    session.add_all(
        LineItem(
            bill_id=bill.id,
            description=item.description,
            price_cents=item.price_cents,
            position=position,
        )
        for position, item in enumerate(details.items)
    )


# Returns the row and its token. The token is only ever available here, because only its hash is
# stored.
def add_captain_row(
    session: AsyncSession, bill: Bill, name: str, email: str
) -> tuple[CrewMember, str]:
    token = secrets.token_urlsafe(32)
    captain_row = CrewMember(
        bill_id=bill.id,
        name=name,
        email=email,
        token_hash=hash_token(token),
        is_captain=True,
    )
    session.add(captain_row)
    return captain_row, token


# A bill typed in by hand starts OPEN: DRAFT is for reviewing the AI's reading of a receipt.
@router.post("/bills", status_code=status.HTTP_201_CREATED)
async def create_bill(body: BillCreate, session: Session) -> BillCreated:
    captain = await find_or_create_captain(session, body.captain_email, body.captain_name)
    bill = Bill(captain_id=captain.id, status="OPEN")
    apply_details(bill, body)
    session.add(bill)
    await session.flush()  # Sends the insert now, so bill.id exists for the rows below.

    add_items(session, bill, body)
    captain_row, token = add_captain_row(session, bill, body.captain_name, body.captain_email)
    await session.flush()
    bill_out = await build_bill_out(session, bill)
    await session.commit()
    return BillCreated(bill=bill_out, crew_member_id=captain_row.id, token=token)


@router.get("/bills/{share_code}")
async def get_bill(bill: VisibleBill, session: Session) -> BillOut:
    return await build_bill_out(session, bill)


@router.post("/bills/{share_code}/join", status_code=status.HTTP_201_CREATED)
async def join_bill(body: JoinRequest, bill: VisibleBill, session: Session) -> JoinResponse:
    require_open(bill)
    token = secrets.token_urlsafe(32)
    crew_member = CrewMember(
        bill_id=bill.id,
        name=body.name,
        phone=body.phone,
        email=body.email,
        token_hash=hash_token(token),
    )
    session.add(crew_member)
    await session.commit()
    await live_updates.notify(bill.id)
    return JoinResponse(crew_member_id=crew_member.id, token=token)


# PUT because it's idempotent: a double tap still leaves one claim, and calling it again with
# different shares updates that claim.
@router.put("/items/{item_id}/claim")
async def claim_item(
    body: ClaimRequest,
    item: ClaimableItem,
    crew_member: CurrentCrewMember,
    session: Session,
) -> ClaimResponse:
    await session.execute(
        insert(Claim)
        .values(line_item_id=item.id, crew_member_id=crew_member.id, shares=body.shares)
        .on_conflict_do_update(
            index_elements=[Claim.line_item_id, Claim.crew_member_id],
            set_={"shares": body.shares},
        )
    )
    await session.commit()
    await live_updates.notify(item.bill_id)
    return ClaimResponse(line_item_id=item.id, crew_member_id=crew_member.id, shares=body.shares)


# Also idempotent: dropping dibs you don't have is still a success.
@router.delete("/items/{item_id}/claim", status_code=status.HTTP_204_NO_CONTENT)
async def unclaim_item(
    item: ClaimableItem, crew_member: CurrentCrewMember, session: Session
) -> None:
    await session.execute(
        delete(Claim).where(Claim.line_item_id == item.id, Claim.crew_member_id == crew_member.id)
    )
    await session.commit()
    await live_updates.notify(item.bill_id)


# Checks someone can change their claims on this bill, and that every item is on it. An item from
# another bill gets the same 404 as one that doesn't exist.
async def check_my_claims(
    bill: Bill, crew_member: CrewMember, body: MyClaimsRequest, session: AsyncSession
) -> set[uuid.UUID]:
    if crew_member.bill_id != bill.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "you aren't on this bill")
    require_open(bill)
    item_ids = set(body.item_ids)
    items_on_bill = set(
        await session.scalars(select(LineItem.id).where(LineItem.bill_id == bill.id))
    )
    if not item_ids <= items_on_bill:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "item not found")
    return item_ids


def person_total(totals: BillTotals, crew_member: CrewMember) -> PersonTotalOut:
    return next(person for person in totals.people if person.crew_member_id == crew_member.id)


# What someone's total would be with these items, without saving anything. It's a POST because
# the list of items is a body, but it changes nothing.
@router.post("/bills/{share_code}/my-claims/preview")
async def preview_my_claims(
    body: MyClaimsRequest,
    bill: VisibleBill,
    crew_member: CurrentCrewMember,
    session: Session,
) -> PersonTotalOut:
    item_ids = await check_my_claims(bill, crew_member, body, session)
    totals = await calculate_totals(session, bill, picks=(crew_member.id, item_ids))
    return person_total(totals, crew_member)


# Saves everything someone is claiming in one transaction, so they can't end up with half of it.
# It's idempotent like the other PUTs, and leaves other people's claims alone.
@router.put("/bills/{share_code}/my-claims")
async def save_my_claims(
    body: MyClaimsRequest,
    bill: VisibleBill,
    crew_member: CurrentCrewMember,
    session: Session,
) -> PersonTotalOut:
    item_ids = await check_my_claims(bill, crew_member, body, session)
    await session.execute(
        delete(Claim).where(
            Claim.crew_member_id == crew_member.id, Claim.line_item_id.not_in(item_ids)
        )
    )
    if item_ids:
        # DO NOTHING keeps the shares on anything they already claimed.
        await session.execute(
            insert(Claim)
            .values(
                [
                    {"line_item_id": item_id, "crew_member_id": crew_member.id}
                    for item_id in item_ids
                ]
            )
            .on_conflict_do_nothing(index_elements=[Claim.line_item_id, Claim.crew_member_id])
        )
    await session.commit()
    await live_updates.notify(bill.id)
    totals = await calculate_totals(session, bill)
    return person_total(totals, crew_member)


# What everyone would owe right now, from what they've claimed. Unclaimed items are reported
# separately, and get settled when the bill is locked (design §8).
@router.get("/bills/{share_code}/totals")
async def get_totals(bill: VisibleBill, session: Session) -> BillTotals:
    return await calculate_totals(session, bill)


# With picks, works out the totals as if that person had claimed exactly those items.
async def calculate_totals(
    session: AsyncSession,
    bill: Bill,
    picks: tuple[uuid.UUID, set[uuid.UUID]] | None = None,
) -> BillTotals:
    crew = await load_crew(session, bill.id)
    items = await load_items(session, bill.id)
    claims_by_item = await load_claims_by_item(session, bill.id)

    money_items = []
    unclaimed_item_ids = []
    for item in items:
        dibs = {claim.crew_member_id: claim.shares for claim in claims_by_item[item.id]}
        if picks:
            person_id, item_ids = picks
            if item.id in item_ids:
                dibs.setdefault(person_id, 1)
            else:
                dibs.pop(person_id, None)
        if not dibs:
            unclaimed_item_ids.append(item.id)
            dibs = {UNCLAIMED: 1}
        money_items.append(Item(item.price_cents, dibs))

    totals = split_bill(
        [*(member.id for member in crew), UNCLAIMED],
        money_items,
        bill.tax_cents,
        bill.tip_cents,
        bill.split_tip,
        bill.fees_cents,
    )
    return BillTotals(
        people=[
            PersonTotalOut(
                crew_member_id=member.id,
                name=member.name,
                subtotal_cents=totals[member.id].subtotal_cents,
                tax_cents=totals[member.id].tax_cents,
                tip_cents=totals[member.id].tip_cents,
                fees_cents=totals[member.id].fees_cents,
                total_cents=totals[member.id].total_cents,
            )
            for member in crew
        ],
        unclaimed_item_ids=unclaimed_item_ids,
        unclaimed_cents=totals[UNCLAIMED].total_cents,
    )
