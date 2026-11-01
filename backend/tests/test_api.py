import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dibs.models import Bill, Captain, Claim, CrewMember
from dibs.routes import hash_token

pytestmark = pytest.mark.anyio


def bill_body(**overrides) -> dict:
    return {
        "captain_email": "cap@example.com",
        "captain_name": "Cap",
        "restaurant_name": "Luigi's",
        "tax_cents": 312,
        "tip_cents": 780,
        "items": [
            {"description": "Burger", "price_cents": 2000},
            {"description": "Salad", "price_cents": 1000},
            {"description": "Nachos", "price_cents": 900},
        ],
    } | overrides


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def create_bill(client: AsyncClient, **overrides) -> dict:
    response = await client.post("/bills", json=bill_body(**overrides))
    assert response.status_code == 201, response.text
    return response.json()


async def join(client: AsyncClient, share_code: str, name: str = "Ana") -> dict:
    response = await client.post(
        f"/bills/{share_code}/join", json={"name": name, "email": f"{name}@example.com"}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def set_status(session: AsyncSession, share_code: str, new_status: str) -> None:
    await session.execute(
        update(Bill).where(Bill.share_code == share_code).values(status=new_status)
    )
    await session.commit()


async def claim(client: AsyncClient, item_id: str, token: str, shares: int = 1) -> None:
    response = await client.put(
        f"/items/{item_id}/claim", json={"shares": shares}, headers=auth(token)
    )
    assert response.status_code == 200, response.text


def by_name(totals: dict) -> dict[str, tuple[int, int, int, int]]:
    return {
        person["name"]: (
            person["subtotal_cents"],
            person["tax_cents"],
            person["tip_cents"],
            person["total_cents"],
        )
        for person in totals["people"]
    }


# --- POST /bills ---


async def test_create_bill_is_open_with_computed_amounts_and_items_in_order(client: AsyncClient):
    created = await create_bill(client)
    bill = created["bill"]

    assert bill["status"] == "OPEN"
    assert bill["subtotal_cents"] == 3900
    assert bill["total_cents"] == 3900 + 312 + 780
    assert bill["split_tip"] is True
    assert [item["description"] for item in bill["items"]] == ["Burger", "Salad", "Nachos"]
    assert [item["position"] for item in bill["items"]] == [0, 1, 2]


async def test_create_bill_adds_captain_to_crew_and_stores_only_a_token_hash(
    client: AsyncClient, session: AsyncSession
):
    created = await create_bill(client)

    assert created["bill"]["crew"] == [
        {"id": created["crew_member_id"], "name": "Cap", "is_captain": True}
    ]
    row = await session.get_one(CrewMember, uuid.UUID(created["crew_member_id"]))
    assert row.token_hash == hash_token(created["token"])
    assert row.token_hash != created["token"]


async def test_create_bill_reuses_captain_ignoring_email_case_and_keeps_their_name(
    client: AsyncClient, session: AsyncSession
):
    first = await create_bill(client, captain_email="cap@example.com", captain_name="Cap")
    second = await create_bill(client, captain_email="CAP@example.com", captain_name="Impostor")

    first_bill = await session.scalar(
        select(Bill).where(Bill.share_code == first["bill"]["share_code"])
    )
    second_bill = await session.scalar(
        select(Bill).where(Bill.share_code == second["bill"]["share_code"])
    )
    assert first_bill.captain_id == second_bill.captain_id
    assert first["bill"]["share_code"] != second["bill"]["share_code"]
    captain = await session.get_one(Captain, first_bill.captain_id)
    assert captain.display_name == "Cap"


@pytest.mark.parametrize(
    "overrides",
    [
        {"items": []},
        {"captain_email": "not-an-email"},
        {"captain_name": "   "},
        {"tax_cents": -1},
        {"tip_cents": 12.5},
        {"tip_cents": 12.0},
        {"tax_cents": 10_000_001},
        {"items": [{"description": "Soup", "price_cents": -1}]},
        {"items": [{"description": "Soup", "price_cents": 10.5}]},
        {"items": [{"description": "", "price_cents": 100}]},
        {"items": [{"description": "Soup", "price_cents": 10_000_001}]},
        {"items": [{"description": "Soup", "price_cents": 100}] * 201},
        # Nothing to split the tax against.
        {"items": [{"description": "Comped", "price_cents": 0}], "tax_cents": 100},
    ],
)
async def test_create_bill_rejects_bad_input(client: AsyncClient, overrides: dict):
    response = await client.post("/bills", json=bill_body(**overrides))

    assert response.status_code == 422


async def test_largest_allowed_bill_fits_in_the_database(client: AsyncClient):
    created = await create_bill(
        client,
        tax_cents=10_000_000,
        tip_cents=10_000_000,
        items=[{"description": "Wine", "price_cents": 10_000_000}] * 200,
    )

    assert created["bill"]["total_cents"] == 2_020_000_000


# --- GET /bills/{share_code} ---


async def test_get_bill_shows_items_crew_and_claims(client: AsyncClient):
    created = await create_bill(client)
    code = created["bill"]["share_code"]
    joined = await join(client, code)
    burger = created["bill"]["items"][0]
    await claim(client, burger["id"], joined["token"], shares=2)

    response = await client.get(f"/bills/{code}")

    assert response.status_code == 200
    bill = response.json()
    assert bill["items"][0]["claims"] == [{"crew_member_id": joined["crew_member_id"], "shares": 2}]
    assert bill["items"][1]["claims"] == []
    assert {member["name"] for member in bill["crew"]} == {"Cap", "Ana"}


async def test_get_bill_never_reveals_contact_details_or_tokens(client: AsyncClient):
    created = await create_bill(client)
    code = created["bill"]["share_code"]
    joined = await join(client, code)

    text = (await client.get(f"/bills/{code}")).text

    assert "@example.com" not in text
    assert "token" not in text
    assert joined["token"] not in text
    assert created["token"] not in text


async def test_get_unknown_bill_is_404(client: AsyncClient):
    assert (await client.get("/bills/nope")).status_code == 404


async def test_draft_bill_is_hidden_from_the_crew(client: AsyncClient, session: AsyncSession):
    created = await create_bill(client)
    code = created["bill"]["share_code"]
    await set_status(session, code, "DRAFT")

    assert (await client.get(f"/bills/{code}")).status_code == 404
    assert (await client.get(f"/bills/{code}/totals")).status_code == 404
    response = await client.post(f"/bills/{code}/join", json={"name": "Ana", "phone": "555"})
    assert response.status_code == 404


# --- POST /bills/{share_code}/join ---


async def test_join_with_phone_only_stores_a_token_hash(client: AsyncClient, session: AsyncSession):
    code = (await create_bill(client))["bill"]["share_code"]

    response = await client.post(f"/bills/{code}/join", json={"name": "Ana", "phone": "555-0100"})

    assert response.status_code == 201
    joined = response.json()
    row = await session.get_one(CrewMember, uuid.UUID(joined["crew_member_id"]))
    assert row.phone == "555-0100"
    assert row.is_captain is False
    assert row.token_hash == hash_token(joined["token"])


async def test_join_cannot_make_someone_the_captain(client: AsyncClient, session: AsyncSession):
    code = (await create_bill(client))["bill"]["share_code"]

    response = await client.post(
        f"/bills/{code}/join", json={"name": "Ana", "phone": "555", "is_captain": True}
    )

    row = await session.get_one(CrewMember, uuid.UUID(response.json()["crew_member_id"]))
    assert row.is_captain is False


@pytest.mark.parametrize(
    "body",
    [
        {"name": "Ana"},
        {"name": "  ", "phone": "555"},
        {"name": "Ana", "phone": ""},
        {"name": "Ana", "email": "not-an-email"},
    ],
)
async def test_join_rejects_bad_input(client: AsyncClient, body: dict):
    code = (await create_bill(client))["bill"]["share_code"]

    assert (await client.post(f"/bills/{code}/join", json=body)).status_code == 422


async def test_join_unknown_bill_is_404(client: AsyncClient):
    response = await client.post("/bills/nope/join", json={"name": "Ana", "phone": "555"})

    assert response.status_code == 404


async def test_cannot_join_a_locked_bill(client: AsyncClient, session: AsyncSession):
    code = (await create_bill(client))["bill"]["share_code"]
    await set_status(session, code, "LOCKED")

    response = await client.post(f"/bills/{code}/join", json={"name": "Ana", "phone": "555"})

    assert response.status_code == 409


# --- PUT and DELETE /items/{item_id}/claim ---


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}])
async def test_claiming_needs_a_valid_token(client: AsyncClient, method: str, headers: dict):
    item_id = (await create_bill(client))["bill"]["items"][0]["id"]

    kwargs = {"json": {}} if method == "PUT" else {}
    response = await client.request(method, f"/items/{item_id}/claim", headers=headers, **kwargs)

    assert response.status_code == 401


