# Money math for splitting a bill (design doc §8).

# All amounts are integer cents. Floats never touch money: 0.1 + 0.2 != 0.3 in floating point,
# and a bill must add up to the cent.

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

# Splits an amount in proportion to shares, so the parts add up to exactly that amount.

#     Called once per item, then once each for tax and tip, never on the whole bill at once.
#     Most items have one claimer, who gets the full price. When several people claim the same
#     item, its price is split between them by their shares.

#     Uses the largest remainder method: everyone gets their exact share rounded down, then the
#     leftover cents go one each to the largest fractional remainders. Ties go to the earliest
#     key, so callers list the Captain first.

#     Args:
#         amount_cents: The amount to split, in cents, so $15.27 is 1527. Postive only.
#         shares: Who gets a slice -> how big their slice is relative to the others. For an item,
#             that's their share count. For tax or tip, it's their subtotal in cents.
#             Must not be negative.

#     Returns:
#         The same keys as shares -> their slice in cents, adding up to exactly amount_cents.
#         For example, allocate(900, {"alice": 1, "bob": 2}) returns {"alice": 300, "bob": 600}.

#     Raises:
#         ValueError: An amount or share is negative, or amount_cents is above zero but every
#             share is zero.
#     """


def allocate[K](amount_cents: int, shares: Mapping[K, int]) -> dict[K, int]:

    # Edge Cases
    if amount_cents < 0:
        raise ValueError("amount_cents must be positive")
    if any(share < 0 for share in shares.values()):
        raise ValueError("all shares must be positive")

    total_shares = sum(shares.values())
    if total_shares == 0 and amount_cents == 0:
        # Nothing to split, skip this line item
        return dict.fromkeys(shares, 0)
    if total_shares == 0:
        raise ValueError("cannot allocate money when every share is zero")

    # Calculates who owes what and holds the remainders.
    # divmod returns two values that we assign to these two dicts left to right
    parts: dict[K, int] = {}
    remainders: dict[K, int] = {}
    for key, share in shares.items():
        parts[key], remainders[key] = divmod(amount_cents * share, total_shares)

    leftover = amount_cents - sum(parts.values())

    # Find who has the largest remainder, the leftover will be distributed starting from that person
    by_remainder = sorted(shares, key=lambda key: remainders[key], reverse=True)
    for key in by_remainder[:leftover]:
        parts[key] += 1
    return parts


# One line item and who claimed it.
@dataclass(frozen=True)
class Item[K]:
    price_cents: int
    # Each entry is one person's claim: the key is the person, the value is their share.
    # {"bob": 1, "alice": 2} means Alice pays for twice as much of the item as Bob.
    dibs: Mapping[K, int]


# What one person owes, broken down the way the crew sees it.
@dataclass(frozen=True)
class PersonTotal:
    subtotal_cents: int
    tax_cents: int
    tip_cents: int

    @property
    def total_cents(self) -> int:
        return self.subtotal_cents + self.tax_cents + self.tip_cents


# Work out what each person owes.

# Each item's price is split between its claimers by shares. Tax is then always split in
# proportion to each person's item subtotal, and the tip is too unless the Captain covers it.
# The order of people is the tie-break order, so the Captain goes first. Every item must
# already be claimed: unclaimed items are assigned to the Captain before this runs.

# Args:
#     people: Everyone on the bill, Captain first.
#     items: Every line item, with its price in cents and who claimed how many shares.
#     tax_cents: The bill's total tax, in cents.
#     tip_cents: The bill's total tip, in cents.
#     split_tip: True splits the tip like tax. False puts all of it on the Captain.

# Returns:
#     Each person -> a PersonTotal with their item subtotal, tax and tip, all in cents.

# Raises:
#     ValueError: An item has no claimers, is claimed by someone not in people, or has an
#         amount allocate rejects. Tax or tip can also be rejected the same way.


def split_bill[K](
    people: Sequence[K],
    items: Sequence[Item[K]],
    tax_cents: int,
    tip_cents: int,
    split_tip: bool = True,
) -> dict[K, PersonTotal]:
    subtotals = dict.fromkeys(people, 0)
    for item in items:
        if not item.dibs:
            raise ValueError("every item must be claimed before the bill is split")
        if unknown := item.dibs.keys() - subtotals.keys():
            raise ValueError(f"claims by people not on the bill: {unknown}")
        # Put claimers in bill order so a tied cent still goes to the Captain.
        claimers = {person: item.dibs[person] for person in people if person in item.dibs}
        for person, cents in allocate(item.price_cents, claimers).items():
            subtotals[person] += cents

    tax = allocate(tax_cents, subtotals)
    # Not splitting the tip means giving the Captain the only non-zero share of it.
    tip_shares = subtotals if split_tip else {person: int(person == people[0]) for person in people}
    tip = allocate(tip_cents, tip_shares)
    return {person: PersonTotal(subtotals[person], tax[person], tip[person]) for person in people}
