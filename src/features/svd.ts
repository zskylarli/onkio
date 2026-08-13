/**
 * Dimensionality reduction to ~50 dims before UMAP (§6): ~300 sparse dims
 * straight into UMAP is slow and noisy. d stays small (few hundred), so the
 * cheap, robust route is eigendecomposition of the d×d Gram matrix AᵀA via
 * cyclic Jacobi, then projecting A onto the top-k eigenvectors.
 */

export type Reduction = {
  data: Float32Array;
  n: number;
  /** Output width: k, or the input width when no reduction was needed. */
  d: number;
  /**
   * The `inputD × d` projection the rows were pushed through, row-major, with
   * columns in output order. Kept so a row that was not in the corpus can be
   * projected into the same space instead of forcing a re-fit that would move
   * every existing point. `null` means no reduction was applied and the basis
   * is the identity.
   *
   * The Gram matrix is uncentered, so projecting a new row is a plain dot
   * product against this basis — there is no mean vector to subtract. Kept at
   * double precision, the precision the eigensolver worked in, so that
   * re-projecting an original row reproduces its reduced coordinates exactly
   * rather than approximately.
   */
  basis: Float64Array | null;
  /** Width of a row going in, i.e. the original `d`. */
  inputD: number;
};

export function reduceDims(
  data: Float32Array,
  n: number,
  d: number,
  k: number
): Reduction {
  if (d <= k) return { data, n, d, basis: null, inputD: d };

  // C = AᵀA (symmetric d×d)
  const c = new Float64Array(d * d);
  for (let r = 0; r < n; r++) {
    const row = r * d;
    for (let i = 0; i < d; i++) {
      const vi = data[row + i];
      if (vi === 0) continue;
      for (let j = i; j < d; j++) c[i * d + j] += vi * data[row + j];
    }
  }
  for (let i = 0; i < d; i++)
    for (let j = 0; j < i; j++) c[i * d + j] = c[j * d + i];

  const { values, vectors } = jacobiEigen(c, d);

  // top-k eigenvectors by eigenvalue
  const order = values
    .map((v, i) => [v, i] as [number, number])
    .sort((a, b) => b[0] - a[0])
    .slice(0, k)
    .map(([, i]) => i);

  const basis = new Float64Array(d * k);
  for (let i = 0; i < d; i++)
    for (let kk = 0; kk < k; kk++) basis[i * k + kk] = vectors[i * d + order[kk]];

  const out = new Float32Array(n * k);
  for (let r = 0; r < n; r++) {
    const row = r * d;
    for (let kk = 0; kk < k; kk++) {
      const col = order[kk];
      let s = 0;
      for (let i = 0; i < d; i++) s += data[row + i] * vectors[i * d + col];
      out[r * k + kk] = s;
    }
  }
  return { data: out, n, d: k, basis, inputD: d };
}

/** Cyclic Jacobi eigensolver for a symmetric matrix (Float64Array, size d×d).
 * Returns eigenvalues and column eigenvectors. */
export function jacobiEigen(
  a: Float64Array,
  d: number
): { values: number[]; vectors: Float64Array } {
  const m = Float64Array.from(a);
  const v = new Float64Array(d * d);
  for (let i = 0; i < d; i++) v[i * d + i] = 1;

  const MAX_SWEEPS = 30;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let off = 0;
    for (let p = 0; p < d; p++)
      for (let q = p + 1; q < d; q++) off += m[p * d + q] ** 2;
    if (off < 1e-18) break;

    for (let p = 0; p < d; p++) {
      for (let q = p + 1; q < d; q++) {
        const apq = m[p * d + q];
        if (Math.abs(apq) < 1e-15) continue;
        const app = m[p * d + p];
        const aqq = m[q * d + q];
        const theta = (aqq - app) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;

        for (let i = 0; i < d; i++) {
          const aip = m[i * d + p];
          const aiq = m[i * d + q];
          m[i * d + p] = cos * aip - sin * aiq;
          m[i * d + q] = sin * aip + cos * aiq;
        }
        for (let i = 0; i < d; i++) {
          const api = m[p * d + i];
          const aqi = m[q * d + i];
          m[p * d + i] = cos * api - sin * aqi;
          m[q * d + i] = sin * api + cos * aqi;
        }
        for (let i = 0; i < d; i++) {
          const vip = v[i * d + p];
          const viq = v[i * d + q];
          v[i * d + p] = cos * vip - sin * viq;
          v[i * d + q] = sin * vip + cos * viq;
        }
      }
    }
  }

  const values: number[] = [];
  for (let i = 0; i < d; i++) values.push(m[i * d + i]);
  return { values, vectors: v };
}