async def test_shares_default_to_one(client: AsyncClient):
    created = await create_bill(client)
    item_id = created["bill"]["items"][0]["id"]

    response = await client.put(f"/items/{item_id}/claim", json={}, headers=auth(created["token"]))

    assert response.status_code == 200
    assert response.json() == {
        "line_item_id": item_id,
        "crew_member_id": created["crew_member_id"],
        "shares": 1,
    }


async def test_claiming_twice_leaves_one_claim_with_the_latest_shares(
    client: AsyncClient, session: AsyncSession
):
    created = await create_bill(client)
    item_id = created["bill"]["items"][0]["id"]

    await claim(client, item_id, created["token"])
    await claim(client, item_id, created["token"], shares=3)

    claims = (await session.scalars(select(Claim))).all()
    matching = [c for c in claims if str(c.line_item_id) == item_id]
    assert [c.shares for c in matching] == [3]


@pytest.mark.parametrize("shares", [0, -1, 101, 1.5])
async def test_claim_rejects_bad_shares(client: AsyncClient, shares):
    created = await create_bill(client)
    item_id = created["bill"]["items"][0]["id"]

    response = await client.put(
        f"/items/{item_id}/claim", json={"shares": shares}, headers=auth(created["token"])
    )

    assert response.status_code == 422


