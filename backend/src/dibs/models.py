import secrets
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    MetaData,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

# Predictable constraint names (e.g. uq_captain_email) instead of ones Postgres
# makes up. Alembic needs names to drop or alter a constraint in a later migration.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Parent of every table. Alembic reads Base.metadata to autogenerate migrations."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)


class Captain(Base):
    """The person who paid the bill. The only role with an account (design §3)."""

    __tablename__ = "captain"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    display_name: Mapped[str] = mapped_column(String(100))
    # Payment handles are optional: a Captain may only use one of the three apps.
    venmo_handle: Mapped[str | None] = mapped_column(String(50))
    cashapp_tag: Mapped[str | None] = mapped_column(String(50))
    zelle_contact: Mapped[str | None] = mapped_column(String(320))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# A random code for the QR URL: 16 bytes is 128 bits, so it can't be guessed (design §15).
def generate_share_code() -> str:
    return secrets.token_urlsafe(16)


# One restaurant bill, paid in full by its Captain.
class Bill(Base):
    __tablename__ = "bill"
    __table_args__ = (
        CheckConstraint("status IN ('DRAFT', 'OPEN', 'LOCKED', 'SETTLED')", name="status_valid"),
        CheckConstraint(
            "subtotal_cents >= 0 AND tax_cents >= 0 AND tip_cents >= 0 AND total_cents >= 0",
            name="amounts_not_negative",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    # Postgres doesn't index foreign keys on its own, and we look bills up by these often.
    captain_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("captain.id"), index=True)
    share_code: Mapped[str] = mapped_column(String(64), unique=True, default=generate_share_code)
    status: Mapped[str] = mapped_column(String(20), server_default="DRAFT")
    restaurant_name: Mapped[str | None] = mapped_column(String(200))
    # Only set once receipt photos arrive in Milestone 3.
    receipt_s3_key: Mapped[str | None] = mapped_column(String(1024))
    subtotal_cents: Mapped[int] = mapped_column(server_default="0")
    tax_cents: Mapped[int] = mapped_column(server_default="0")
    tip_cents: Mapped[int] = mapped_column(server_default="0")
    total_cents: Mapped[int] = mapped_column(server_default="0")
    split_tip: Mapped[bool] = mapped_column(server_default=text("true"))
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# """One item on the receipt."""
class LineItem(Base):
    __tablename__ = "line_item"
    __table_args__ = (CheckConstraint("price_cents >= 0", name="price_not_negative"),)

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    bill_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("bill.id", ondelete="CASCADE"), index=True
    )
    description: Mapped[str] = mapped_column(String(255))
    price_cents: Mapped[int]
    # Where the item sits on the receipt, so the crew see them in the same order.
    position: Mapped[int]


# One person at the table. The Captain gets a row too, so they claim items the same way.
class CrewMember(Base):
    __tablename__ = "crew_member"
    __table_args__ = (
        # A partial index: only rows where is_captain is true count, so a bill can have any
        # number of crew but only one Captain.
        Index(
            "uq_crew_member_one_captain_per_bill",
            "bill_id",
            unique=True,
            postgresql_where=text("is_captain"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    bill_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("bill.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(100))
    phone: Mapped[str | None] = mapped_column(String(32))
    email: Mapped[str | None] = mapped_column(String(320))
    # A hash of the token on their device, never the token itself (design §15). The Captain's
    # row has none, because they sign in with their account.
    token_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    is_captain: Mapped[bool] = mapped_column(server_default=text("false"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# One person's dibs on one item, joining LineItem and CrewMember.
class Claim(Base):
    __tablename__ = "claim"
    __table_args__ = (
        # Nobody can claim the same item twice. This also indexes lookups by line_item_id.
        UniqueConstraint(
            "line_item_id", "crew_member_id", name="uq_claim_line_item_id_crew_member_id"
        ),
        CheckConstraint("shares >= 1", name="shares_at_least_one"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    line_item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("line_item.id", ondelete="CASCADE"))
    crew_member_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("crew_member.id", ondelete="CASCADE"), index=True
    )
    shares: Mapped[int] = mapped_column(server_default="1")
