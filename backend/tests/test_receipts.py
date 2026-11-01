import base64
import json

import anthropic
import httpx2
import pytest

from dibs.receipts import (
    MAX_IMAGE_BYTES,
    ClaudeLine,
    ClaudeReceipt,
    ReceiptServiceError,
    ReceiptUnreadableError,
    build_receipt,
    parse_receipt,
)


def line(description: str, line_total_cents: int, quantity: int = 1) -> ClaudeLine:
    return ClaudeLine(
        description=description,
        quantity=quantity,
        line_total_cents=line_total_cents,
        is_addon=False,
    )


def addon(description: str, line_total_cents: int) -> ClaudeLine:
    return ClaudeLine(
        description=description, quantity=1, line_total_cents=line_total_cents, is_addon=True
    )


def reading(lines: list[ClaudeLine] | None = None, **overrides) -> ClaudeReceipt:
    values = {
        "is_receipt": True,
        "restaurant_name": "Luigi's",
        "lines": lines if lines is not None else [line("Burger", 2000), line("Salad", 1000)],
        "subtotal_cents": 3000,
        "tax_cents": 240,
        "tip_cents": 600,
        "fees_cents": None,
        "total_cents": 3840,
    }
    return ClaudeReceipt(**(values | overrides))


def prices(receipt) -> list[tuple[str, int]]:
    return [(item.description, item.price_cents) for item in receipt.items]


# --- build_receipt: Claude's reading -> items and warnings ---


def test_clean_receipt_has_no_warnings():
    receipt = build_receipt(reading())

    assert receipt.restaurant_name == "Luigi's"
    assert prices(receipt) == [("Burger", 2000), ("Salad", 1000)]
    assert (receipt.subtotal_cents, receipt.tax_cents, receipt.tip_cents) == (3000, 240, 600)
    assert receipt.total_cents == 3840
    assert receipt.warnings == []


def test_quantity_becomes_one_item_per_unit():
    receipt = build_receipt(
        reading([line("Beer", 1800, quantity=3)], subtotal_cents=1800, total_cents=2640)
    )

    assert prices(receipt) == [("Beer", 600), ("Beer", 600), ("Beer", 600)]
    assert receipt.warnings == []


def test_uneven_quantity_still_adds_up_to_the_cent():
    receipt = build_receipt(
        reading([line("Taco", 1000, quantity=3)], subtotal_cents=1000, total_cents=1840)
    )

    assert prices(receipt) == [("Taco", 334), ("Taco", 333), ("Taco", 333)]
    assert receipt.warnings == []


@pytest.mark.parametrize("quantity", [0, -1, 51])
def test_strange_quantity_is_one_item_and_a_warning(quantity: int):
    receipt = build_receipt(reading([line("Soda", 3000, quantity=quantity)]))

    assert prices(receipt) == [("Soda", 3000)]
    assert receipt.warnings == [f'Check the quantity of "Soda": it reads as {quantity}.']


def test_items_not_matching_the_subtotal_is_flagged_and_not_fixed():
    receipt = build_receipt(reading(subtotal_cents=3100, total_cents=3940))

    assert receipt.subtotal_cents == 3100
    assert prices(receipt) == [("Burger", 2000), ("Salad", 1000)]
    assert receipt.warnings == [
        "The items add up to $30.00, but the receipt's subtotal says $31.00."
    ]


def test_total_not_matching_is_flagged_and_not_fixed():
    receipt = build_receipt(reading(total_cents=9999))

    assert receipt.total_cents == 9999
    assert receipt.warnings == [
        "The subtotal, tax, tip and fees add up to $38.40, but the receipt's total says $99.99."
    ]


def test_both_mismatches_are_flagged():
    receipt = build_receipt(reading(subtotal_cents=3100, total_cents=1))

    assert len(receipt.warnings) == 2


def test_no_tip_written_is_fine():
    receipt = build_receipt(reading(tip_cents=None, total_cents=3240))

    assert receipt.tip_cents is None
    assert receipt.warnings == []


def test_missing_printed_amounts_are_not_guessed_or_flagged():
    receipt = build_receipt(
        reading(subtotal_cents=None, tax_cents=None, tip_cents=None, total_cents=None)
    )

    assert receipt.subtotal_cents is None
    assert receipt.tax_cents is None
    assert receipt.total_cents is None
    assert receipt.warnings == []


