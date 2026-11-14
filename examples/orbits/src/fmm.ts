// The fast multipole method for point masses on a plane, where a mass m pulls with m / distance.
// A point is z = x + iy, and the field of the masses at z is F(z) = Σ m / (z - z_j), which pulls with -conj(F).
const P = 12, // Terms of each expansion
  LEAF = 8, // Points per leaf box that the depth aims at
  DEPTH = 8;

// Pascal's triangle up to the largest binomial of a translation.
const C: number[][] = [[1]];
for (let n = 1; n < 2 * P; n++)
  C.push(
    Array.from(
      { length: n + 1 },
      (_, k) => (C[n - 1][k - 1] ?? 0) + (C[n - 1][k] ?? 0),
    ),
  );

/** Gives the powers 0 to count - 1 of a complex number. */
const powers = (re: number, im: number, count = P) => {
  const pr = new Float64Array(count).fill(0),
    pi = new Float64Array(count).fill(0);
  pr[0] = 1;
  for (let k = 1; k < count; k++) {
    pr[k] = pr[k - 1] * re - pi[k - 1] * im;
    pi[k] = pr[k - 1] * im + pi[k - 1] * re;
  }
  return [pr, pi] as const;
};

/**
 * Gives the pull on each point from the others, with a softened pull from the points in the neighbor boxes.
 * A tree of square boxes holds multipole expansions of the points up, and local expansions down from the far boxes, so the cost is linear in the points. */
