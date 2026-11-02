import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from dibs.models import Bill, Claim, Settlement

pytestmark = pytest.mark.anyio


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


class Table:
    """A Captain and two crew: burger $20, salad $10, nachos $9, $3.12 tax and $7.80 tip."""

    def __init__(self, client: AsyncClient, created: dict, ana: dict, ben: dict) -> None:
        self.client = client
        self.code = created["bill"]["share_code"]
        self.burger, self.salad, self.nachos = (item["id"] for item in created["bill"]["items"])
        self.cap = auth(created["token"])
        self.ana = auth(ana["token"])
        self.ben = auth(ben["token"])
        self.cap_id = created["crew_member_id"]
        self.ana_id = ana["crew_member_id"]
        self.ben_id = ben["crew_member_id"]

    async def claim(self, headers: dict, *item_ids: str) -> None:
        response = await self.client.put(
            f"/bills/{self.code}/my-claims", json={"item_ids": list(item_ids)}, headers=headers
        )
        assert response.status_code == 200, response.text

    async def lock(self, assignments: dict | None = None, headers: dict | None = None):
        return await self.client.post(
            f"/bills/{self.code}/lock",
            json={"assignments": assignments or {}},
            headers=self.cap if headers is None else headers,
        )

    async def settlements(self) -> dict[str, dict]:
        response = await self.client.get(f"/bills/{self.code}/settlements")
        assert response.status_code == 200, response.text
        return {row["name"]: row for row in response.json()}

    async def status(self) -> str:
        return (await self.client.get(f"/bills/{self.code}")).json()["status"]


async def make_table(client: AsyncClient, email: str = "cap@example.com") -> Table:
    response = await client.post(
        "/bills",
        json={
            "captain_email": email,
            "captain_name": "Cap",
            "tax_cents": 312,
            "tip_cents": 780,
            "items": [
                {"description": "Burger", "price_cents": 2000},
                {"description": "Salad", "price_cents": 1000},
                {"description": "Nachos", "price_cents": 900},
            ],
        },
    )
    created = response.json()
    code = created["bill"]["share_code"]
    ana = await client.post(f"/bills/{code}/join", json={"name": "Ana", "phone": "555"})
    ben = await client.post(f"/bills/{code}/join", json={"name": "Ben", "phone": "556"})
    return Table(client, created, ana.json(), ben.json())


@pytest.fixture
async def table(client: AsyncClient) -> Table:
    return await make_table(client)


# --- Locking ---


async def test_locking_stores_each_persons_final_amount(table: Table):
    await table.claim(table.cap, table.burger, table.nachos)
    await table.claim(table.ana, table.salad, table.nachos)

    response = await table.lock()

    assert response.status_code == 200
    assert response.json()["status"] == "LOCKED"
    rows = await table.settlements()
    assert rows["Ana"]["total_cents"] == 1856
    assert (rows["Ana"]["subtotal_cents"], rows["Ana"]["tax_cents"]) == (1450, 116)
    assert (rows["Ana"]["tip_cents"], rows["Ana"]["status"]) == (290, "OWED")


async def test_the_captain_and_people_owing_nothing_get_no_settlement(table: Table):
    await table.claim(table.ana, table.salad)

    await table.lock()

    assert set(await table.settlements()) == {"Ana"}


async def test_unclaimed_items_go_to_the_captain_by_default(table: Table):
    await table.claim(table.ana, table.salad)

    response = await table.lock()

    claims = {item["description"]: item["claims"] for item in response.json()["items"]}
    assert claims["Burger"] == [{"crew_member_id": table.cap_id, "shares": 1}]
    assert claims["Nachos"] == [{"crew_member_id": table.cap_id, "shares": 1}]
    totals = (await table.client.get(f"/bills/{table.code}/totals")).json()
    assert totals["unclaimed_item_ids"] == []
    assert totals["unclaimed_cents"] == 0


async def test_the_captain_can_assign_unclaimed_items_to_someone(table: Table):
    await table.claim(table.ana, table.salad)

    await table.lock({table.nachos: table.ben_id})

    rows = await table.settlements()
    assert rows["Ben"]["subtotal_cents"] == 900
    assert rows["Ben"]["total_cents"] == 900 + 72 + 180


