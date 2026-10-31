import pytest

from dibs.money import Item, allocate, split_bill

# --- allocate: split an amount by shares, exact to the cent ---


def test_allocate_splits_evenly_when_it_divides():
    assert allocate(900, {"cap": 1, "ana": 1, "ben": 1}) == {"cap": 300, "ana": 300, "ben": 300}


def test_allocate_ten_dollars_three_ways_gives_leftover_cent_to_first_key_on_a_tie():
    # 1000 / 3 = 333.33... each. Remainders tie, so the first key (the Captain) gets the cent.
    assert allocate(1000, {"cap": 1, "ana": 1, "ben": 1}) == {"cap": 334, "ana": 333, "ben": 333}


def test_allocate_is_proportional_to_shares():
    # 2:1 split of $10.00 is 666.67 / 333.33.
    assert allocate(1000, {"cap": 2, "ana": 1}) == {"cap": 667, "ana": 333}


def test_allocate_gives_leftover_cent_to_largest_remainder_not_first_key():
    # a: 100 * 1/3 = 33.33 (remainder .33), b: 100 * 2/3 = 66.67 (remainder .67), so b gets it.
    assert allocate(100, {"a": 1, "b": 2}) == {"a": 33, "b": 67}


def test_allocate_gives_nothing_to_zero_share():
    assert allocate(500, {"cap": 1, "ana": 0}) == {"cap": 500, "ana": 0}


@pytest.mark.parametrize("total", [0, 1, 7, 99, 100, 1001, 123_457])
@pytest.mark.parametrize("shares", [[1, 1, 1], [1, 2, 3], [7, 0, 13], [1, 1, 1, 1, 1, 1, 1]])
def test_allocate_always_sums_to_total(total, shares):
    result = allocate(total, {f"p{i}": s for i, s in enumerate(shares)})

    assert sum(result.values()) == total


def test_allocate_of_zero_with_zero_shares_is_all_zero():
    assert allocate(0, {"cap": 0, "ana": 0}) == {"cap": 0, "ana": 0}


def test_allocate_rejects_negative_total():
    with pytest.raises(ValueError):
        allocate(-1, {"cap": 1})


def test_allocate_rejects_negative_share():
    with pytest.raises(ValueError):
        allocate(100, {"cap": 1, "ana": -1})


def test_allocate_rejects_money_with_no_one_to_give_it_to():
    with pytest.raises(ValueError):
        allocate(100, {"cap": 0, "ana": 0})


# --- split_bill: items, shares, tax and tip -> what each person owes ---


def test_split_bill_one_person_pays_everything():
    result = split_bill(["cap"], [Item(2000, {"cap": 1})], tax_cents=160, tip_cents=400)

    assert result["cap"].subtotal_cents == 2000
    assert result["cap"].tax_cents == 160
    assert result["cap"].tip_cents == 400
    assert result["cap"].total_cents == 2560


def test_split_bill_shared_item_and_proportional_tax_and_tip():
    # cap: burger $20 + half the nachos $4.50 = $24.50
    # ana: salad $10 + half the nachos $4.50 = $14.50
    # Subtotal $39.00, so cap pays 24.5/39 of tax and tip, ana 14.5/39.
    items = [
        Item(2000, {"cap": 1}),
        Item(1000, {"ana": 1}),
        Item(900, {"cap": 1, "ana": 1}),
    ]

    result = split_bill(["cap", "ana"], items, tax_cents=312, tip_cents=780)

    assert (result["cap"].subtotal_cents, result["cap"].tax_cents, result["cap"].tip_cents) == (
        2450,
        196,
        490,
    )
    assert (result["ana"].subtotal_cents, result["ana"].tax_cents, result["ana"].tip_cents) == (
        1450,
        116,
        290,
    )


def test_split_bill_uneven_shares():
    # cap had two-thirds of the pizza, ana one-third.
    result = split_bill(["cap", "ana"], [Item(1800, {"cap": 2, "ana": 1})], 0, 0)

    assert result["cap"].subtotal_cents == 1200
    assert result["ana"].subtotal_cents == 600


def test_split_bill_totals_add_up_to_the_bill_exactly():
    # Awkward numbers on purpose: nothing divides evenly.
    items = [
        Item(1000, {"cap": 1, "ana": 1, "ben": 1}),
        Item(1333, {"ana": 1}),
        Item(777, {"ben": 2, "cap": 1}),
    ]

    result = split_bill(["cap", "ana", "ben"], items, tax_cents=87, tip_cents=133)

    bill_total = 1000 + 1333 + 777 + 87 + 133
    assert sum(person.total_cents for person in result.values()) == bill_total


def test_split_bill_person_with_no_claims_owes_nothing():
    result = split_bill(["cap", "ana"], [Item(1000, {"cap": 1})], tax_cents=80, tip_cents=200)

    assert result["ana"].total_cents == 0


def test_split_bill_without_splitting_tip_still_splits_tax():
    # cap's items are $20 and ana's are $10, so tax splits 2:1 but cap covers the whole tip.
    items = [Item(2000, {"cap": 1}), Item(1000, {"ana": 1})]

    result = split_bill(["cap", "ana"], items, tax_cents=300, tip_cents=500, split_tip=False)

    assert (result["cap"].subtotal_cents, result["cap"].tax_cents, result["cap"].tip_cents) == (
        2000,
        200,
        500,
    )
    assert (result["ana"].subtotal_cents, result["ana"].tax_cents, result["ana"].tip_cents) == (
        1000,
        100,
        0,
    )


def test_split_bill_captain_with_no_claims_can_still_cover_tip():
    items = [Item(1000, {"ana": 1})]

    result = split_bill(["cap", "ana"], items, tax_cents=80, tip_cents=200, split_tip=False)

    assert result["cap"].total_cents == 200
    assert result["ana"].total_cents == 1080


def test_split_bill_rejects_negative_tip_when_captain_covers_it():
    with pytest.raises(ValueError):
        split_bill(["cap"], [Item(1000, {"cap": 1})], 0, -1, split_tip=False)


def test_split_bill_rejects_unclaimed_item():
    # Unclaimed items must be assigned (to the Captain by default) before splitting.
    with pytest.raises(ValueError):
        split_bill(["cap"], [Item(1000, {})], 0, 0)


def test_split_bill_rejects_claim_by_unknown_person():
    with pytest.raises(ValueError):
        split_bill(["cap"], [Item(1000, {"stranger": 1})], 0, 0)
