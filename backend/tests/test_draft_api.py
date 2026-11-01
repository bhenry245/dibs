import base64
import json
import uuid
from datetime import UTC, datetime

import anthropic
import boto3
import httpx2
import pytest
from botocore.exceptions import NoCredentialsError
from httpx import AsyncClient
from moto import mock_aws
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from dibs.config import settings
from dibs.draft_routes import get_receipt_client, get_s3_client
from dibs.main import app
from dibs.models import Bill, CrewMember, ReceiptScan, ReceiptUpload
from dibs.receipts import MAX_IMAGE_BYTES, detect_media_type
from dibs.routes import hash_token

pytestmark = pytest.mark.anyio

JPEG = b"\xff\xd8\xff" + b"photo"
FORM = {"captain_email": "CAP@example.com", "captain_name": "Cap"}

READING = {
    "is_receipt": True,
    "restaurant_name": "Luigi's",
    "lines": [
        {"description": "Burger", "quantity": 1, "line_total_cents": 2000, "is_addon": False},
        {"description": "Beer", "quantity": 2, "line_total_cents": 1000, "is_addon": False},
    ],
    "subtotal_cents": 3000,
    "tax_cents": 240,
    "tip_cents": 600,
    "fees_cents": None,
    "total_cents": 3840,
}

CORRECTED = {
    "restaurant_name": "Luigi's Pizza",
    "tax_cents": 100,
    "tip_cents": 200,
    "split_tip": False,
    "items": [
        {"description": "Pizza", "price_cents": 1500},
        {"description": "Soda", "price_cents": 300},
    ],
}


def claude_answer(reading: dict) -> httpx2.Response:
    return httpx2.Response(
        200,
        json={
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-5-5",
            "content": [{"type": "text", "text": json.dumps(reading)}],
            "stop_reason": "end_turn",
            "stop_sequence": None,
            "usage": {"input_tokens": 1500, "output_tokens": 200},
        },
    )


class FakeClaude:
    """The real SDK and parser, with a scripted answer in place of the network."""

    def __init__(self) -> None:
        self.reading = READING
        self.response: httpx2.Response | None = None
        self.requests: list[httpx2.Request] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.response or claude_answer(self.reading)


@pytest.fixture
def claude(monkeypatch: pytest.MonkeyPatch):
    fake = FakeClaude()
    client = anthropic.AsyncAnthropic(
        api_key="test-key",
        max_retries=0,
        http_client=anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(fake.handle)),
    )
    app.dependency_overrides[get_receipt_client] = lambda: client
    monkeypatch.setattr(settings, "receipt_daily_limit", 1_000_000)
    yield fake
    app.dependency_overrides.pop(get_receipt_client, None)


# A fake S3, so these tests can never touch a real bucket, whatever login is on this machine.
BUCKET = "test-receipts"
storage = None


@pytest.fixture(autouse=True)
def s3(monkeypatch: pytest.MonkeyPatch):
    global storage
    monkeypatch.setattr(settings, "receipts_bucket", BUCKET)
    monkeypatch.setattr(settings, "receipt_upload_daily_limit", 1_000_000)
    with mock_aws():
        storage = boto3.client(
            "s3",
            region_name="us-east-2",
            aws_access_key_id="testing",
            aws_secret_access_key="testing",
        )
        storage.create_bucket(
            Bucket=BUCKET, CreateBucketConfiguration={"LocationConstraint": "us-east-2"}
        )
        app.dependency_overrides[get_s3_client] = lambda: storage
        yield storage
        app.dependency_overrides.pop(get_s3_client, None)


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# What the browser does: asks for a signed upload, then puts the photo in the bucket.
async def upload_photo(client: AsyncClient, photo: bytes = JPEG) -> str:
    response = await client.post("/receipts/upload-url")
    assert response.status_code == 201, response.text
    upload = response.json()
    storage.put_object(Bucket=BUCKET, Key=upload["fields"]["key"], Body=photo)
    return upload["upload_id"]


async def send_scan(client: AsyncClient, photo: bytes = JPEG, form: dict = FORM):
    upload_id = await upload_photo(client, photo)
    return await client.post("/bills/from-receipt", json={"upload_id": upload_id} | form)