async def test_final_amounts_add_up_to_the_bill_exactly(table: Table):
    await table.claim(table.ana, table.salad, table.nachos)
    await table.claim(table.ben, table.nachos)

    await table.lock()

    totals = (await table.client.get(f"/bills/{table.code}/totals")).json()
    assert sum(person["total_cents"] for person in totals["people"]) == 4992
    rows = await table.settlements()
    by_person = {person["name"]: person["total_cents"] for person in totals["people"]}
    assert rows["Ana"]["total_cents"] == by_person["Ana"]
    assert rows["Ben"]["total_cents"] == by_person["Ben"]


async def test_preview_matches_the_lock_and_saves_nothing(table: Table, session: AsyncSession):
    await table.claim(table.ana, table.salad)
    assignments = {table.nachos: table.ben_id}

    preview = await table.client.post(
        f"/bills/{table.code}/lock/preview", json={"assignments": assignments}, headers=table.cap
    )

    assert preview.status_code == 200
    previewed = {person["name"]: person["total_cents"] for person in preview.json()["people"]}
    assert await table.status() == "OPEN"
    assert await table.settlements() == {}
    await table.lock(assignments)
    rows = await table.settlements()
    assert rows["Ben"]["total_cents"] == previewed["Ben"]
    assert rows["Ana"]["total_cents"] == previewed["Ana"]
    totals = (await table.client.get(f"/bills/{table.code}/totals")).json()
    assert {p["name"]: p["total_cents"] for p in totals["people"]} == previewed


async def test_a_bill_with_nobody_to_collect_from_is_settled_right_away(table: Table):
    await table.claim(table.cap, table.burger, table.salad, table.nachos)

    response = await table.lock()

    assert response.json()["status"] == "SETTLED"


async def test_locking_twice_is_fine_and_changes_nothing(table: Table):
    await table.claim(table.ana, table.salad)
    await table.lock({table.nachos: table.ben_id})
    before = await table.settlements()

    response = await table.lock({table.nachos: table.ana_id})

    assert response.status_code == 200
    assert await table.settlements() == before


@pytest.mark.parametrize("who", ["no token", "crew", "other captain"])
async def test_only_this_bills_captain_can_lock(table: Table, client: AsyncClient, who: str):
    other = await client.post(
        "/bills",
        json={
            "captain_email": "other@example.com",
            "captain_name": "Other",
            "items": [{"description": "Soup", "price_cents": 500}],
        },
    )
    headers = {
        "no token": {},
        "crew": table.ana,
        "other captain": auth(other.json()["token"]),
    }[who]

    response = await table.client.post(
        f"/bills/{table.code}/lock", json={"assignments": {}}, headers=headers
    )

    assert response.status_code == (401 if who == "no token" else 403)
    assert await table.status() == "OPEN"


async def test_assigning_an_item_someone_just_claimed_is_refused(table: Table):
    await table.claim(table.ana, table.salad)

    response = await table.lock({table.salad: table.ben_id})

    assert response.status_code == 409
    assert "just claimed" in response.json()["detail"]
    assert await table.status() == "OPEN"


async def test_assigning_to_someone_not_on_the_bill_is_refused(table: Table):
    response = await table.lock({table.nachos: str(uuid.uuid4())})

    assert response.status_code == 422
    assert await table.status() == "OPEN"


async def test_a_draft_cannot_be_locked(table: Table, session: AsyncSession):
    bill = await session.scalar(select(Bill).where(Bill.share_code == table.code))
    bill.status = "DRAFT"
    await session.commit()

    response = await table.lock()

    assert response.status_code == 409


# --- After the lock ---


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("PUT", "my-claims", {"item_ids": []}),
        ("POST", "my-claims/preview", {"item_ids": []}),
        ("POST", "join", {"name": "Late", "phone": "1"}),
    ],
)
async def test_nothing_can_change_after_the_lock(table: Table, method: str, path: str, body: dict):
    await table.lock()

    response = await table.client.request(
        method, f"/bills/{table.code}/{path}", json=body, headers=table.ana
    )

    assert response.status_code == 409


async def test_single_item_claims_are_frozen_too(table: Table):
    await table.lock()

    response = await table.client.delete(f"/items/{table.salad}/claim", headers=table.cap)

    assert response.status_code == 409


async def test_stored_amounts_do_not_move_if_claims_change_behind_the_scenes(
    table: Table, session: AsyncSession
):
    await table.claim(table.ana, table.salad)
    await table.lock()
    extra = Claim(line_item_id=uuid.UUID(table.salad), crew_member_id=uuid.UUID(table.ben_id))
    session.add(extra)
    await session.commit()

    assert (await table.settlements())["Ana"]["subtotal_cents"] == 1000