@pytest.mark.parametrize("method", ["PUT", "DELETE"])
async def test_cannot_touch_an_item_on_another_bill(client: AsyncClient, method: str):
    mine = await create_bill(client)
    other = await create_bill(client, captain_email="other@example.com")
    other_item_id = other["bill"]["items"][0]["id"]

    kwargs = {"json": {}} if method == "PUT" else {}
    response = await client.request(
        method, f"/items/{other_item_id}/claim", headers=auth(mine["token"]), **kwargs
    )

    assert response.status_code == 404
    assert (await client.get(f"/bills/{other['bill']['share_code']}")).json()["items"][0][
        "claims"
    ] == []


async def test_claiming_an_unknown_item_is_404(client: AsyncClient):
    created = await create_bill(client)

    response = await client.put(
        f"/items/{uuid.uuid4()}/claim", json={}, headers=auth(created["token"])
    )

    assert response.status_code == 404


async def test_unclaim_removes_only_your_own_claim(client: AsyncClient):
    created = await create_bill(client)
    code = created["bill"]["share_code"]
    joined = await join(client, code)
    item_id = created["bill"]["items"][2]["id"]
    await claim(client, item_id, created["token"])
    await claim(client, item_id, joined["token"])

    response = await client.delete(f"/items/{item_id}/claim", headers=auth(joined["token"]))

    assert response.status_code == 204
    claims = (await client.get(f"/bills/{code}")).json()["items"][2]["claims"]
    assert claims == [{"crew_member_id": created["crew_member_id"], "shares": 1}]


async def test_unclaiming_something_you_never_claimed_still_succeeds(client: AsyncClient):
    created = await create_bill(client)
    item_id = created["bill"]["items"][0]["id"]

    response = await client.delete(f"/items/{item_id}/claim", headers=auth(created["token"]))

    assert response.status_code == 204


@pytest.mark.parametrize("bill_status", ["LOCKED", "SETTLED"])
@pytest.mark.parametrize("method", ["PUT", "DELETE"])
async def test_claims_are_frozen_once_a_bill_is_not_open(
    client: AsyncClient, session: AsyncSession, method: str, bill_status: str
):
    created = await create_bill(client)
    await set_status(session, created["bill"]["share_code"], bill_status)
    item_id = created["bill"]["items"][0]["id"]

    kwargs = {"json": {}} if method == "PUT" else {}
    response = await client.request(
        method, f"/items/{item_id}/claim", headers=auth(created["token"]), **kwargs
    )

    assert response.status_code == 409


