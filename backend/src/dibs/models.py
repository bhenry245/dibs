import uuid
from datetime import datetime

from sqlalchemy import DateTime, MetaData, String, func
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