# --- Paying ---


async def pay(table: Table, headers: dict):
    return await table.client.post(f"/bills/{table.code}/settlements/mine/paid", headers=headers)


async def confirm(table: Table, settlement_id: str, headers: dict | None = None):
    return await table.client.post(
        f"/bills/{table.code}/settlements/{settlement_id}/confirm",
        headers=table.cap if headers is None else headers,
    )


async def not_received(table: Table, settlement_id: str, headers: dict | None = None):
    return await table.client.post(
        f"/bills/{table.code}/settlements/{settlement_id}/not-received",
        headers=table.cap if headers is None else headers,
    )


async def test_i_paid_marks_only_my_settlement(table: Table):
    await table.claim(table.ana, table.salad)
    await table.claim(table.ben, table.nachos)
    await table.lock()

    response = await pay(table, table.ana)

    assert response.status_code == 200
    rows = await table.settlements()
    assert rows["Ana"]["status"] == "MARKED_PAID"
    assert rows["Ben"]["status"] == "OWED"


async def test_tapping_i_paid_twice_is_fine(table: Table):
    await table.claim(table.ana, table.salad)
    await table.lock()

    await pay(table, table.ana)
    response = await pay(table, table.ana)

    assert response.status_code == 200
    assert response.json()["status"] == "MARKED_PAID"


async def test_i_paid_needs_a_settlement_on_this_bill(table: Table, client: AsyncClient):
    await table.claim(table.ana, table.salad)
    await table.lock()

    assert (await pay(table, table.ben)).status_code == 404
    assert (await client.post(f"/bills/{table.code}/settlements/mine/paid")).status_code == 401


async def test_i_paid_before_the_lock_has_nothing_to_mark(table: Table):
    assert (await pay(table, table.ana)).status_code == 404


async def test_a_late_i_paid_cannot_undo_a_confirmation(table: Table):
    await table.claim(table.ana, table.salad)
    await table.claim(table.ben, table.nachos)
    await table.lock()
    rows = await table.settlements()
    await confirm(table, rows["Ana"]["id"])

    response = await pay(table, table.ana)

    assert response.json()["status"] == "CONFIRMED"


async def test_captain_confirms_and_the_last_one_settles_the_bill(table: Table):
    await table.claim(table.ana, table.salad)
    await table.claim(table.ben, table.nachos)
    await table.lock()
    rows = await table.settlements()
    await pay(table, table.ana)

    first = await confirm(table, rows["Ana"]["id"])

    assert first.json()["status"] == "CONFIRMED"
    assert await table.status() == "LOCKED"

    # Ben never tapped "I paid", like someone paying in cash.
    second = await confirm(table, rows["Ben"]["id"])

    assert second.json()["status"] == "CONFIRMED"
    assert await table.status() == "SETTLED"


async def test_confirming_twice_is_fine(table: Table):
    await table.claim(table.ana, table.salad)
    await table.lock()
    rows = await table.settlements()

    await confirm(table, rows["Ana"]["id"])
    response = await confirm(table, rows["Ana"]["id"])

    assert response.status_code == 200
    assert await table.status() == "SETTLED"


async def test_not_received_goes_back_to_owed(table: Table):
    await table.claim(table.ana, table.salad)
    await table.lock()
    rows = await table.settlements()
    await pay(table, table.ana)

    response = await not_received(table, rows["Ana"]["id"])

    assert response.json()["status"] == "OWED"
    assert (await pay(table, table.ana)).json()["status"] == "MARKED_PAID"


async def test_a_confirmed_payment_cannot_be_marked_not_received(table: Table):
    await table.claim(table.ana, table.salad)
    await table.claim(table.ben, table.nachos)
    await table.lock()
    rows = await table.settlements()
    await confirm(table, rows["Ana"]["id"])

    assert (await not_received(table, rows["Ana"]["id"])).status_code == 409


@pytest.mark.parametrize("action", [confirm, not_received])
async def test_only_the_captain_can_confirm_or_reject(table: Table, action):
    await table.claim(table.ana, table.salad)
    await table.lock()
    rows = await table.settlements()

    response = await action(table, rows["Ana"]["id"], table.ana)

    assert response.status_code == 403
    assert (await table.settlements())["Ana"]["status"] == "OWED"


