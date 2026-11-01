# Runs real receipt photos through the parser so you can compare the result with the paper.
# Each photo is one real, paid call to Claude.
#
#   uv run python scripts/try_receipt.py receipt-samples
#   uv run python scripts/try_receipt.py receipt-samples/luigis.jpg

import asyncio
import mimetypes
import sys
from pathlib import Path

from dibs.config import settings
from dibs.receipts import (
    Receipt,
    ReceiptServiceError,
    ReceiptUnreadableError,
    create_client,
    format_dollars,
    parse_receipt,
)

# Claude Sonnet 5.5's price in dollars per million tokens. This is only for the estimate below,
# so check current pricing if it starts to matter.
INPUT_DOLLARS_PER_MILLION = 2
OUTPUT_DOLLARS_PER_MILLION = 10
SKIPPED_SUFFIXES = {".md", ".txt"}


def amount(cents: int | None) -> str:
    return "not printed" if cents is None else format_dollars(cents)


def show(receipt: Receipt) -> None:
    print(f"  Restaurant: {receipt.restaurant_name or 'not printed'}")
    print("  Items:")
    for item in receipt.items:
        print(f"    {format_dollars(item.price_cents):>10}  {item.description}")
    print(f"  Subtotal: {amount(receipt.subtotal_cents)}")
    print(f"  Tax:      {amount(receipt.tax_cents)}")
    print(f"  Tip:      {amount(receipt.tip_cents)}")
    print(f"  Total:    {amount(receipt.total_cents)}")
    for warning in receipt.warnings:
        print(f"  WARNING: {warning}")
    cost = (
        receipt.input_tokens * INPUT_DOLLARS_PER_MILLION
        + receipt.output_tokens * OUTPUT_DOLLARS_PER_MILLION
    ) / 1_000_000
    print(
        f"  Used {receipt.input_tokens} input and {receipt.output_tokens} output tokens, "
        f"about {cost * 100:.2f} cents."
    )


async def main(target: Path) -> int:
    if not settings.anthropic_api_key:
        print("No API key found. Put ANTHROPIC_API_KEY=your-key in backend/.env")
        return 1

    if target.is_dir():
        photos = [
            path
            for path in sorted(target.iterdir())
            if path.is_file() and path.suffix.lower() not in SKIPPED_SUFFIXES
        ]
    else:
        photos = [target]
    if not photos:
        print(f"No photos found in {target}.")
        return 1

    print(f"Reading {len(photos)} photo(s) with {settings.receipt_model}.")
    client = create_client()
    for photo in photos:
        print(f"\n{photo.name}")
        media_type = mimetypes.guess_type(photo.name)[0] or "unknown"
        try:
            show(await parse_receipt(photo.read_bytes(), media_type, client))
        except ReceiptUnreadableError as error:
            print(f"  COULD NOT READ: {error}")
        except ReceiptServiceError as error:
            # The original error says why, such as a bad API key or no credit.
            print(f"  FAILED: {error} {error.__cause__}")
            return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: uv run python scripts/try_receipt.py <photo or folder>")
        sys.exit(2)
    sys.exit(asyncio.run(main(Path(sys.argv[1]))))