async def scan(client: AsyncClient, photo: bytes = JPEG, **form) -> dict:
    response = await send_scan(client, photo, FORM | form)
    assert response.status_code == 201, response.text
    return response.json()


async def manual_bill(client: AsyncClient) -> dict:
    response = await client.post(
        "/bills",
        json={
            "captain_email": "other@example.com",
            "captain_name": "Other",
            "items": [{"description": "Soup", "price_cents": 500}],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def scan_count(session: AsyncSession) -> int:
    return await session.scalar(select(func.count()).select_from(ReceiptScan))


# --- POST /bills/from-receipt ---


async def test_scan_creates_a_draft_with_quantities_split(client: AsyncClient, claude: FakeClaude):
    created = await scan(client)

    bill = created["draft"]["bill"]
    assert bill["status"] == "DRAFT"
    assert bill["restaurant_name"] == "Luigi's"
    assert [(i["description"], i["price_cents"]) for i in bill["items"]] == [
        ("Burger", 2000),
        ("Beer", 500),
        ("Beer", 500),
    ]
    assert (bill["subtotal_cents"], bill["tax_cents"], bill["tip_cents"]) == (3000, 240, 600)
    assert bill["total_cents"] == 3840
    assert bill["split_tip"] is True
    assert created["draft"]["warnings"] == []
    assert created["draft"]["printed_total_cents"] == 3840


async def test_scan_sends_the_photo_with_its_real_format(client: AsyncClient, claude: FakeClaude):
    png = b"\x89PNG\r\n\x1a\n" + b"photo"

    # The filename and stated type say JPEG, but the bytes are what count.
    await scan(client, photo=png)

    image = json.loads(claude.requests[0].content)["messages"][0]["content"][0]
    assert image["source"]["media_type"] == "image/png"
    assert base64.b64decode(image["source"]["data"]) == png


async def test_scan_adds_the_captain_and_stores_only_a_token_hash(
    client: AsyncClient, claude: FakeClaude, session: AsyncSession
):
    created = await scan(client)

    assert created["draft"]["bill"]["crew"] == [
        {"id": created["crew_member_id"], "name": "Cap", "is_captain": True}
    ]
    row = await session.get_one(CrewMember, uuid.UUID(created["crew_member_id"]))
    assert row.email == "cap@example.com"
    assert row.token_hash == hash_token(created["token"])


async def test_mismatches_are_kept_as_warnings_and_not_fixed(
    client: AsyncClient, claude: FakeClaude
):
    claude.reading = READING | {"total_cents": 9999}

    created = await scan(client)

    assert created["draft"]["bill"]["total_cents"] == 3840
    assert created["draft"]["printed_total_cents"] == 9999
    assert created["draft"]["warnings"] == [
        "The subtotal, tax, tip and fees add up to $38.40, but the receipt's total says $99.99."
    ]


async def test_amounts_not_printed_start_at_zero(client: AsyncClient, claude: FakeClaude):
    claude.reading = READING | {
        "restaurant_name": None,
        "subtotal_cents": None,
        "tax_cents": None,
        "tip_cents": None,
        "total_cents": None,
    }

    created = await scan(client)

    bill = created["draft"]["bill"]
    assert bill["restaurant_name"] is None
    assert (bill["tax_cents"], bill["tip_cents"], bill["total_cents"]) == (0, 0, 3000)
    assert created["draft"]["printed_total_cents"] is None


async def test_negative_tax_starts_at_zero_with_a_warning(client: AsyncClient, claude: FakeClaude):
    claude.reading = READING | {"tax_cents": -100, "total_cents": None}

    created = await scan(client)

    assert created["draft"]["bill"]["tax_cents"] == 0
    assert "The tax reads as -$1.00, so check it." in created["draft"]["warnings"]


async def test_long_names_are_cut_to_fit(client: AsyncClient, claude: FakeClaude):
    claude.reading = READING | {
        "restaurant_name": "R" * 500,
        "lines": [
            {"description": "D" * 500, "quantity": 1, "line_total_cents": 3000, "is_addon": False}
        ],
    }

    bill = (await scan(client))["draft"]["bill"]

    assert len(bill["restaurant_name"]) == 200
    assert len(bill["items"][0]["description"]) == 255


async def test_impossible_printed_total_is_ignored_rather_than_crashing(
    client: AsyncClient, claude: FakeClaude
):
    claude.reading = READING | {"total_cents": 99_999_999_999}

    created = await scan(client)

    assert created["draft"]["printed_total_cents"] is None
    assert len(created["draft"]["warnings"]) == 1


@pytest.mark.parametrize(
    "lines",
    [
        [{"description": "Wine", "quantity": 1, "line_total_cents": 10_000_001, "is_addon": False}],
        [{"description": "Soda", "quantity": 1, "line_total_cents": 100, "is_addon": False}] * 201,
        [{"description": "   ", "quantity": 1, "line_total_cents": 100, "is_addon": False}],
    ],
    ids=["price too large", "too many items", "blank name"],
)
async def test_readings_that_do_not_fit_a_bill_are_rejected_cleanly(
    client: AsyncClient, claude: FakeClaude, session: AsyncSession, lines: list
):
    claude.reading = READING | {"lines": lines}
    bills_before = await session.scalar(select(func.count()).select_from(Bill))

    response = await send_scan(client, photo=JPEG, form=FORM)

    assert response.status_code == 422
    assert "couldn't be read" in response.json()["detail"]
    assert await session.scalar(select(func.count()).select_from(Bill)) == bills_before


async def test_something_that_is_not_a_receipt_gets_a_clear_error(
    client: AsyncClient, claude: FakeClaude
):
    claude.reading = READING | {"is_receipt": False, "lines": []}

    response = await send_scan(client, photo=JPEG, form=FORM)

    assert response.status_code == 422
    assert "doesn't look like a receipt" in response.json()["detail"]


async def test_claude_being_down_is_a_503(client: AsyncClient, claude: FakeClaude):
    claude.response = httpx2.Response(
        529, json={"type": "error", "error": {"type": "overloaded_error", "message": "busy"}}
    )

    response = await send_scan(client, photo=JPEG, form=FORM)

    assert response.status_code == 503


async def test_scanning_without_an_api_key_is_a_clear_503(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    monkeypatch.setattr(settings, "anthropic_api_key", None)

    response = await send_scan(client, photo=JPEG, form=FORM)

    assert response.status_code == 503
    assert response.json() == {"detail": "Receipt scanning isn't set up."}


@pytest.mark.parametrize(
    ("photo", "message"),
    [
        (b"not an image", "JPEG"),
        (b"\x00\x00\x00\x18ftypheic", "JPEG"),
        (b"", "JPEG"),
        (JPEG + b"x" * MAX_IMAGE_BYTES, "under 5 MB"),
    ],
    ids=["text", "heic", "empty", "too large"],
)
async def test_bad_files_are_rejected_without_spending_anything(
    client: AsyncClient, claude: FakeClaude, session: AsyncSession, photo: bytes, message: str
):
    before = await scan_count(session)

    response = await send_scan(client, photo=photo, form=FORM)

    assert response.status_code == 422
    assert message in response.json()["detail"]
    assert claude.requests == []
    assert await scan_count(session) == before


@pytest.mark.parametrize(
    "form",
    [
        {"captain_name": "Cap"},
        {"captain_email": "cap@example.com"},
        {"captain_email": "nope", "captain_name": "Cap"},
        {"captain_email": "cap@example.com", "captain_name": "   "},
    ],
)
async def test_bad_captain_details_are_rejected_before_calling_claude(
    client: AsyncClient, claude: FakeClaude, form: dict
):
    response = await send_scan(client, photo=JPEG, form=form)

    assert response.status_code == 422
    assert claude.requests == []


async def test_daily_limit_stops_scans_before_calling_claude(
    client: AsyncClient,
    claude: FakeClaude,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(settings, "receipt_daily_limit", await scan_count(session) + 1)
    await scan(client)
    calls_after_first = len(claude.requests)

    response = await send_scan(client, photo=JPEG, form=FORM)

    assert response.status_code == 429
    assert "Type this one in" in response.json()["detail"]
    assert len(claude.requests) == calls_after_first == 1


async def test_failed_scans_count_because_they_cost_money_too(
    client: AsyncClient, claude: FakeClaude, session: AsyncSession
):
    before = await scan_count(session)
    claude.reading = READING | {"is_receipt": False, "lines": []}

    await send_scan(client, photo=JPEG, form=FORM)

    assert await scan_count(session) == before + 1


async def test_scans_older_than_a_day_do_not_count(
    client: AsyncClient,
    claude: FakeClaude,
    session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    recent = await scan_count(session)
    session.add(ReceiptScan(created_at=func.now() - func.make_interval(0, 0, 0, 2)))
    await session.commit()
    monkeypatch.setattr(settings, "receipt_daily_limit", recent + 1)

    await scan(client)


async def test_fees_from_the_receipt_are_on_the_draft_and_in_the_total(
    client: AsyncClient, claude: FakeClaude
):
    claude.reading = READING | {"fees_cents": 311, "total_cents": 4151}

    created = await scan(client)

    bill = created["draft"]["bill"]
    assert (bill["fees_cents"], bill["total_cents"]) == (311, 4151)
    assert created["draft"]["warnings"] == []


async def test_negative_fees_start_at_zero(client: AsyncClient, claude: FakeClaude):
    claude.reading = READING | {"fees_cents": -100, "total_cents": None}

    bill = (await scan(client))["draft"]["bill"]

    assert bill["fees_cents"] == 0


# --- POST /receipts/upload-url ---


async def test_upload_link_is_signed_with_limits_the_browser_cannot_change(
    client: AsyncClient,
):
    response = await client.post("/receipts/upload-url")

    assert response.status_code == 201
    upload = response.json()
    assert BUCKET in upload["url"]
    assert upload["fields"]["key"] == f"receipts/{upload['upload_id']}.jpg"
    policy = json.loads(base64.b64decode(upload["fields"]["policy"]))
    conditions = policy["conditions"]
    assert {"key": upload["fields"]["key"]} in conditions
    assert {"Content-Type": "image/jpeg"} in conditions
    assert ["content-length-range", 1, MAX_IMAGE_BYTES] in conditions


async def test_upload_link_expires_within_five_minutes(client: AsyncClient):
    upload = (await client.post("/receipts/upload-url")).json()

    policy = json.loads(base64.b64decode(upload["fields"]["policy"]))

    expires = datetime.fromisoformat(policy["expiration"].replace("Z", "+00:00"))
    seconds_left = (expires - datetime.now(UTC)).total_seconds()
    assert 0 < seconds_left <= 300


async def test_upload_link_does_not_reveal_the_secret_key(client: AsyncClient):
    response = await client.post("/receipts/upload-url")

    assert "testing" not in json.dumps(response.json()["fields"]["policy"])
    assert "x-amz-signature" in response.json()["fields"]
    assert not any("secret" in name.lower() for name in response.json()["fields"])


async def test_every_upload_gets_its_own_key(client: AsyncClient):
    first = (await client.post("/receipts/upload-url")).json()
    second = (await client.post("/receipts/upload-url")).json()

    assert first["fields"]["key"] != second["fields"]["key"]


async def test_upload_links_are_limited_per_day(
    client: AsyncClient, session: AsyncSession, monkeypatch: pytest.MonkeyPatch
):
    recent = await session.scalar(select(func.count()).select_from(ReceiptUpload))
    monkeypatch.setattr(settings, "receipt_upload_daily_limit", recent + 1)

    assert (await client.post("/receipts/upload-url")).status_code == 201
    assert (await client.post("/receipts/upload-url")).status_code == 429


async def test_scanning_with_no_bucket_set_is_a_clear_503(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
):
    app.dependency_overrides.pop(get_s3_client, None)
    monkeypatch.setattr(settings, "receipts_bucket", None)

    response = await client.post("/receipts/upload-url")

    assert response.status_code == 503
    assert response.json() == {"detail": "Receipt scanning isn't set up."}


async def test_a_login_that_stops_working_is_a_503_rather_than_a_crash(client: AsyncClient):
    class BrokenS3:
        def generate_presigned_post(self, **_):
            raise NoCredentialsError

    app.dependency_overrides[get_s3_client] = BrokenS3

    response = await client.post("/receipts/upload-url")

    assert response.status_code == 503


# --- Using an upload ---


async def test_the_photo_scanned_is_the_one_in_the_bucket_and_its_key_is_kept(
    client: AsyncClient, claude: FakeClaude, session: AsyncSession
):
    created = await scan(client, photo=JPEG + b"-this-one")

    image = json.loads(claude.requests[0].content)["messages"][0]["content"][0]
    assert base64.b64decode(image["source"]["data"]) == JPEG + b"-this-one"
    bill = await session.scalar(
        select(Bill).where(Bill.share_code == created["draft"]["bill"]["share_code"])
    )
    assert bill.receipt_s3_key.startswith("receipts/")


async def test_an_unknown_upload_is_rejected_without_calling_claude(
    client: AsyncClient, claude: FakeClaude
):
    response = await client.post(
        "/bills/from-receipt", json={"upload_id": str(uuid.uuid4())} | FORM
    )

    assert response.status_code == 422
    assert claude.requests == []


async def test_an_upload_can_only_be_scanned_once(client: AsyncClient, claude: FakeClaude):
    upload_id = await upload_photo(client)
    body = {"upload_id": upload_id} | FORM

    first = await client.post("/bills/from-receipt", json=body)
    second = await client.post("/bills/from-receipt", json=body)

    assert first.status_code == 201
    assert second.status_code == 422
    assert len(claude.requests) == 1


async def test_a_scan_cannot_choose_another_file_in_the_bucket(
    client: AsyncClient, claude: FakeClaude
):
    storage.put_object(Bucket=BUCKET, Key="receipts/someone-elses.jpg", Body=JPEG + b"-secret")
    upload_id = await upload_photo(client)

    await client.post(
        "/bills/from-receipt",
        json={"upload_id": upload_id, "key": "receipts/someone-elses.jpg"} | FORM,
    )

    image = json.loads(claude.requests[0].content)["messages"][0]["content"][0]
    assert base64.b64decode(image["source"]["data"]) == JPEG


async def test_a_photo_that_never_arrived_gets_a_clear_error(
    client: AsyncClient, claude: FakeClaude
):
    upload = (await client.post("/receipts/upload-url")).json()

    response = await client.post(
        "/bills/from-receipt", json={"upload_id": upload["upload_id"]} | FORM
    )

    assert response.status_code == 422
    assert "didn't finish uploading" in response.json()["detail"]
    assert claude.requests == []


async def test_s3_being_unreachable_is_a_503(client: AsyncClient, claude: FakeClaude):
    upload_id = await upload_photo(client)

    class BrokenS3:
        def get_object(self, **_):
            raise NoCredentialsError

    app.dependency_overrides[get_s3_client] = BrokenS3

    response = await client.post("/bills/from-receipt", json={"upload_id": upload_id} | FORM)

    assert response.status_code == 503
    assert claude.requests == []


async def test_an_invalid_upload_id_is_rejected(client: AsyncClient, claude: FakeClaude):
    response = await client.post("/bills/from-receipt", json={"upload_id": "nope"} | FORM)

    assert response.status_code == 422


# --- The crew can't see a draft ---


async def test_crew_cannot_see_or_join_a_draft(client: AsyncClient, claude: FakeClaude):
    code = (await scan(client))["draft"]["bill"]["share_code"]

    assert (await client.get(f"/bills/{code}")).status_code == 404
    assert (await client.get(f"/bills/{code}/totals")).status_code == 404
    joined = await client.post(f"/bills/{code}/join", json={"name": "Ana", "phone": "555"})
    assert joined.status_code == 404


async def test_items_on_a_draft_cannot_be_claimed(client: AsyncClient, claude: FakeClaude):
    created = await scan(client)
    item_id = created["draft"]["bill"]["items"][0]["id"]

    response = await client.put(f"/items/{item_id}/claim", json={}, headers=auth(created["token"]))

    assert response.status_code == 409


# --- GET /bills/{share_code}/draft ---


async def test_captain_can_reload_the_draft_with_its_warnings(
    client: AsyncClient, claude: FakeClaude
):
    claude.reading = READING | {"total_cents": 9999}
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]

    response = await client.get(f"/bills/{code}/draft", headers=auth(created["token"]))

    assert response.status_code == 200
    assert response.json() == created["draft"]


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        ("GET", "draft", None),
        ("PUT", "draft", CORRECTED),
        ("POST", "open", None),
    ],
    ids=["get", "edit", "open"],
)
async def test_only_this_bills_captain_can_touch_a_draft(
    client: AsyncClient, claude: FakeClaude, method: str, path: str, body: dict | None
):
    code = (await scan(client))["draft"]["bill"]["share_code"]
    other_captain = await manual_bill(client)
    url = f"/bills/{code}/{path}"

    assert (await client.request(method, url, json=body)).status_code == 401
    wrong_token = await client.request(method, url, json=body, headers=auth("wrong"))
    assert wrong_token.status_code == 401
    other = await client.request(method, url, json=body, headers=auth(other_captain["token"]))
    assert other.status_code == 403


async def test_a_crew_member_is_not_the_captain(client: AsyncClient, claude: FakeClaude):
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]
    await client.post(f"/bills/{code}/open", headers=auth(created["token"]))
    joined = await client.post(f"/bills/{code}/join", json={"name": "Ana", "phone": "555"})

    response = await client.post(f"/bills/{code}/open", headers=auth(joined.json()["token"]))

    assert response.status_code == 403


async def test_unknown_bill_is_404(client: AsyncClient, claude: FakeClaude):
    created = await scan(client)

    response = await client.get("/bills/nope/draft", headers=auth(created["token"]))

    assert response.status_code == 404


# --- PUT /bills/{share_code}/draft ---


async def test_corrections_replace_the_items_and_recalculate(
    client: AsyncClient, claude: FakeClaude
):
    claude.reading = READING | {"total_cents": 9999}
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]

    response = await client.put(
        f"/bills/{code}/draft", json=CORRECTED, headers=auth(created["token"])
    )

    assert response.status_code == 200
    draft = response.json()
    bill = draft["bill"]
    assert bill["restaurant_name"] == "Luigi's Pizza"
    assert [(i["description"], i["price_cents"], i["position"]) for i in bill["items"]] == [
        ("Pizza", 1500, 0),
        ("Soda", 300, 1),
    ]
    assert (bill["subtotal_cents"], bill["total_cents"]) == (1800, 2100)
    assert bill["split_tip"] is False
    # What the scan found stays, so the Captain can still compare.
    assert draft["printed_total_cents"] == 9999
    assert len(draft["warnings"]) == 1

    reloaded = await client.get(f"/bills/{code}/draft", headers=auth(created["token"]))
    assert reloaded.json() == draft