@pytest.mark.parametrize("action", [confirm, not_received])
async def test_a_settlement_from_another_bill_is_not_found(
    table: Table, client: AsyncClient, action
):
    other = await make_table(client, "other@example.com")
    await other.claim(other.ana, other.burger)
    await other.lock()
    other_settlement = (await other.settlements())["Ana"]["id"]

    assert (await action(table, other_settlement)).status_code == 404
    assert (await other.settlements())["Ana"]["status"] == "OWED"


# --- Reopening ---


async def test_reopening_clears_settlements_and_lets_people_change_claims(table: Table):
    await table.claim(table.ana, table.salad)
    await table.lock()

    response = await table.client.post(f"/bills/{table.code}/reopen", headers=table.cap)

    assert response.status_code == 200
    assert response.json()["status"] == "OPEN"
    assert await table.settlements() == {}
    await table.claim(table.ana, table.salad, table.nachos)


async def test_a_new_lock_after_reopening_uses_the_new_claims(table: Table):
    await table.claim(table.ana, table.salad)
    await table.lock()
    await table.client.post(f"/bills/{table.code}/reopen", headers=table.cap)
    await table.claim(table.ana, table.burger)

    await table.lock()

    assert (await table.settlements())["Ana"]["subtotal_cents"] == 2000


async def test_reopening_undoes_what_the_lock_assigned_but_keeps_real_claims(table: Table):
    await table.claim(table.ana, table.salad)
    await table.lock({table.nachos: table.ben_id})

    response = await table.client.post(f"/bills/{table.code}/reopen", headers=table.cap)

    claims = {item["description"]: item["claims"] for item in response.json()["items"]}
    assert claims["Burger"] == []
    assert claims["Nachos"] == []
    assert claims["Salad"] == [{"crew_member_id": table.ana_id, "shares": 1}]


async def test_reopening_only_touches_its_own_bill(table: Table, client: AsyncClient):
    other = await make_table(client, "other@example.com")
    await other.lock()
    await table.lock()

    await client.post(f"/bills/{table.code}/reopen", headers=table.cap)

    other_bill = (await client.get(f"/bills/{other.code}")).json()
    assert all(item["claims"] for item in other_bill["items"])


async def test_reopening_is_refused_once_someone_has_paid(table: Table):
    await table.claim(table.ana, table.salad)
    await table.claim(table.ben, table.nachos)
    await table.lock()
    await pay(table, table.ana)

    response = await table.client.post(f"/bills/{table.code}/reopen", headers=table.cap)

    assert response.status_code == 409
    assert await table.status() == "LOCKED"
    assert len(await table.settlements()) == 2


async def test_only_the_captain_can_reopen(table: Table):
    await table.lock()

    response = await table.client.post(f"/bills/{table.code}/reopen", headers=table.ana)

    assert response.status_code == 403


async def test_a_settled_bill_cannot_be_reopened(table: Table):
    await table.claim(table.cap, table.burger, table.salad, table.nachos)
    await table.lock()

    response = await table.client.post(f"/bills/{table.code}/reopen", headers=table.cap)

    assert response.status_code == 409


async def test_reopening_an_open_bill_is_fine(table: Table):
    response = await table.client.post(f"/bills/{table.code}/reopen", headers=table.cap)

    assert response.status_code == 200
    assert response.json()["status"] == "OPEN"


# --- The database's own rules ---


@pytest.mark.parametrize(
    ("field", "value", "constraint"),
    [
        ("status", "NOPE", "ck_settlement_status_valid"),
        ("total_cents", -1, "ck_settlement_amounts_not_negative"),
    ],
)
async def test_database_rejects_bad_settlements(
    table: Table, session: AsyncSession, field: str, value: object, constraint: str
):
    await table.claim(table.ana, table.salad)
    await table.lock()
    settlement = await session.scalar(select(Settlement))

    with pytest.raises(IntegrityError, match=constraint):
        async with session.begin_nested():
            setattr(settlement, field, value)
            await session.flush()


async def test_a_person_can_only_have_one_settlement(table: Table, session: AsyncSession):
    await table.claim(table.ana, table.salad)
    await table.lock()
    existing = await session.scalar(select(Settlement))

    with pytest.raises(IntegrityError, match="uq_settlement_crew_member_id"):
        async with session.begin_nested():
            session.add(
                Settlement(
                    bill_id=existing.bill_id,
                    crew_member_id=existing.crew_member_id,
                    subtotal_cents=0,
                    tax_cents=0,
                    tip_cents=0,
                    fees_cents=0,
                    total_cents=0,
                )
            )
            await session.flush()
