import { afterEach, expect, test, vi } from 'vitest'
import { fitWithin, shrinkImage, UnreadableImageError } from './image.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test.each([
  [4000, 3000, 2000, 1500],
  [3000, 4000, 1500, 2000],
  [1000, 8000, 250, 2000],
  [800, 600, 800, 600],
  [2000, 2000, 2000, 2000],
])('fits %ix%i into %ix%i', (width, height, expectedWidth, expectedHeight) => {
  expect(fitWithin(width, height, 2000)).toEqual({ width: expectedWidth, height: expectedHeight })
})

function stubCanvas(result: Blob | null) {
  const drawImage = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D)
  const toBlob = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation((callback) => callback(result))
  return { drawImage, toBlob }
}

test('shrinks a large photo and converts it to JPEG', async () => {
  const bitmap = { width: 4000, height: 3000, close: vi.fn() }
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
  const jpeg = new Blob(['small'], { type: 'image/jpeg' })
  const { drawImage, toBlob } = stubCanvas(jpeg)

  const result = await shrinkImage(new Blob(['huge']))

  expect(result).toBe(jpeg)
  expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 2000, 1500)
  expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.85)
  expect(bitmap.close).toHaveBeenCalled()
})

test('a file the browser cannot open gets a friendly error', async () => {
  vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new DOMException('nope')))

  await expect(shrinkImage(new Blob(['not a photo']))).rejects.toBeInstanceOf(UnreadableImageError)
})

test('a canvas that cannot produce an image gets a friendly error', async () => {
  const bitmap = { width: 10, height: 10, close: vi.fn() }
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
  stubCanvas(null)

  await expect(shrinkImage(new Blob(['photo']))).rejects.toBeInstanceOf(UnreadableImageError)
})
