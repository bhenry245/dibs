# Live updates: tells everyone looking at a bill that it changed, so their screens can refetch it.

# The message carries no bill data, so the existing endpoints stay the only way to read a bill, and
# a missed message can't leave anyone with wrong numbers for long. Connections live in this
# process's memory, which only works with one server. Running several needs Redis to pass messages
# between them (design doc §12).

import asyncio
import logging
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import select

from dibs.db import SessionLocal
from dibs.models import Bill

logger = logging.getLogger(__name__)

router = APIRouter()

CHANGED_MESSAGE = "changed"
# Keeps one bill's link from being used to hold open unlimited connections.
MAX_CONNECTIONS_PER_BILL = 100
# A stuck phone shouldn't hold up everyone else's update.
SEND_TIMEOUT_SECONDS = 5
# Our own close codes. Browsers only see the reason for codes in the 4000 range.
CLOSE_BILL_NOT_FOUND = 4404
CLOSE_TOO_MANY_CONNECTIONS = 4429


class LiveUpdates:
    def __init__(self) -> None:
        self._connections: dict[uuid.UUID, set[WebSocket]] = {}

    def connection_count(self, bill_id: uuid.UUID) -> int:
        return len(self._connections.get(bill_id, ()))

    def add(self, bill_id: uuid.UUID, websocket: WebSocket) -> bool:
        if self.connection_count(bill_id) >= MAX_CONNECTIONS_PER_BILL:
            return False
        self._connections.setdefault(bill_id, set()).add(websocket)
        return True

    def remove(self, bill_id: uuid.UUID, websocket: WebSocket) -> None:
        connections = self._connections.get(bill_id)
        if connections is None:
            return
        connections.discard(websocket)
        if not connections:
            del self._connections[bill_id]

    # Call this after committing, so anyone who refetches is guaranteed to see the change. It never
    # raises, because the change has already been saved and one bad connection shouldn't fail that
    # request.
    async def notify(self, bill_id: uuid.UUID) -> None:
        connections = list(self._connections.get(bill_id, ()))

        async def send(websocket: WebSocket) -> None:
            try:
                await asyncio.wait_for(
                    websocket.send_text(CHANGED_MESSAGE), timeout=SEND_TIMEOUT_SECONDS
                )
            except Exception:
                logger.info("Dropping a live connection that couldn't be reached", exc_info=True)
                self.remove(bill_id, websocket)

        await asyncio.gather(*(send(websocket) for websocket in connections))


live_updates = LiveUpdates()


# The bill's id, if the crew can see it. Uses its own short session, because a Depends session would
# hold a database connection open for as long as the socket stays connected.
async def find_visible_bill_id(share_code: str) -> uuid.UUID | None:
    async with SessionLocal() as session:
        result = await session.execute(
            select(Bill.id).where(Bill.share_code == share_code, Bill.status != "DRAFT")
        )
        return result.scalar_one_or_none()


# Needs no token, because it only ever says "changed", and anyone with the share code can already
# read the bill.
@router.websocket("/bills/{share_code}/live")
async def bill_updates(websocket: WebSocket, share_code: str) -> None:
    # Accepting first means the browser receives our close code instead of a generic failure.
    await websocket.accept()
    bill_id = await find_visible_bill_id(share_code)
    if bill_id is None:
        await websocket.close(code=CLOSE_BILL_NOT_FOUND)
        return
    if not live_updates.add(bill_id, websocket):
        await websocket.close(code=CLOSE_TOO_MANY_CONNECTIONS)
        return

    try:
        # Clients don't send anything. This just waits, so we notice when they disconnect.
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        live_updates.remove(bill_id, websocket)
