// A palette of nice embed colors. Returns one at random each time.
const PALETTE = [0xb57edc, 0x9b59b6, 0xe67e22, 0x2ecc71, 0x1abc9c, 0x3498db, 0xe74c3c, 0x9b59b6, 0x34495e, 0xf1c40f];
export function randomEmbedColor() {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}