export const pull = (
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  ms: ArrayLike<number>,
  soft: number,
) => {
  const n = xs.length,
    ax = new Float64Array(n),
    ay = new Float64Array(n);
  if (!n) return { ax, ay };
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, xs[i]);
    x1 = Math.max(x1, xs[i]);
    y0 = Math.min(y0, ys[i]);
    y1 = Math.max(y1, ys[i]);
  }
  const side = Math.max(x1 - x0, y1 - y0, 1) * 1.001,
    top = Math.min(
      DEPTH,
      Math.max(2, Math.ceil(Math.log(n / LEAF) / Math.log(4))),
    ),
    N = 2 ** top,
    leafOf = new Int32Array(n),
    start = new Int32Array(N * N + 1),
    order = new Int32Array(n);
  const boxes = () =>
    Array.from({ length: top + 1 }, (_, l) => new Float64Array(4 ** l * P));
  const [mr, mi, lr, li] = [boxes(), boxes(), boxes(), boxes()];
  const cell = (v: number, o: number) =>
      Math.min(N - 1, (((v - o) / side) * N) | 0),
    centerX = (l: number, i: number) => x0 + ((i + 0.5) * side) / 2 ** l,
    centerY = (l: number, i: number) => y0 + ((i + 0.5) * side) / 2 ** l;

  // Sort the points into the leaf boxes.
  for (let i = 0; i < n; i++) {
    leafOf[i] = cell(ys[i], y0) * N + cell(xs[i], x0);
    start[leafOf[i] + 1]++;
  }
  for (let b = 0; b < N * N; b++) start[b + 1] += start[b];
  const next = start.slice(0, N * N);
  for (let i = 0; i < n; i++) order[next[leafOf[i]]++] = i;

  // Multipoles of the leaves: a[k] = Σ m (z - center)^k.
  for (let b = 0; b < N * N; b++) {
    const cx = centerX(top, b % N),
      cy = centerY(top, (b / N) | 0);
    for (let j = start[b]; j < start[b + 1]; j++) {
      const i = order[j],
        [pr, pi] = powers(xs[i] - cx, ys[i] - cy);
      for (let k = 0; k < P; k++) {
        mr[top][b * P + k] += ms[i] * pr[k];
        mi[top][b * P + k] += ms[i] * pi[k];
      }
    }
  }

  // The offsets of the four children of a box from its center, for boxes of side h.
  const shifts = (h: number) =>
    [0, 1, 2, 3].map(q => powers(((q & 1) - 0.5) * h, ((q >> 1) - 0.5) * h));

  // Up: each box takes the multipoles of its children, moved to its center.
  for (let l = top - 1; l >= 2; l--) {
    const w = 2 ** l,
      table = shifts(side / 2 ** (l + 1));
    for (let b = 0; b < w * w; b++)
      for (let q = 0; q < 4; q++) {
        const child =
            (2 * ((b / w) | 0) + (q >> 1)) * 2 * w + 2 * (b % w) + (q & 1),
          [pr, pi] = table[q];
        for (let k = 0; k < P; k++)
          for (let j = 0; j <= k; j++) {
            const f = C[k][j],
              ar = mr[l + 1][child * P + j],
              ai = mi[l + 1][child * P + j];
            mr[l][b * P + k] += f * (pr[k - j] * ar - pi[k - j] * ai);
            mi[l][b * P + k] += f * (pr[k - j] * ai + pi[k - j] * ar);
          }
      }
  }

  // Down: each box takes the locals of its parent, and the multipoles of the far boxes whose parents are near its parent.
  // F(z) = Σ b[m] (z - center)^m near the center of a box.
  for (let l = 2; l <= top; l++) {
    const w = 2 ** l,
      h = side / w,
      table = shifts(h);
    for (let b = 0; b < w * w; b++) {
      const bx = b % w,
        by = (b / w) | 0,
        px = bx >> 1,
        py = by >> 1,
        parent = py * (w >> 1) + px;
      if (l > 2) {
        const [pr, pi] = table[(bx & 1) | ((by & 1) << 1)];
        for (let m = 0; m < P; m++)
          for (let k = m; k < P; k++) {
            const f = C[k][m],
              br = lr[l - 1][parent * P + k],
              bi = li[l - 1][parent * P + k];
            lr[l][b * P + m] += f * (pr[k - m] * br - pi[k - m] * bi);
            li[l][b * P + m] += f * (pr[k - m] * bi + pi[k - m] * br);
          }
      }
      for (
        let qy = Math.max(py - 1, 0);
        qy <= Math.min(py + 1, w / 2 - 1);
        qy++
      )
        for (
          let qx = Math.max(px - 1, 0);
          qx <= Math.min(px + 1, w / 2 - 1);
          qx++
        )
          for (let q = 0; q < 4; q++) {
            const sx = 2 * qx + (q & 1),
              sy = 2 * qy + (q >> 1);
            if (Math.abs(sx - bx) <= 1 && Math.abs(sy - by) <= 1) continue;
            const source = sy * w + sx,
              dr = (bx - sx) * h,
              di = (by - sy) * h,
              dd = dr * dr + di * di,
              [ir, ii] = powers(dr / dd, -di / dd, 2 * P);
            for (let m = 0; m < P; m++)
              for (let k = 0; k < P; k++) {
                // The term is a[k] (-1)^m C(k + m, m) / d^(k + m + 1).
                const f = (m & 1 ? -1 : 1) * C[k + m][m],
                  ar = mr[l][source * P + k],
                  ai = mi[l][source * P + k],
                  er = ir[k + m + 1],
                  ei = ii[k + m + 1];
                lr[l][b * P + m] += f * (ar * er - ai * ei);
                li[l][b * P + m] += f * (ar * ei + ai * er);
              }
          }
    }
  }

  // Each point takes its local expansion, and the pull of the points in the leaf and the leaves next to it.
  for (let b = 0; b < N * N; b++) {
    const bx = b % N,
      by = (b / N) | 0,
      cx = centerX(top, bx),
      cy = centerY(top, by);
    for (let j = start[b]; j < start[b + 1]; j++) {
      const i = order[j],
        wr = xs[i] - cx,
        wi = ys[i] - cy;
      let fr = lr[top][b * P + P - 1],
        fi = li[top][b * P + P - 1];
      for (let k = P - 2; k >= 0; k--) {
        const t = fr * wr - fi * wi + lr[top][b * P + k];
        fi = fr * wi + fi * wr + li[top][b * P + k];
        fr = t;
      }
      let gx = -fr,
        gy = fi;
      for (let ny = Math.max(by - 1, 0); ny <= Math.min(by + 1, N - 1); ny++)
        for (
          let nx = Math.max(bx - 1, 0);
          nx <= Math.min(bx + 1, N - 1);
          nx++
        ) {
          const c = ny * N + nx;
          for (let e = start[c]; e < start[c + 1]; e++) {
            const o = order[e];
            if (o === i) continue;
            const dx = xs[o] - xs[i],
              dy = ys[o] - ys[i],
              f = ms[o] / (dx * dx + dy * dy + soft);
            gx += f * dx;
            gy += f * dy;
          }
        }
      ax[i] = gx;
      ay[i] = gy;
    }
  }
  return { ax, ay };
};