# --- PUT and POST preview /bills/{share_code}/my-claims ---


async def bill_with_ana(client: AsyncClient) -> tuple[dict, dict, str, list[str]]:
    created = await create_bill(client)
    code = created["bill"]["share_code"]
    joined = await join(client, code)
    return created, joined, code, [item["id"] for item in created["bill"]["items"]]


async def my_claims(client: AsyncClient, code: str, token: str, item_ids: list[str]):
    return await client.put(
        f"/bills/{code}/my-claims", json={"item_ids": item_ids}, headers=auth(token)
    )


def claimers(bill: dict) -> list[list[str]]:
    return [[claim["crew_member_id"] for claim in item["claims"]] for item in bill["items"]]


async def test_my_claims_saves_every_item_and_returns_my_total(client: AsyncClient):
    _, joined, code, (burger, salad, nachos) = await bill_with_ana(client)

    response = await my_claims(client, code, joined["token"], [burger, salad])

    assert response.status_code == 200
    assert response.json()["claimed_cents"] == 3000
    assert response.json()["total_cents"] == 3000 + 240 + 600
    bill = (await client.get(f"/bills/{code}")).json()
    ana = joined["crew_member_id"]
    assert claimers(bill) == [[ana], [ana], []]


async def test_my_claims_replaces_what_i_had(client: AsyncClient):
    _, joined, code, (burger, salad, nachos) = await bill_with_ana(client)
    await my_claims(client, code, joined["token"], [burger, salad])

    await my_claims(client, code, joined["token"], [salad, nachos])

    bill = (await client.get(f"/bills/{code}")).json()
    ana = joined["crew_member_id"]
    assert claimers(bill) == [[], [ana], [ana]]


async def test_empty_my_claims_drops_everything(client: AsyncClient):
    _, joined, code, (burger, salad, nachos) = await bill_with_ana(client)
    await my_claims(client, code, joined["token"], [burger])

    response = await my_claims(client, code, joined["token"], [])

    assert response.status_code == 200
    assert response.json()["total_cents"] == 0
    assert claimers((await client.get(f"/bills/{code}")).json()) == [[], [], []]


async def test_my_claims_leaves_other_people_alone_and_shares_items(client: AsyncClient):
    created, joined, code, (burger, salad, nachos) = await bill_with_ana(client)
    await my_claims(client, code, created["token"], [nachos, burger])

    await my_claims(client, code, joined["token"], [nachos])
    await my_claims(client, code, joined["token"], [nachos, salad])

    bill = (await client.get(f"/bills/{code}")).json()
    cap, ana = created["crew_member_id"], joined["crew_member_id"]
    assert claimers(bill)[0] == [cap]
    assert claimers(bill)[1] == [ana]
    assert set(claimers(bill)[2]) == {cap, ana}
    totals = (await client.get(f"/bills/{code}/totals")).json()
    assert by_name(totals)["Ana"][0] == 1000 + 450


async def test_my_claims_is_idempotent_and_ignores_repeats(client: AsyncClient):
    _, joined, code, (burger, _salad, _nachos) = await bill_with_ana(client)

    await my_claims(client, code, joined["token"], [burger, burger])
    response = await my_claims(client, code, joined["token"], [burger])

    assert response.status_code == 200
    assert claimers((await client.get(f"/bills/{code}")).json())[0] == [joined["crew_member_id"]]


async def test_my_claims_keeps_an_existing_share_count(client: AsyncClient):
    _, joined, code, (burger, salad, _nachos) = await bill_with_ana(client)
    await claim(client, burger, joined["token"], shares=3)

    await my_claims(client, code, joined["token"], [burger, salad])

    bill = (await client.get(f"/bills/{code}")).json()
    assert bill["items"][0]["claims"][0]["shares"] == 3


@pytest.mark.parametrize("path", ["my-claims", "my-claims/preview"])
async def test_my_claims_rejects_items_from_another_bill(client: AsyncClient, path: str):
    _, joined, code, (burger, _salad, _nachos) = await bill_with_ana(client)
    other = await create_bill(client, captain_email="other@example.com")
    other_item = other["bill"]["items"][0]["id"]
    method = "PUT" if path == "my-claims" else "POST"

    response = await client.request(
        method,
        f"/bills/{code}/{path}",
        json={"item_ids": [burger, other_item]},
        headers=auth(joined["token"]),
    )

    assert response.status_code == 404
    assert claimers((await client.get(f"/bills/{code}")).json()) == [[], [], []]