@pytest.mark.parametrize(
    "body",
    [
        CORRECTED | {"items": []},
        CORRECTED | {"tax_cents": -1},
        CORRECTED | {"tip_cents": 1.5},
        CORRECTED | {"items": [{"description": "Soup", "price_cents": -1}]},
        CORRECTED | {"items": [{"description": "", "price_cents": 1}]},
        CORRECTED | {"items": [{"description": "Comped", "price_cents": 0}]},
    ],
)
async def test_corrections_follow_the_same_rules_as_a_typed_bill(
    client: AsyncClient, claude: FakeClaude, body: dict
):
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]

    response = await client.put(f"/bills/{code}/draft", json=body, headers=auth(created["token"]))

    assert response.status_code == 422
    reloaded = await client.get(f"/bills/{code}/draft", headers=auth(created["token"]))
    assert reloaded.json() == created["draft"]


async def test_corrections_can_change_fees_and_the_total_follows(
    client: AsyncClient, claude: FakeClaude
):
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]

    response = await client.put(
        f"/bills/{code}/draft",
        json=CORRECTED | {"fees_cents": 50},
        headers=auth(created["token"]),
    )

    assert response.json()["bill"]["fees_cents"] == 50
    assert response.json()["bill"]["total_cents"] == 2150


async def test_the_review_step_can_add_payment_info(client: AsyncClient, claude: FakeClaude):
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]
    headers = auth(created["token"])

    await client.put(
        f"/bills/{code}/draft", json=CORRECTED | {"venmo_handle": "@cap"}, headers=headers
    )
    await client.post(f"/bills/{code}/open", headers=headers)

    assert (await client.get(f"/bills/{code}")).json()["venmo_handle"] == "@cap"


