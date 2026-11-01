# Database tests run against real Postgres, with the schema built by the migrations, so they
# exercise the same constraints production has. Each test runs in a transaction that gets rolled
# back, so tests can't affect each other or leave rows behind.

from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from dibs.config import settings
from dibs.db import get_session
from dibs.main import app


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
async def connection(anyio_backend: str) -> AsyncIterator[AsyncConnection]:
    # NullPool because a pooled connection can't be reused from another test's event loop.
    engine = create_async_engine(settings.database_url, poolclass=NullPool)
    async with engine.connect() as connection:
        transaction = await connection.begin()
        yield connection
        await transaction.rollback()
    await engine.dispose()


# create_savepoint turns the code's session.commit() into a savepoint, so the outer transaction
# can still roll everything back.
def make_session(connection: AsyncConnection) -> AsyncSession:
    return AsyncSession(
        bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint"
    )


@pytest.fixture
async def session(connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    async with make_session(connection) as session:
        yield session


# Calls the app directly, with no real server, using the test's transaction for every request.
@pytest.fixture
async def client(connection: AsyncConnection) -> AsyncIterator[AsyncClient]:
    async def override_get_session() -> AsyncIterator[AsyncSession]:
        async with make_session(connection) as session:
            yield session

    app.dependency_overrides[get_session] = override_get_session
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        yield client
    app.dependency_overrides.clear()
