import asyncio
import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.websockets import WebSocketDisconnect

from dibs import live
from dibs.live import CLOSE_BILL_NOT_FOUND, CLOSE_TOO_MANY_CONNECTIONS, LiveUpdates, live_updates
from dibs.main import app
from dibs.models import Bill

BILL_ID = uuid.uuid4()


class FakeSocket:
    def __init__(self, error: Exception | None = None, hangs: bool = False) -> None:
        self.sent: list[str] = []
        self.error = error
        self.hangs = hangs

    async def send_text(self, message: str) -> None:
        if self.hangs:
            await asyncio.sleep(60)
        if self.error:
            raise self.error
        self.sent.append(message)


# --- LiveUpdates ---


@pytest.mark.anyio
async def test_notify_reaches_everyone_on_that_bill_only():
    hub = LiveUpdates()
    anna, ben, other_bill = FakeSocket(), FakeSocket(), FakeSocket()
    hub.add(BILL_ID, anna)
    hub.add(BILL_ID, ben)
    hub.add(uuid.uuid4(), other_bill)

    await hub.notify(BILL_ID)

    assert anna.sent == ["changed"]
    assert ben.sent == ["changed"]
    assert other_bill.sent == []


@pytest.mark.anyio
async def test_notify_with_nobody_connected_does_nothing():
    await LiveUpdates().notify(BILL_ID)


@pytest.mark.anyio
async def test_a_dead_connection_is_dropped_and_others_still_hear():
    hub = LiveUpdates()
    dead, alive = FakeSocket(error=RuntimeError("gone")), FakeSocket()
    hub.add(BILL_ID, dead)
    hub.add(BILL_ID, alive)

    await hub.notify(BILL_ID)

    assert alive.sent == ["changed"]
    assert hub.connection_count(BILL_ID) == 1