async def test_bill_typed_by_hand_is_not_a_draft(client: AsyncClient, claude: FakeClaude):
    bill = await manual_bill(client)
    code = bill["bill"]["share_code"]
    headers = auth(bill["token"])

    assert (await client.get(f"/bills/{code}/draft", headers=headers)).status_code == 409
    edit = await client.put(f"/bills/{code}/draft", json=CORRECTED, headers=headers)
    assert edit.status_code == 409


# --- POST /bills/{share_code}/open ---


async def test_opening_makes_the_bill_live_for_the_crew(client: AsyncClient, claude: FakeClaude):
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]
    headers = auth(created["token"])

    response = await client.post(f"/bills/{code}/open", headers=headers)

    assert response.status_code == 200
    assert response.json()["status"] == "OPEN"
    assert (await client.get(f"/bills/{code}")).status_code == 200
    assert (await client.get(f"/bills/{code}/draft", headers=headers)).status_code == 409
    edit = await client.put(f"/bills/{code}/draft", json=CORRECTED, headers=headers)
    assert edit.status_code == 409


async def test_opening_twice_is_fine(client: AsyncClient, claude: FakeClaude):
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]
    headers = auth(created["token"])

    await client.post(f"/bills/{code}/open", headers=headers)
    response = await client.post(f"/bills/{code}/open", headers=headers)

    assert response.status_code == 200
    assert response.json()["status"] == "OPEN"


