// A screenshot as terminal cells: every cell is "▀" with the upper pixel as its
// foreground and the lower one as its background, so any truecolor terminal
// (Warp, iTerm2, Terminal.app) shows a picture without an image protocol.

export type RasterImage = { columns: number; rows: number; cells: Uint8Array }

const UPPER_HALF = 0x2580

/** Reads an uncompressed 24- or 32-bit BMP (what `sips -s format bmp` writes). */
export function decodeBmp(bytes: Uint8Array): { width: number; height: number; rgb: (x: number, y: number) => number } | undefined {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const offset = view.getUint32(10, true)
  const width = view.getInt32(18, true)
  const rawHeight = view.getInt32(22, true)
  const bpp = view.getUint16(28, true)
  const compression = view.getUint32(30, true)
  if (width <= 0 || rawHeight === 0 || (bpp !== 24 && bpp !== 32) || (compression !== 0 && compression !== 3)) return undefined
  const height = Math.abs(rawHeight)
  const isTopDown = rawHeight < 0
  const stride = Math.ceil((width * bpp) / 32) * 4
  const step = bpp / 8
  if (offset + stride * height > bytes.length) return undefined
  return {
    width,
    height,
    rgb: (x, y) => {
      const row = isTopDown ? y : height - 1 - y
      const i = offset + row * stride + x * step
      // BMP stores blue, green, red.
      return (bytes[i + 2]! << 16) | (bytes[i + 1]! << 8) | bytes[i]!
    },
  }
}

/** Two pixel rows per terminal row: the BMP should be `columns` wide and `2 × rows` tall. */
export function bmpToRaster(bytes: Uint8Array): RasterImage | undefined {
  const bmp = decodeBmp(bytes)
  if (!bmp) return undefined
  const columns = Math.min(512, bmp.width)
  const rows = Math.min(256, Math.floor(bmp.height / 2))
  if (columns < 1 || rows < 1) return undefined
  const words = new Uint32Array(columns * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const k = (r * columns + c) * 3
      words[k] = UPPER_HALF
      words[k + 1] = bmp.rgb(c, r * 2)
      words[k + 2] = bmp.rgb(c, r * 2 + 1)
    }
  }
  return { columns, rows, cells: new Uint8Array(words.buffer) }
}

/** Pixel size for a 16:9 screenshot drawn `columns` cells wide (cells are about twice as tall as wide). */
export function previewSize(columns: number): { width: number; height: number } {
  const width = Math.max(16, Math.min(200, Math.floor(columns)))
  const height = Math.max(2, Math.round((width * 9) / 16 / 2) * 2)
  return { width, height }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64, without relying on the runtime having Uint8Array.toBase64. */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (b === undefined ? '=' : B64[(n >> 6) & 63]!) + (c === undefined ? '=' : B64[n & 63]!)
  }
  return out
}

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]!) << 18) | (B64.indexOf(clean[i + 1] ?? 'A') << 12) | ((clean[i + 2] ? B64.indexOf(clean[i + 2]!) : 0) << 6) | (clean[i + 3] ? B64.indexOf(clean[i + 3]!) : 0)
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (o < out.length && clean[i + 2]) out[o++] = (n >> 8) & 255
    if (o < out.length && clean[i + 3]) out[o++] = n & 255
  }
  return out
}