async def test_my_claims_rejects_an_unknown_item(client: AsyncClient):
    _, joined, code, _ = await bill_with_ana(client)

    response = await my_claims(client, code, joined["token"], [str(uuid.uuid4())])

    assert response.status_code == 404


@pytest.mark.parametrize(("method", "path"), [("PUT", "my-claims"), ("POST", "my-claims/preview")])
async def test_my_claims_needs_a_token_for_this_bill(client: AsyncClient, method: str, path: str):
    _, _, code, _ = await bill_with_ana(client)
    other = await create_bill(client, captain_email="other@example.com")
    url = f"/bills/{code}/{path}"
    body = {"item_ids": []}

    assert (await client.request(method, url, json=body)).status_code == 401
    wrong_bill = await client.request(method, url, json=body, headers=auth(other["token"]))
    assert wrong_bill.status_code == 403


@pytest.mark.parametrize(("method", "path"), [("PUT", "my-claims"), ("POST", "my-claims/preview")])
async def test_my_claims_are_frozen_once_a_bill_is_locked(
    client: AsyncClient, session: AsyncSession, method: str, path: str
):
    _, joined, code, (burger, _salad, _nachos) = await bill_with_ana(client)
    await set_status(session, code, "LOCKED")

    response = await client.request(
        method, f"/bills/{code}/{path}", json={"item_ids": [burger]}, headers=auth(joined["token"])
    )

    assert response.status_code == 409


async def test_preview_shows_the_total_without_saving_anything(client: AsyncClient):
    created, joined, code, (burger, salad, nachos) = await bill_with_ana(client)
    await claim(client, nachos, created["token"])

    response = await client.post(
        f"/bills/{code}/my-claims/preview",
        json={"item_ids": [salad, nachos]},
        headers=auth(joined["token"]),
    )

    assert response.status_code == 200
    assert response.json()["claimed_cents"] == 1000 + 450
    assert response.json()["tax_cents"] == 116
    assert response.json()["total_cents"] == 1450 + 116 + 290
    assert claimers((await client.get(f"/bills/{code}")).json()) == [
        [],
        [],
        [created["crew_member_id"]],
    ]


async def test_preview_can_drop_an_item_i_already_claimed(client: AsyncClient):
    _, joined, code, (burger, salad, _nachos) = await bill_with_ana(client)
    await my_claims(client, code, joined["token"], [burger])

    response = await client.post(
        f"/bills/{code}/my-claims/preview",
        json={"item_ids": [salad]},
        headers=auth(joined["token"]),
    )

    assert response.json()["claimed_cents"] == 1000


async def test_preview_matches_what_saving_returns(client: AsyncClient):
    created, joined, code, (burger, salad, nachos) = await bill_with_ana(client)
    await claim(client, nachos, created["token"])
    body = {"item_ids": [salad, nachos]}
    headers = auth(joined["token"])

    preview = await client.post(f"/bills/{code}/my-claims/preview", json=body, headers=headers)
    saved = await client.put(f"/bills/{code}/my-claims", json=body, headers=headers)

    assert preview.json() == saved.json()


async def test_captain_preview_counts_what_stays_unclaimed(client: AsyncClient):
    created, _, code, (burger, salad, nachos) = await bill_with_ana(client)

    response = await client.post(
        f"/bills/{code}/my-claims/preview",
        json={"item_ids": [salad]},
        headers=auth(created["token"]),
    )

    assert response.json()["claimed_cents"] == 1000
    assert response.json()["unclaimed_cents"] == 2900
    assert response.json()["total_cents"] == 4992


# --- Payment info ---


async def test_payment_info_is_saved_on_the_bill_for_the_crew_to_see(client: AsyncClient):
    created = await create_bill(
        client, venmo_handle=" @brandon ", cashapp_tag="$brandon", zelle_contact="555-0100"
    )

    bill = (await client.get(f"/bills/{created['bill']['share_code']}")).json()

    assert bill["venmo_handle"] == "@brandon"
    assert bill["cashapp_tag"] == "$brandon"
    assert bill["zelle_contact"] == "555-0100"