@pytest.mark.parametrize("bill_status", ["LOCKED", "SETTLED"])
async def test_a_locked_bill_cannot_be_reopened_this_way(
    client: AsyncClient, claude: FakeClaude, session: AsyncSession, bill_status: str
):
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]
    await session.execute(update(Bill).where(Bill.share_code == code).values(status=bill_status))
    await session.commit()

    response = await client.post(f"/bills/{code}/open", headers=auth(created["token"]))

    assert response.status_code == 409


async def test_scan_correct_open_join_claim_and_total_all_work_together(
    client: AsyncClient, claude: FakeClaude
):
    created = await scan(client)
    code = created["draft"]["bill"]["share_code"]
    captain = auth(created["token"])

    corrected = {
        "tax_cents": 312,
        "tip_cents": 780,
        "items": [
            {"description": "Burger", "price_cents": 2000},
            {"description": "Salad", "price_cents": 1000},
            {"description": "Nachos", "price_cents": 900},
        ],
    }
    await client.put(f"/bills/{code}/draft", json=corrected, headers=captain)
    bill = (await client.post(f"/bills/{code}/open", headers=captain)).json()
    joined = await client.post(f"/bills/{code}/join", json={"name": "Ana", "phone": "555"})
    ana = auth(joined.json()["token"])
    burger, salad, nachos = (item["id"] for item in bill["items"])
    await client.put(f"/items/{burger}/claim", json={}, headers=captain)
    await client.put(f"/items/{salad}/claim", json={}, headers=ana)
    await client.put(f"/items/{nachos}/claim", json={}, headers=captain)
    await client.put(f"/items/{nachos}/claim", json={}, headers=ana)

    totals = (await client.get(f"/bills/{code}/totals")).json()

    assert {person["name"]: person["total_cents"] for person in totals["people"]} == {
        "Cap": 3136,
        "Ana": 1856,
    }


# --- detect_media_type ---


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (b"\xff\xd8\xff\xe0rest", "image/jpeg"),
        (b"\x89PNG\r\n\x1a\nrest", "image/png"),
        (b"RIFF\x00\x00\x00\x00WEBPrest", "image/webp"),
        (b"GIF89arest", "image/gif"),
        (b"GIF87arest", "image/gif"),
        (b"RIFF\x00\x00\x00\x00WAVErest", None),
        (b"%PDF-1.7", None),
        (b"", None),
    ],
)
def test_detect_media_type(data: bytes, expected: str | None):
    assert detect_media_type(data) == expected
