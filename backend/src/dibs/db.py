from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from dibs.config import settings

# One engine per process: it owns the connection pool.
engine = create_async_engine(settings.database_url)

# Factory for sessions. expire_on_commit=False keeps objects readable after commit,
# which async code needs (it can't lazily reload attributes).
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI dependency: one session per request, always closed afterwards."""
    async with SessionLocal() as session:
        yield session