async def test_payment_info_is_optional(client: AsyncClient):
    bill = (await create_bill(client))["bill"]

    assert (bill["venmo_handle"], bill["cashapp_tag"], bill["zelle_contact"]) == (None, None, None)


async def test_a_second_bill_cannot_change_another_bills_payment_info(client: AsyncClient):
    first = await create_bill(client, venmo_handle="@real")
    await create_bill(client, venmo_handle="@stranger")

    bill = (await client.get(f"/bills/{first['bill']['share_code']}")).json()

    assert bill["venmo_handle"] == "@real"


@pytest.mark.parametrize("field", ["venmo_handle", "cashapp_tag"])
async def test_overlong_payment_info_is_rejected(client: AsyncClient, field: str):
    response = await client.post("/bills", json=bill_body(**{field: "x" * 51}))

    assert response.status_code == 422


# --- GET /bills/{share_code}/totals ---


async def test_totals_split_shared_items_tax_and_tip(client: AsyncClient):
    created = await create_bill(client)
    code = created["bill"]["share_code"]
    joined = await join(client, code)
    burger, salad, nachos = (item["id"] for item in created["bill"]["items"])
    await claim(client, burger, created["token"])
    await claim(client, salad, joined["token"])
    await claim(client, nachos, created["token"])
    await claim(client, nachos, joined["token"])

    totals = (await client.get(f"/bills/{code}/totals")).json()

    assert by_name(totals) == {
        "Cap": (2450, 196, 490, 3136),
        "Ana": (1450, 116, 290, 1856),
    }
    assert totals["unclaimed_item_ids"] == []


async def test_totals_use_uneven_shares(client: AsyncClient):
    created = await create_bill(
        client, tax_cents=0, tip_cents=0, items=[{"description": "Pizza", "price_cents": 1800}]
    )
    code = created["bill"]["share_code"]
    joined = await join(client, code)
    pizza = created["bill"]["items"][0]["id"]
    await claim(client, pizza, created["token"], shares=2)
    await claim(client, pizza, joined["token"])

    totals = (await client.get(f"/bills/{code}/totals")).json()

    assert by_name(totals) == {"Cap": (1200, 0, 0, 1200), "Ana": (600, 0, 0, 600)}


async def test_unclaimed_items_count_as_the_captains_and_are_listed(client: AsyncClient):
    created = await create_bill(client)
    code = created["bill"]["share_code"]
    joined = await join(client, code)
    burger, salad, nachos = (item["id"] for item in created["bill"]["items"])
    await claim(client, salad, joined["token"])

    totals = (await client.get(f"/bills/{code}/totals")).json()

    assert by_name(totals)["Cap"][0] == 2900
    assert by_name(totals)["Ana"][0] == 1000
    assert totals["unclaimed_item_ids"] == [burger, nachos]


async def test_totals_separate_what_the_captain_claimed_from_what_is_unclaimed(client: AsyncClient):
    created = await create_bill(client)
    code = created["bill"]["share_code"]
    joined = await join(client, code)
    burger, salad, _ = (item["id"] for item in created["bill"]["items"])
    await claim(client, salad, created["token"])
    await claim(client, burger, joined["token"])

    totals = (await client.get(f"/bills/{code}/totals")).json()

    people = {person["name"]: person for person in totals["people"]}
    assert (people["Cap"]["claimed_cents"], people["Cap"]["unclaimed_cents"]) == (1000, 900)
    assert people["Cap"]["subtotal_cents"] == 1900
    assert (people["Ana"]["claimed_cents"], people["Ana"]["unclaimed_cents"]) == (2000, 0)


async def test_captain_with_everything_claimed_has_nothing_unclaimed(client: AsyncClient):
    created = await create_bill(client)
    code = created["bill"]["share_code"]
    for item in created["bill"]["items"]:
        await claim(client, item["id"], created["token"])

    totals = (await client.get(f"/bills/{code}/totals")).json()

    assert totals["people"][0]["claimed_cents"] == 3900
    assert totals["people"][0]["unclaimed_cents"] == 0