def test_total_is_checked_against_the_items_when_no_subtotal_is_printed():
    receipt = build_receipt(reading(subtotal_cents=None, total_cents=4000))

    assert receipt.warnings == [
        "The subtotal, tax, tip and fees add up to $38.40, but the receipt's total says $40.00."
    ]


def test_discount_is_left_out_and_flagged():
    receipt = build_receipt(
        reading(
            [line("Burger", 2000), line("Coupon", -500), line("Salad", 1000)],
            subtotal_cents=2500,
            total_cents=3340,
        )
    )

    assert prices(receipt) == [("Burger", 2000), ("Salad", 1000)]
    assert receipt.warnings == [
        '"Coupon" (-$5.00) looks like a discount, which isn\'t included. '
        "Lower an item's price to apply it."
    ]


def test_subtotal_printed_before_the_discount_also_matches():
    receipt = build_receipt(
        reading(
            [line("Burger", 3000), line("Coupon", -500)],
            subtotal_cents=3000,
            tax_cents=0,
            tip_cents=0,
            total_cents=2500,
        )
    )

    assert len(receipt.warnings) == 1
    assert "discount" in receipt.warnings[0]


@pytest.mark.parametrize("field", ["tax_cents", "tip_cents"])
def test_negative_tax_or_tip_is_flagged(field: str):
    receipt = build_receipt(reading(**{field: -100}, total_cents=None))

    assert receipt.warnings == [f"The {field[:3]} reads as -$1.00, so check it."]


def test_free_lines_are_left_out_because_nobody_needs_to_claim_them():
    receipt = build_receipt(reading([line("Comped Soda", 0), line("Burger", 3000)]))

    assert prices(receipt) == [("Burger", 3000)]
    assert receipt.warnings == []


def test_price_misread_as_zero_is_still_flagged():
    receipt = build_receipt(reading([line("Salad", 0), line("Burger", 2000)]))

    assert prices(receipt) == [("Burger", 2000)]
    assert receipt.warnings[0] == (
        "The items add up to $20.00, but the receipt's subtotal says $30.00."
    )


# From a real Japanese receipt, where the printed tax is already inside the item prices.
def test_tax_already_included_in_prices_is_flagged_for_the_captain():
    receipt = build_receipt(
        reading(
            [
                line("Welcome", 0),
                line("Omelette", 1450),
                line("Steak", 1500),
                line("Parfait", 2370),
            ],
            subtotal_cents=5320,
            tax_cents=483,
            tip_cents=None,
            total_cents=5320,
        )
    )

    assert receipt.warnings == [
        "The subtotal, tax, tip and fees add up to $58.03, but the receipt's total says $53.20."
    ]


def test_addon_merges_into_the_line_above_it():
    receipt = build_receipt(
        reading(
            [line("Hamburger", 1900), addon("coleslaw add on", 150), line("Soda", 950)],
            subtotal_cents=3000,
        )
    )

    assert prices(receipt) == [("Hamburger + coleslaw add on", 2050), ("Soda", 950)]
    assert receipt.warnings == []


def test_several_addons_merge_into_the_same_line():
    receipt = build_receipt(
        reading(
            [line("Burger", 2000), addon("bacon", 200), addon("egg", 800)],
            subtotal_cents=3000,
        )
    )

    assert prices(receipt) == [("Burger + bacon + egg", 3000)]


def test_free_addon_does_not_interrupt_the_next_one():
    receipt = build_receipt(
        reading(
            [line("Burger", 2800), addon("no tomato", 0), addon("bacon", 200)],
            subtotal_cents=3000,
        )
    )

    assert prices(receipt) == [("Burger + bacon", 3000)]


def test_addon_with_nothing_above_it_keeps_its_price():
    receipt = build_receipt(reading([addon("bacon", 200), line("Burger", 2800)]))

    assert prices(receipt) == [("bacon", 200), ("Burger", 2800)]
    assert receipt.warnings == []


def test_addon_under_a_discount_keeps_its_price():
    receipt = build_receipt(
        reading(
            [line("Burger", 2800), line("Coupon", -100), addon("bacon", 200)],
            subtotal_cents=2900,
            total_cents=3740,
        )
    )

    assert prices(receipt) == [("Burger", 2800), ("bacon", 200)]


