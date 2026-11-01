// Claude scales down anything bigger than about this anyway, so a larger photo only adds upload time.
const MAX_EDGE = 2000
const JPEG_QUALITY = 0.85

// The browser couldn't open the file. The message is safe to show to the user.
export class UnreadableImageError extends Error {}

export function fitWithin(width: number, height: number, maxEdge: number) {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

// Shrinks a photo and converts it to JPEG in the browser, so phone photos fit the API's limit and
// formats it can't read, like iPhone HEIC, work wherever the browser can open them.
export async function shrinkImage(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new UnreadableImageError("This photo couldn't be opened. Try a JPEG or PNG.")
  }

  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_EDGE)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  )
  if (!blob) throw new UnreadableImageError("This photo couldn't be opened. Try a JPEG or PNG.")
  return blob
}
