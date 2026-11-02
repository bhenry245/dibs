# The JSON the API accepts and returns. Keeping this separate from models.py means a new database
# column (like token_hash) can never end up in a response by accident.

import uuid
from typing import Annotated, Self

from pydantic import AfterValidator, BaseModel, EmailStr, Field, StringConstraints, model_validator

# These caps keep a bill's total inside a Postgres integer (about $21 million): 200 items at
# $100,000 each, plus tax, tip and fees, still fits.
MAX_CENTS = 10_000_000
MAX_ITEMS = 200
MAX_SHARES = 100

# strict=True rejects 12.0 as well as 12.5, so a float can never pass for cents.
Cents = Annotated[int, Field(ge=0, le=MAX_CENTS, strict=True)]
Shares = Annotated[int, Field(ge=1, le=MAX_SHARES, strict=True)]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
Phone = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=32)]
PaymentHandle = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)
]
ZelleContact = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=320)
]
# Lowercased so Bob@Example.com and bob@example.com are the same Captain.
Email = Annotated[EmailStr, AfterValidator(str.lower)]


class LineItemCreate(BaseModel):
    description: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]
    price_cents: Cents


# What a bill says, whether it was typed in or corrected after a scan.
class BillDetails(BaseModel):
    restaurant_name: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
        | None
    ) = None
    tax_cents: Cents = 0
    tip_cents: Cents = 0
    fees_cents: Cents = 0
    split_tip: bool = True
    venmo_handle: PaymentHandle | None = None
    cashapp_tag: PaymentHandle | None = None
    zelle_contact: ZelleContact | None = None
    items: list[LineItemCreate] = Field(min_length=1, max_length=MAX_ITEMS)

    # Tax, tip and fees are split in proportion to item prices, so they need a price to split
    # against.
    @model_validator(mode="after")
    def check_something_to_split_against(self) -> Self:
        has_extras = self.tax_cents or self.tip_cents or self.fees_cents
        if has_extras and not any(item.price_cents for item in self.items):
            raise ValueError("tax, tip and fees need at least one item with a price")
        return self


class BillCreate(BillDetails):
    captain_email: Email
    captain_name: Name


class JoinRequest(BaseModel):
    name: Name
    phone: Phone | None = None
    email: Email | None = None

    # Design §3: crew give a name plus a phone or an email, so reminders can reach them.
    @model_validator(mode="after")
    def check_has_contact(self) -> "JoinRequest":
        if self.phone is None and self.email is None:
            raise ValueError("give a phone number or an email")
        return self


class ClaimRequest(BaseModel):
    shares: Shares = 1


# Everything someone wants to claim. Saving replaces their whole set in one step.
class MyClaimsRequest(BaseModel):
    item_ids: list[uuid.UUID] = Field(max_length=MAX_ITEMS)


class ClaimOut(BaseModel):
    crew_member_id: uuid.UUID
    shares: int


class LineItemOut(BaseModel):
    id: uuid.UUID
    description: str
    price_cents: int
    position: int
    claims: list[ClaimOut]


# Only what the table needs to see. Phone, email and token_hash stay out on purpose.
class CrewMemberOut(BaseModel):
    id: uuid.UUID
    name: str
    is_captain: bool


class BillOut(BaseModel):
    share_code: str
    status: str
    restaurant_name: str | None
    subtotal_cents: int
    tax_cents: int
    tip_cents: int
    fees_cents: int
    total_cents: int
    split_tip: bool
    # Visible to anyone with the QR link, because the crew need them to pay.
    venmo_handle: str | None
    cashapp_tag: str | None
    zelle_contact: str | None
    items: list[LineItemOut]
    crew: list[CrewMemberOut]


# The token is only ever returned here and in JoinResponse. Only its hash is stored.
class BillCreated(BaseModel):
    bill: BillOut
    crew_member_id: uuid.UUID
    token: str


# A scanned bill while the Captain reviews it. Showing the printed total next to the bill's own
# lets them spot a misread, but they decide what's right.
class DraftOut(BaseModel):
    bill: BillOut
    warnings: list[str]
    printed_total_cents: int | None


class DraftCreated(BaseModel):
    draft: DraftOut
    crew_member_id: uuid.UUID
    token: str


class ReceiptUploadOut(BaseModel):
    upload_id: uuid.UUID
    # Where the browser sends the photo, and the signed fields it must send along with it.
    url: str
    fields: dict[str, str]


class ReceiptScanRequest(BaseModel):
    upload_id: uuid.UUID
    captain_email: Email
    captain_name: Name


class JoinResponse(BaseModel):
    crew_member_id: uuid.UUID
    token: str


class ClaimResponse(BaseModel):
    line_item_id: uuid.UUID
    crew_member_id: uuid.UUID
    shares: int


# Where unclaimed items go when the bill locks: item -> crew member. Anything left out goes to the
# Captain (design §8).
class LockRequest(BaseModel):
    assignments: dict[uuid.UUID, uuid.UUID] = Field(default_factory=dict)


class SettlementOut(BaseModel):
    id: uuid.UUID
    crew_member_id: uuid.UUID
    name: str
    subtotal_cents: int
    tax_cents: int
    tip_cents: int
    fees_cents: int
    total_cents: int
    status: str


class PersonTotalOut(BaseModel):
    crew_member_id: uuid.UUID
    name: str
    subtotal_cents: int
    tax_cents: int
    tip_cents: int
    fees_cents: int
    total_cents: int


class BillTotals(BaseModel):
    people: list[PersonTotalOut]
    # Items nobody has claimed aren't on anyone's total until the bill is locked. This is what they
    # come to, with their part of the tax and fees, so people plus this adds up to the bill.
    unclaimed_item_ids: list[uuid.UUID]
    unclaimed_cents: int