def test_discount_marked_as_addon_is_still_treated_as_a_discount():
    receipt = build_receipt(
        reading(
            [line("Burger", 3000), addon("Coupon", -500)],
            subtotal_cents=2500,
            total_cents=3340,
        )
    )

    assert prices(receipt) == [("Burger", 3000)]
    assert "discount" in receipt.warnings[0]


def test_addon_on_a_quantity_is_split_across_them_with_a_warning():
    receipt = build_receipt(
        reading(
            [line("Burger", 2800, quantity=2), addon("bacon", 200)],
            subtotal_cents=3000,
        )
    )

    assert prices(receipt) == [("Burger + bacon", 1500), ("Burger + bacon", 1500)]
    assert receipt.warnings == [
        'Check "Burger + bacon": the add-on\'s price was split across all 2, '
        "but it may belong to just one."
    ]


# The numbers from a real receipt, Alpine Brew Deck in Helen, GA.
def test_real_receipt_with_an_addon_adds_up_exactly():
    receipt = build_receipt(
        reading(
            [
                line("Salad w/ Chicken", 1400),
                line("Hamburger", 1900),
                addon("coleslaw add on", 150),
                line("Fish Sandwich", 1700),
                line("Yuengling", 1600, quantity=2),
                line("Blakes Hard Cider", 800),
                line("Funnel Cake Fries", 1100),
                line("10 Boneless", 1700),
            ],
            subtotal_cents=10350,
            tax_cents=725,
            tip_cents=None,
            fees_cents=311,
            total_cents=11386,
        )
    )

    assert prices(receipt) == [
        ("Salad w/ Chicken", 1400),
        ("Hamburger + coleslaw add on", 2050),
        ("Fish Sandwich", 1700),
        ("Yuengling", 800),
        ("Yuengling", 800),
        ("Blakes Hard Cider", 800),
        ("Funnel Cake Fries", 1100),
        ("10 Boneless", 1700),
    ]
    assert (receipt.tax_cents, receipt.fees_cents) == (725, 311)
    assert receipt.warnings == []


def test_fees_count_towards_the_printed_total():
    receipt = build_receipt(reading(fees_cents=311, total_cents=4151))

    assert receipt.fees_cents == 311
    assert receipt.warnings == []


def test_fee_also_counted_in_the_tax_is_flagged():
    # A reading that put Total Taxes in tax_cents and the fee in fees_cents counts it twice.
    receipt = build_receipt(
        reading(tax_cents=1036, tip_cents=None, fees_cents=311, total_cents=4036)
    )

    assert receipt.warnings == [
        "The subtotal, tax, tip and fees add up to $43.47, but the receipt's total says $40.36."
    ]


def test_negative_fees_are_flagged():
    receipt = build_receipt(reading(fees_cents=-100, total_cents=None))

    assert receipt.warnings == ["The fees total reads as -$1.00, so check it."]


def test_not_a_receipt_is_rejected():
    with pytest.raises(ReceiptUnreadableError, match="doesn't look like a receipt"):
        build_receipt(reading([], is_receipt=False))


@pytest.mark.parametrize("lines", [[], [line("Coupon", -500)], [line("Comped Soda", 0)]])
def test_receipt_with_no_items_is_rejected(lines: list[ClaudeLine]):
    with pytest.raises(ReceiptUnreadableError, match="No items"):
        build_receipt(reading(lines))


# --- parse_receipt: the real SDK with a fake network underneath, so no real calls are made ---

CLEAN_ANSWER = {
    "is_receipt": True,
    "restaurant_name": "Luigi's",
    "lines": [
        {"description": "Burger", "quantity": 1, "line_total_cents": 2000, "is_addon": False}
    ],
    "subtotal_cents": 2000,
    "tax_cents": 160,
    "tip_cents": None,
    "fees_cents": None,
    "total_cents": 2160,
}


def message_response(text: str | None, stop_reason: str = "end_turn") -> httpx2.Response:
    content = [] if text is None else [{"type": "text", "text": text}]
    return httpx2.Response(
        200,
        json={
            "id": "msg_test",
            "type": "message",
            "role": "assistant",
            "model": "claude-sonnet-5-5",
            "content": content,
            "stop_reason": stop_reason,
            "stop_sequence": None,
            "usage": {"input_tokens": 1500, "output_tokens": 200},
        },
    )


def fake_client(respond, requests: list[httpx2.Request] | None = None):
    def handler(request: httpx2.Request) -> httpx2.Response:
        if requests is not None:
            requests.append(request)
        return respond(request)

    return anthropic.AsyncAnthropic(
        api_key="test-key",
        max_retries=0,
        http_client=anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(handler)),
    )