@pytest.mark.anyio
async def test_a_stuck_connection_cannot_hold_up_a_save(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(live, "SEND_TIMEOUT_SECONDS", 0.01)
    hub = LiveUpdates()
    stuck, alive = FakeSocket(hangs=True), FakeSocket()
    hub.add(BILL_ID, stuck)
    hub.add(BILL_ID, alive)

    await asyncio.wait_for(hub.notify(BILL_ID), timeout=2)

    assert alive.sent == ["changed"]
    assert hub.connection_count(BILL_ID) == 1


def test_removing_the_last_connection_forgets_the_bill():
    hub = LiveUpdates()
    socket = FakeSocket()
    hub.add(BILL_ID, socket)

    hub.remove(BILL_ID, socket)
    hub.remove(BILL_ID, socket)

    assert hub.connection_count(BILL_ID) == 0
    assert BILL_ID not in hub._connections


def test_each_bill_has_a_connection_limit(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(live, "MAX_CONNECTIONS_PER_BILL", 2)
    hub = LiveUpdates()

    assert hub.add(BILL_ID, FakeSocket())
    assert hub.add(BILL_ID, FakeSocket())
    assert not hub.add(BILL_ID, FakeSocket())
    assert hub.add(uuid.uuid4(), FakeSocket())


# --- The WebSocket endpoint, with the bill lookup replaced because it uses its own session ---


@pytest.fixture
def bill_lookup(monkeypatch: pytest.MonkeyPatch) -> None:
    async def find(share_code: str) -> uuid.UUID | None:
        return BILL_ID if share_code == "abc123" else None

    monkeypatch.setattr(live, "find_visible_bill_id", find)


def test_connected_browser_hears_about_changes(bill_lookup: None):
    with (
        TestClient(app) as client,
        client.websocket_connect("/bills/abc123/live") as websocket,
    ):
        assert live_updates.connection_count(BILL_ID) == 1
        client.portal.call(live_updates.notify, BILL_ID)
        assert websocket.receive_text() == "changed"


def test_disconnecting_removes_the_connection(bill_lookup: None):
    with TestClient(app) as client:
        with client.websocket_connect("/bills/abc123/live"):
            pass
        # The server notices the disconnect on its own schedule, so give it a moment.
        for _ in range(100):
            if live_updates.connection_count(BILL_ID) == 0:
                break
            client.portal.call(asyncio.sleep, 0.01)
        assert live_updates.connection_count(BILL_ID) == 0


def test_unknown_or_draft_bill_is_closed_with_a_clear_code(bill_lookup: None):
    with (
        TestClient(app) as client,
        client.websocket_connect("/bills/nope/live") as websocket,
        pytest.raises(WebSocketDisconnect) as closed,
    ):
        websocket.receive_text()

    assert closed.value.code == CLOSE_BILL_NOT_FOUND


def test_too_many_connections_are_turned_away(bill_lookup: None, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(live, "MAX_CONNECTIONS_PER_BILL", 0)

    with (
        TestClient(app) as client,
        client.websocket_connect("/bills/abc123/live") as websocket,
        pytest.raises(WebSocketDisconnect) as closed,
    ):
        # If the limit ever broke, this gives receive_text a message, so the test fails, not hangs.
        client.portal.call(live_updates.notify, BILL_ID)
        websocket.receive_text()

    assert closed.value.code == CLOSE_TOO_MANY_CONNECTIONS


# --- Which requests tell people something changed ---

pytest_anyio = pytest.mark.anyio


@pytest.fixture
def notify(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    mock = AsyncMock()
    monkeypatch.setattr(live_updates, "notify", mock)
    return mock


async def make_bill(client: AsyncClient, session: AsyncSession) -> tuple[dict, uuid.UUID]:
    response = await client.post(
        "/bills",
        json={
            "captain_email": "cap@example.com",
            "captain_name": "Cap",
            "items": [
                {"description": "Burger", "price_cents": 2000},
                {"description": "Salad", "price_cents": 1000},
            ],
        },
    )
    created = response.json()
    bill_id = await session.scalar(
        select(Bill.id).where(Bill.share_code == created["bill"]["share_code"])
    )
    return created, bill_id


@pytest_anyio
async def test_joining_notifies_the_bill(
    client: AsyncClient, session: AsyncSession, notify: AsyncMock
):
    created, bill_id = await make_bill(client, session)

    await client.post(
        f"/bills/{created['bill']['share_code']}/join", json={"name": "Ana", "phone": "555"}
    )

    notify.assert_awaited_once_with(bill_id)


@pytest_anyio
async def test_saving_my_claims_notifies_the_bill(
    client: AsyncClient, session: AsyncSession, notify: AsyncMock
):
    created, bill_id = await make_bill(client, session)
    item_id = created["bill"]["items"][0]["id"]

    await client.put(
        f"/bills/{created['bill']['share_code']}/my-claims",
        json={"item_ids": [item_id]},
        headers={"Authorization": f"Bearer {created['token']}"},
    )

    notify.assert_awaited_once_with(bill_id)


@pytest_anyio
async def test_the_single_item_claim_endpoints_notify_the_bill(
    client: AsyncClient, session: AsyncSession, notify: AsyncMock
):
    created, bill_id = await make_bill(client, session)
    url = f"/items/{created['bill']['items'][0]['id']}/claim"
    headers = {"Authorization": f"Bearer {created['token']}"}

    await client.put(url, json={}, headers=headers)
    await client.delete(url, headers=headers)

    assert notify.await_args_list == [((bill_id,),), ((bill_id,),)]


@pytest_anyio
async def test_failed_requests_and_previews_stay_quiet(
    client: AsyncClient, session: AsyncSession, notify: AsyncMock
):
    created, _ = await make_bill(client, session)
    code = created["bill"]["share_code"]
    headers = {"Authorization": f"Bearer {created['token']}"}

    await client.post(f"/bills/{code}/join", json={"name": "Ana"})
    await client.post(f"/bills/{code}/my-claims/preview", json={"item_ids": []}, headers=headers)
    await client.put(
        f"/bills/{code}/my-claims", json={"item_ids": [str(uuid.uuid4())]}, headers=headers
    )

    notify.assert_not_awaited()
