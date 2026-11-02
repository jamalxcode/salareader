export const env = {};
export async function pipeline() {
  return async (batch) => {
    const t0 = Date.now(); while (Date.now() - t0 < 60) {} // slow, like the real model
    const data = new Float32Array(batch.length * 384);
    batch.forEach((txt, b) => { let h = 0; for (const c of txt) h = (h * 31 + c.charCodeAt(0)) | 0; for (let i = 0; i < 384; i++) data[b * 384 + i] = Math.sin(h + i) / 13.8; });
    return { dims: [batch.length, 384], data };
  };
}