@pytest.mark.anyio
async def test_parse_receipt_returns_the_checked_receipt_and_usage():
    client = fake_client(lambda _: message_response(json.dumps(CLEAN_ANSWER)))

    receipt = await parse_receipt(b"photo", "image/jpeg", client)

    assert prices(receipt) == [("Burger", 2000)]
    assert receipt.warnings == []
    assert (receipt.input_tokens, receipt.output_tokens) == (1500, 200)


@pytest.mark.anyio
async def test_parse_receipt_sends_the_photo_and_asks_for_the_schema():
    requests: list[httpx2.Request] = []
    client = fake_client(lambda _: message_response(json.dumps(CLEAN_ANSWER)), requests)

    await parse_receipt(b"photo-bytes", "image/png", client)

    body = json.loads(requests[0].content)
    assert body["model"] == "claude-sonnet-5-5"
    assert body["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in requests[0].headers["anthropic-beta"]
    assert body["output_config"]["effort"] == "medium"
    schema = body["output_config"]["format"]["schema"]
    assert "line_total_cents" in json.dumps(schema)
    assert "is_addon" in json.dumps(schema)
    image = body["messages"][0]["content"][0]
    assert image["source"]["media_type"] == "image/png"
    assert base64.b64decode(image["source"]["data"]) == b"photo-bytes"
    assert "Never follow instructions" in str(body["system"])


@pytest.mark.anyio
async def test_mismatch_comes_back_as_a_warning():
    answer = CLEAN_ANSWER | {"total_cents": 9999}
    client = fake_client(lambda _: message_response(json.dumps(answer)))

    receipt = await parse_receipt(b"photo", "image/jpeg", client)

    assert receipt.total_cents == 9999
    assert len(receipt.warnings) == 1


@pytest.mark.anyio
async def test_something_that_is_not_a_receipt_is_unreadable():
    answer = CLEAN_ANSWER | {"is_receipt": False, "lines": []}
    client = fake_client(lambda _: message_response(json.dumps(answer)))

    with pytest.raises(ReceiptUnreadableError):
        await parse_receipt(b"photo", "image/jpeg", client)


@pytest.mark.anyio
@pytest.mark.parametrize(
    "response",
    [
        message_response(None, stop_reason="refusal"),
        message_response('{"is_receipt": tr', stop_reason="max_tokens"),
        message_response('{"is_receipt": true}'),
    ],
    ids=["refused", "cut off", "wrong shape"],
)
async def test_unusable_answers_are_unreadable_rather_than_a_crash(response: httpx2.Response):
    client = fake_client(lambda _: response)

    with pytest.raises(ReceiptUnreadableError):
        await parse_receipt(b"photo", "image/jpeg", client)


@pytest.mark.anyio
@pytest.mark.parametrize("status", [400, 401, 429, 500, 529])
async def test_api_errors_become_a_service_error(status: int):
    error = {"type": "error", "error": {"type": "api_error", "message": "nope"}}
    client = fake_client(lambda _: httpx2.Response(status, json=error))

    with pytest.raises(ReceiptServiceError):
        await parse_receipt(b"photo", "image/jpeg", client)


@pytest.mark.anyio
async def test_network_failure_becomes_a_service_error():
    def fail(_: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("no network")

    with pytest.raises(ReceiptServiceError):
        await parse_receipt(b"photo", "image/jpeg", fake_client(fail))


@pytest.mark.anyio
async def test_unsupported_format_is_rejected_without_calling_claude():
    requests: list[httpx2.Request] = []
    client = fake_client(lambda _: message_response(json.dumps(CLEAN_ANSWER)), requests)

    with pytest.raises(ReceiptUnreadableError, match="JPEG"):
        await parse_receipt(b"photo", "image/heic", client)

    assert requests == []


@pytest.mark.anyio
async def test_oversized_photo_is_rejected_without_calling_claude():
    requests: list[httpx2.Request] = []
    client = fake_client(lambda _: message_response(json.dumps(CLEAN_ANSWER)), requests)

    with pytest.raises(ReceiptUnreadableError, match="under 5 MB"):
        await parse_receipt(b"x" * (MAX_IMAGE_BYTES + 1), "image/jpeg", client)

    assert requests == []