async def test_captain_can_cover_the_tip(client: AsyncClient):
    created = await create_bill(client, split_tip=False)
    code = created["bill"]["share_code"]
    joined = await join(client, code)
    burger, salad, nachos = (item["id"] for item in created["bill"]["items"])
    await claim(client, salad, joined["token"])

    totals = by_name((await client.get(f"/bills/{code}/totals")).json())

    assert totals["Cap"][2] == 780
    assert totals["Ana"][2] == 0
    assert totals["Ana"][1] == 80  # 1000/3900 of the 312 tax, which is still split.


async def test_tied_cent_goes_to_the_captain(client: AsyncClient):
    created = await create_bill(
        client, tax_cents=0, tip_cents=0, items=[{"description": "Pie", "price_cents": 1000}]
    )
    code = created["bill"]["share_code"]
    ana = await join(client, code, "Ana")
    ben = await join(client, code, "Ben")
    pie = created["bill"]["items"][0]["id"]
    for token in (ana["token"], ben["token"], created["token"]):
        await claim(client, pie, token)

    totals = by_name((await client.get(f"/bills/{code}/totals")).json())

    assert totals["Cap"][0] == 334
    assert totals["Ana"][0] == 333
    assert totals["Ben"][0] == 333


async def test_fees_are_in_the_bill_total_and_split_in_proportion(client: AsyncClient):
    created = await create_bill(client, tax_cents=0, tip_cents=0, fees_cents=390)
    code = created["bill"]["share_code"]
    joined = await join(client, code)
    burger, salad, nachos = (item["id"] for item in created["bill"]["items"])
    await claim(client, salad, joined["token"])

    totals = (await client.get(f"/bills/{code}/totals")).json()

    assert created["bill"]["fees_cents"] == 390
    assert created["bill"]["total_cents"] == 4290
    fees = {person["name"]: person["fees_cents"] for person in totals["people"]}
    assert fees == {"Cap": 290, "Ana": 100}
    assert sum(person["total_cents"] for person in totals["people"]) == 4290


async def test_fees_need_an_item_with_a_price(client: AsyncClient):
    response = await client.post(
        "/bills",
        json=bill_body(
            tax_cents=0,
            tip_cents=0,
            fees_cents=100,
            items=[{"description": "Comped", "price_cents": 0}],
        ),
    )

    assert response.status_code == 422


async def test_totals_always_add_up_to_the_bill_exactly(client: AsyncClient):
    created = await create_bill(
        client,
        tax_cents=87,
        tip_cents=133,
        fees_cents=311,
        items=[
            {"description": "Shared", "price_cents": 1000},
            {"description": "Mine", "price_cents": 1333},
            {"description": "Unclaimed", "price_cents": 777},
        ],
    )
    code = created["bill"]["share_code"]
    ana = await join(client, code, "Ana")
    ben = await join(client, code, "Ben")
    shared, mine, _ = (item["id"] for item in created["bill"]["items"])
    for token in (created["token"], ana["token"], ben["token"]):
        await claim(client, shared, token)
    await claim(client, mine, ana["token"])

    totals = (await client.get(f"/bills/{code}/totals")).json()

    assert (
        sum(person["total_cents"] for person in totals["people"])
        == 1000 + 1333 + 777 + 87 + 133 + 311
    )


async def test_totals_work_when_nothing_is_priced(client: AsyncClient):
    created = await create_bill(
        client, tax_cents=0, tip_cents=0, items=[{"description": "Comped", "price_cents": 0}]
    )

    response = await client.get(f"/bills/{created['bill']['share_code']}/totals")

    assert response.status_code == 200
    assert by_name(response.json()) == {"Cap": (0, 0, 0, 0)}


async def test_totals_for_unknown_bill_are_404(client: AsyncClient):
    assert (await client.get("/bills/nope/totals")).status_code == 404


# The fixture rollback is what keeps this suite repeatable, so make sure the rows really are
# there inside the test: if commits weren't reaching this connection, the tests above would be
# passing for the wrong reason.
async def test_requests_share_the_tests_transaction(client: AsyncClient, session: AsyncSession):
    created = await create_bill(client)

    count = await session.scalar(
        select(func.count())
        .select_from(Bill)
        .where(Bill.share_code == created["bill"]["share_code"])
    )

    assert count == 1
