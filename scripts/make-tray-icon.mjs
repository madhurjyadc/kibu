// Generates the menu bar icon as a macOS template image (black + alpha).
// Dependency-free: builds the PNG with zlib so there is no image library in
// the build, and no binary blob checked into the repo.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crc = (crc >>> 8) ^ c
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 6    // colour type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** Draws the pet silhouette: a rounded blob with two eye cut-outs. */
function drawPet(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2 + size * 0.03
  const rx = size * 0.38
  const ry = size * 0.42
  const SS = 3 // supersampling for smooth edges

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          // Body: a slightly egg-shaped ellipse.
          const taper = 1 - 0.12 * ((py - cy) / ry)
          const dx = (px - cx) / (rx * taper)
          const dy = (py - cy) / ry
          if (dx * dx + dy * dy > 1) continue
          // Eyes punched out so the shape reads as a face at 22px.
          const eyeY = cy - size * 0.06
          const eyeR = size * 0.075
          const leftDx = px - (cx - size * 0.15)
          const rightDx = px - (cx + size * 0.15)
          const eyeDy = py - eyeY
          if (leftDx * leftDx + eyeDy * eyeDy < eyeR * eyeR) continue
          if (rightDx * rightDx + eyeDy * eyeDy < eyeR * eyeR) continue
          hits++
        }
      }
      const alpha = Math.round((hits / (SS * SS)) * 255)
      const i = (y * size + x) * 4
      // Template images must be black; macOS recolours them for the menu bar.
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = alpha
    }
  }
  return png(size, size, rgba)
}

const out = join(process.cwd(), 'resources')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'trayTemplate.png'), drawPet(22))
writeFileSync(join(out, 'trayTemplate@2x.png'), drawPet(44))
console.log('wrote resources/trayTemplate.png and @2x')
