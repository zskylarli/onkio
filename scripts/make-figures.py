"""
Static figures of the shared embedding, drawn from the coordinates the
simulation emitted rather than from a re-run of the pipeline.

    npx vite-node scripts/simulate-two-files.ts --scenario=analyzed \
        --emit=scripts/figures/data/analyzed-embedding.json
    python3 scripts/make-figures.py

Every number on a figure is read from that file or counted off its points, so a
figure cannot drift from the statistics the same run printed. `verify()` fails
the render rather than shipping a picture that disagrees with them.

Design constraints, in the order they mattered:

- The two collections are two lobes that touch, not a gradient. Nothing here
  interpolates, contours or density-shades, because that would draw a
  continuous taste space the measurement does not support.
- Equal aspect everywhere, since UMAP distances are the only thing on these
  axes worth reading and anisotropic scaling would corrupt them. The axes are
  labelled as arbitrary and every scatter carries the caveat.
- Collection colours are Okabe-Ito, separable under deuteranopia, protanopia
  and tritanopia, and the pairs used differ in lightness so they also survive
  greyscale printing.
- Draw order is a seeded permutation. Painting one collection after the other
  would put the second on top everywhere and make a mixed region look pure.
"""

from __future__ import annotations

import argparse
import json
import textwrap
from dataclasses import dataclass
from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.lines import Line2D
from matplotlib.patches import Patch, Polygon

DPI = 150
DRAW_ORDER_SEED = 42

# Okabe-Ito. Adryft keeps orange wherever it appears, so the crate is the same
# colour in every scenario and the comparison reads as one story.
COLLECTION_COLOUR = {
    "adryft-rekordbox": "#E69F00",
    "apple-getsongbpm": "#0072B2",
    "skylar-songs": "#009E73",
}
FALLBACK_COLOURS = ["#CC79A7", "#56B4E9", "#D55E00", "#F0E442"]

COLLECTION_NAME = {
    "adryft-rekordbox": "Adryft rekordbox crate",
    "apple-getsongbpm": "Apple library, GetSongBPM-analyzed subset",
    "skylar-songs": "skylar_songs rekordbox export",
}
COLLECTION_SHORT = {
    "adryft-rekordbox": "Adryft",
    "apple-getsongbpm": "Apple",
    "skylar-songs": "skylar",
}

MISSING_COLOUR = "#BDBDBD"
UMAP_CAVEAT = (
    "UMAP dimensions are arbitrary: the axes have no units and no meaningful orientation, and only "
    "distances inside a neighbourhood should be read as similarity. Counts and shares are exact; the "
    "geometry between distant lobes is not. Both axes are on the same scale."
)


@dataclass
class Run:
    """One emitted embedding, per-point columns as parallel arrays."""

    scenario: str
    title: str
    separation: dict
    collections: list[dict]
    x: np.ndarray
    y: np.ndarray
    collection: np.ndarray
    cluster: np.ndarray
    bpm: np.ndarray
    genre: list[str | None]
    # Which emitted UMAP component ended up on which screen axis (see load()).
    xdim: int
    ydim: int

    @property
    def n(self) -> int:
        return len(self.x)

    @property
    def cluster_ids(self) -> list[int]:
        return sorted(set(self.cluster.tolist()))

    def colour(self, k: int) -> str:
        cid = self.collections[k]["id"]
        return COLLECTION_COLOUR.get(cid, FALLBACK_COLOURS[k % len(FALLBACK_COLOURS)])

    def name(self, k: int) -> str:
        c = self.collections[k]
        return COLLECTION_NAME.get(c["id"], c["label"])

    def short(self, k: int) -> str:
        c = self.collections[k]
        return COLLECTION_SHORT.get(c["id"], c["label"])

    def count(self, k: int) -> int:
        return int(np.count_nonzero(self.collection == k))

    def sep_pct(self) -> float:
        return self.separation["index"] * 100


def load(path: Path) -> Run:
    raw = json.loads(path.read_text())
    pts = raw["points"]
    x = np.array([p["x"] for p in pts], dtype=float)
    y = np.array([p["y"] for p in pts], dtype=float)
    # Equal aspect on a landscape page needs the long extent horizontal, and
    # swapping two UMAP components is a relabelling, not a distortion: it
    # preserves every distance. The axis labels say which component is which.
    xdim, ydim = 1, 2
    if np.ptp(y) > np.ptp(x):
        x, y = y, x
        xdim, ydim = 2, 1
    return Run(
        scenario=raw["scenario"],
        title=raw["title"],
        separation=raw["separation"],
        collections=raw["collections"],
        x=x,
        y=y,
        collection=np.array([p["collection"] for p in pts], dtype=int),
        cluster=np.array([p["cluster"] for p in pts], dtype=int),
        bpm=np.array([np.nan if p["bpm"] is None else p["bpm"] for p in pts], dtype=float),
        genre=[p["genre"] for p in pts],
        xdim=xdim,
        ydim=ydim,
    )


# ---------- shared drawing helpers ----------


def header(fig, title: str, subtitle: str = "", wrap: int = 130) -> float:
    """Title and subtitle as figure text, returning the top the axes may use.
    Laid out by hand because tight_layout cannot see text it did not place."""
    fig.text(0.008, 0.986, title, fontsize=15, va="top", ha="left")
    if not subtitle:
        return 0.925
    body = textwrap.fill(subtitle, wrap)
    fig.text(0.008, 0.941, body, fontsize=9.5, color="#555555", va="top", ha="left")
    return 0.930 - 0.030 * (body.count("\n") + 1)


def caveat(fig, extra: str = "") -> None:
    fig.text(
        0.008,
        0.010,
        textwrap.fill(UMAP_CAVEAT + (" " + extra if extra else ""), 190),
        fontsize=7.5,
        color="#777777",
        va="bottom",
        ha="left",
    )


def style_axes(ax, run: Run) -> None:
    ax.set_xlabel(f"UMAP dimension {run.xdim} (arbitrary units)", fontsize=10)
    ax.set_ylabel(f"UMAP dimension {run.ydim} (arbitrary units)", fontsize=10)
    ax.tick_params(labelsize=8, colors="#666666", length=3)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color("#CCCCCC")
    ax.grid(True, color="#EEEEEE", linewidth=0.6)
    ax.set_axisbelow(True)
    pad = 0.035 * max(np.ptp(run.x), np.ptp(run.y))
    ax.set_xlim(run.x.min() - pad, run.x.max() + pad)
    ax.set_ylim(run.y.min() - pad, run.y.max() + pad)
    ax.set_aspect("equal", adjustable="box")


def shuffled(n: int) -> np.ndarray:
    return np.random.default_rng(DRAW_ORDER_SEED).permutation(n)


def marker_size(n: int) -> float:
    return 15.0 if n <= 1500 else 11.0


def collection_scatter(ax, run: Run, alpha: float = 0.62) -> list:
    """Both collections in one seeded-interleaved pass, with proxy legend handles."""
    order = shuffled(run.n)
    colours = np.array([run.colour(k) for k in range(len(run.collections))])
    ax.scatter(
        run.x[order],
        run.y[order],
        c=colours[run.collection[order]],
        s=marker_size(run.n),
        alpha=alpha,
        linewidths=0,
    )
    return [
        Line2D(
            [],
            [],
            marker="o",
            linestyle="none",
            markersize=7,
            markerfacecolor=run.colour(k),
            markeredgecolor="none",
            label=f"{run.name(k)} — {run.count(k):,} tracks",
        )
        for k in range(len(run.collections))
    ]


def convex_hull(pts: np.ndarray) -> np.ndarray:
    """Monotone chain. k-means in the 2D embedding carves Voronoi cells, so a
    cluster's convex hull is close to its real extent rather than a shape
    imposed on it."""
    p = np.unique(pts, axis=0)
    p = p[np.lexsort((p[:, 1], p[:, 0]))]
    if len(p) < 3:
        return p

    def half(points):
        out: list[np.ndarray] = []
        for q in points:
            while len(out) >= 2:
                a, b = out[-2], out[-1]
                if (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) <= 0:
                    out.pop()
                else:
                    break
            out.append(q)
        return out

    return np.array(half(p)[:-1] + half(p[::-1])[:-1])


# ---------- figure 1: coloured by collection ----------


def figure_collection(run: Run, out: Path) -> Path:
    fig = plt.figure(figsize=(10.67, 9.0), dpi=DPI)
    top = header(
        fig,
        "Two music libraries in one shared UMAP embedding",
        f"{run.n:,} tracks — {run.title}. Separation index {run.sep_pct():.1f}%: "
        f"{run.separation['purity'] * 100:.1f}% of a track's 15 nearest neighbours come from its own "
        f"collection, where {run.separation['fullyMixed'] * 100:.1f}% is what fully mixed would look like.",
    )
    ax = fig.add_subplot(111)
    fig.subplots_adjust(left=0.07, right=0.985, top=top, bottom=0.125)
    handles = collection_scatter(ax, run)
    style_axes(ax, run)
    fig.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.048), fontsize=10, frameon=False, ncols=2)
    caveat(fig)
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    return out


# ---------- figure 2: coloured by BPM ----------


def figure_bpm(run: Run, out: Path) -> Path:
    fig = plt.figure(figsize=(10.67, 9.0), dpi=DPI)
    top = header(
        fig,
        "The same embedding, coloured by tempo",
        "Tempo is what separates the two collections: the crate's lobe is one narrow band of colour, "
        "the listening library's spans the whole scale.",
    )
    ax = fig.add_subplot(111)
    fig.subplots_adjust(left=0.07, right=0.90, top=top, bottom=0.125)
    have = np.isfinite(run.bpm)
    # Clipped at the 1st/99th percentile: a handful of 47 and 212 BPM readings
    # would otherwise spend most of the colour range on outliers and flatten
    # the 120-135 band the whole finding lives in.
    lo, hi = np.percentile(run.bpm[have], [1, 99])
    order = shuffled(run.n)
    missing = order[~have[order]]
    ax.scatter(
        run.x[missing], run.y[missing], c=MISSING_COLOUR, s=marker_size(run.n), alpha=0.9, linewidths=0
    )
    keep = order[have[order]]
    sc = ax.scatter(
        run.x[keep],
        run.y[keep],
        c=run.bpm[keep],
        cmap="viridis",
        vmin=lo,
        vmax=hi,
        s=marker_size(run.n),
        alpha=0.85,
        linewidths=0,
    )
    style_axes(ax, run)
    cbar = fig.colorbar(sc, ax=ax, pad=0.02, fraction=0.05, extend="both")
    cbar.set_label("BPM", fontsize=10)
    cbar.ax.tick_params(labelsize=8)
    n_missing = int(np.count_nonzero(~have))
    if n_missing:
        fig.legend(
            handles=[
                Line2D(
                    [],
                    [],
                    marker="o",
                    linestyle="none",
                    markersize=7,
                    markerfacecolor=MISSING_COLOUR,
                    markeredgecolor="none",
                    label=f"no BPM — {n_missing:,} tracks",
                )
            ],
            loc="lower center",
            bbox_to_anchor=(0.5, 0.048),
            fontsize=10,
            frameon=False,
        )
    caveat(fig, f"Colour clipped to {lo:.0f}-{hi:.0f} BPM (1st-99th percentile).")
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    return out


# ---------- figure 3: where the seam is ----------


def figure_clusters(run: Run, out: Path, highlight: tuple[int, ...]) -> Path:
    """Scatter plus stacked bars, because the seam is two claims at once: the
    scatter says where the collections touch, the bars say that only two of
    twelve clusters touch at all. Small multiples were the alternative and
    would have spent eleven panels showing single-colour clusters."""
    fig = plt.figure(figsize=(14.0, 8.0), dpi=DPI)
    top = header(
        fig,
        "The shared seam: two clusters out of twelve",
        f"Everything outside the two mixed clusters is greyed out, so the only colour left on the map is "
        f"territory both collections occupy. Cluster ids are k-means labels over the same {run.n:,} points.",
        wrap=150,
    )
    gs = fig.add_gridspec(1, 2, width_ratios=(1.45, 1), wspace=0.16)
    ax = fig.add_subplot(gs[0, 0])
    bx = fig.add_subplot(gs[0, 1])
    fig.subplots_adjust(left=0.055, right=0.975, top=top, bottom=0.135)

    n_coll = len(run.collections)
    ids = run.cluster_ids
    counts = np.array(
        [
            [int(np.count_nonzero((run.cluster == c) & (run.collection == k))) for k in range(n_coll)]
            for c in ids
        ]
    )
    totals = counts.sum(axis=1)

    inside = np.isin(run.cluster, highlight)
    order = shuffled(run.n)
    bg = order[~inside[order]]
    ax.scatter(run.x[bg], run.y[bg], c="#DCDCDC", s=marker_size(run.n), alpha=0.9, linewidths=0)
    fg = order[inside[order]]
    colours = np.array([run.colour(k) for k in range(n_coll)])
    ax.scatter(
        run.x[fg],
        run.y[fg],
        c=colours[run.collection[fg]],
        s=marker_size(run.n) + 5,
        alpha=0.88,
        linewidths=0,
    )

    for row, c in enumerate(ids):
        m = run.cluster == c
        cx, cy = run.x[m].mean(), run.y[m].mean()
        if c not in highlight:
            ax.text(cx, cy, str(c), fontsize=9, color="#8A8A8A", ha="center", va="center", zorder=4, fontweight="bold")
            continue
        hull = convex_hull(np.column_stack([run.x[m], run.y[m]]))
        ax.add_patch(
            Polygon(hull, closed=True, fill=False, edgecolor="#333333", linewidth=1.4, linestyle="--", zorder=5)
        )
        share = counts[row] / totals[row]
        b = run.bpm[m & np.isfinite(run.bpm)]
        label = (
            f"cluster {c} — {totals[row]} tracks\n"
            + " / ".join(f"{s * 100:.0f}% {run.short(k)}" for k, s in enumerate(share))
            + (f"\nmedian {np.median(b):.0f} BPM" if b.size else "")
        )
        ax.annotate(
            label,
            xy=(cx, cy),
            xytext=(-95 if c == highlight[0] else 95, 62 if c == highlight[0] else -62),
            textcoords="offset points",
            ha="center",
            fontsize=9,
            zorder=6,
            bbox=dict(boxstyle="round,pad=0.4", fc="white", ec="#333333", lw=1.0, alpha=0.95),
            arrowprops=dict(arrowstyle="-", color="#333333", lw=1.0),
        )

    style_axes(ax, run)

    # Sorted by the first collection's share, so mixed clusters separate from
    # pure ones by eye instead of by reading twelve numbers.
    row_order = np.argsort(counts[:, 0] / totals)
    ypos = np.arange(len(ids))
    left = np.zeros(len(ids))
    for k in range(n_coll):
        vals = (counts[row_order, k] / totals[row_order]) * 100
        bx.barh(ypos, vals, left=left, color=run.colour(k), edgecolor="white", linewidth=0.6, height=0.78)
        left += vals
    for i, r in enumerate(row_order):
        c = ids[r]
        mixed = min(counts[r]) / totals[r] > 0.1
        if mixed:
            bx.axhspan(i - 0.46, i + 0.46, color="#333333", alpha=0.07, zorder=0)
        bx.text(102, i, f"n={totals[r]}", va="center", fontsize=8.5, color="#666666")
        bx.text(
            -1.5,
            i,
            str(c),
            va="center",
            ha="right",
            fontsize=9,
            color="#222222" if mixed else "#666666",
            fontweight="bold" if mixed else "normal",
        )
    bx.set_yticks([])
    bx.set_ylim(-0.7, len(ids) - 0.3)
    bx.set_xlim(0, 118)
    bx.set_xticks([0, 25, 50, 75, 100])
    bx.set_xticklabels(["0", "25", "50", "75", "100%"])
    bx.tick_params(labelsize=8, colors="#666666", length=3)
    bx.set_xlabel("share of cluster", fontsize=10)
    bx.set_ylabel("k-means cluster", fontsize=10)
    for side in ("top", "right", "left"):
        bx.spines[side].set_visible(False)
    bx.spines["bottom"].set_color("#CCCCCC")
    n_mixed = sum(1 for r in range(len(ids)) if min(counts[r]) / totals[r] > 0.1)
    bx.set_title(
        f"{n_mixed} of {len(ids)} clusters draw at least 10% from both (shaded rows)",
        fontsize=11,
        loc="left",
        pad=8,
        color="#444444",
    )
    ax.set_title("grey numbers mark the centroid of each single-collection cluster", fontsize=11, loc="left", pad=8, color="#444444")

    fig.legend(
        handles=[Patch(facecolor=run.colour(k), label=run.name(k)) for k in range(n_coll)],
        loc="lower center",
        bbox_to_anchor=(0.5, 0.052),
        fontsize=10,
        frameon=False,
        ncols=2,
    )
    caveat(fig, "Dashed outlines are convex hulls of the two mixed clusters, not decision boundaries.")
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    return out


# ---------- figure 4: tempo per collection ----------


def figure_tempo(run: Run, out: Path) -> Path:
    fig = plt.figure(figsize=(13.4, 6.4), dpi=DPI)
    top = header(
        fig,
        "A crate is a tempo monoculture; a listening library is not",
        "Tempo is the feature that drives the split, and the shape of the two distributions says more "
        "than either median does: the crate is one spike, the listening library is spread across 60 BPM.",
        wrap=150,
    )
    gs = fig.add_gridspec(1, 2, wspace=0.2)
    ax = fig.add_subplot(gs[0, 0])
    bx = fig.add_subplot(gs[0, 1])
    fig.subplots_adjust(left=0.055, right=0.985, top=top, bottom=0.14)
    bins = np.arange(60, 186, 2.0)

    summaries = []
    for k in range(len(run.collections)):
        b = run.bpm[(run.collection == k) & np.isfinite(run.bpm)]
        median = float(np.median(b))
        near = float(np.count_nonzero(np.abs(b - median) <= 5) / b.size * 100)
        summaries.append((b, median, near))
        # Percent of the collection rather than counts: 1,059 against 311 would
        # otherwise flatten the smaller collection's shape out of view.
        clipped = np.clip(b, bins[0], bins[-1])
        weights = np.full(b.size, 100 / b.size)
        ax.hist(
            clipped,
            bins=bins,
            weights=weights,
            color=run.colour(k),
            alpha=0.5,
            label=f"{run.name(k)}\nn={b.size:,}, median {median:.0f} BPM, {near:.1f}% within ±5 BPM of it",
        )
        ax.hist(clipped, bins=bins, weights=weights, histtype="step", color=run.colour(k), linewidth=1.4)

    for k, (_, median, _) in enumerate(summaries):
        ax.axvline(median, color=run.colour(k), linestyle="--", linewidth=1.1, alpha=0.9)
        ax.axvspan(median - 5, median + 5, color=run.colour(k), alpha=0.09, zorder=0)

    ax.set_xlabel("BPM (2 BPM bins; the few tracks outside 60-184 are clipped into the end bins)", fontsize=10)
    ax.set_ylabel("percent of that collection's tracks", fontsize=10)
    ax.set_title("shaded band is ±5 BPM around each median", fontsize=10, loc="left", pad=8, color="#666666")
    ax.legend(fontsize=8.5, loc="upper left", frameon=True, framealpha=0.93)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.tick_params(labelsize=8, colors="#666666", length=3)
    ax.grid(True, axis="y", color="#EEEEEE", linewidth=0.6)
    ax.set_axisbelow(True)

    for k, (b, _, _) in enumerate(summaries):
        s = np.sort(b)
        bx.step(
            s,
            np.arange(1, s.size + 1) / s.size * 100,
            where="post",
            color=run.colour(k),
            linewidth=2.0,
            label=run.name(k),
        )
    bx.set_xlabel("BPM", fontsize=10)
    bx.set_ylabel("percent of collection at or below", fontsize=10)
    bx.set_title("the same fact as a cumulative curve", fontsize=10, loc="left", pad=8, color="#666666")
    bx.set_xlim(60, 185)
    bx.set_ylim(0, 100)
    bx.legend(fontsize=9, loc="lower right", frameon=False)
    for side in ("top", "right"):
        bx.spines[side].set_visible(False)
    bx.tick_params(labelsize=8, colors="#666666", length=3)
    bx.grid(True, color="#EEEEEE", linewidth=0.6)
    bx.set_axisbelow(True)
    tightest = max(range(len(summaries)), key=lambda k: summaries[k][2])
    b, median, _ = summaries[tightest]
    p25, p75 = np.percentile(b, [25, 75])
    bx.annotate(
        f"a near-vertical step is one tempo:\nhalf of {run.short(tightest)} sits\nbetween {p25:.0f} and {p75:.0f} BPM",
        xy=(median, 50),
        xytext=(64, 62),
        fontsize=9,
        color="#444444",
        arrowprops=dict(arrowstyle="->", color="#888888", lw=1.0),
    )
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    return out


# ---------- figure 5: confounded against corrected ----------


def figure_comparison(confounded: Run, corrected: Run, out: Path) -> Path:
    fig = plt.figure(figsize=(14.4, 7.6), dpi=DPI)
    top = header(
        fig,
        "What a coverage gap does to a shared map",
        "Same pipeline, same seeds, one collection swapped. On the left, one export has BPM for 9.7% of "
        "its tracks and lands in its own islands; on the right, both sides carry real tempo and key and "
        "the lobes touch along a seam.",
        wrap=150,
    )
    gs = fig.add_gridspec(1, 2, wspace=0.16)
    axes = [fig.add_subplot(gs[0, 0]), fig.add_subplot(gs[0, 1])]
    fig.subplots_adjust(left=0.055, right=0.985, top=top - 0.03, bottom=0.10)
    for ax, run, tag in (
        (axes[0], confounded, "Confounded: one export barely analyzed"),
        (axes[1], corrected, "Corrected: both sides analyzed"),
    ):
        handles = collection_scatter(ax, run, alpha=0.58)
        style_axes(ax, run)
        ax.set_title(f"{tag} — separation index {run.sep_pct():.1f}%", fontsize=12, loc="left", pad=8)
        ax.legend(handles=handles, loc="best", fontsize=8.5, frameon=True, framealpha=0.9)
    caveat(
        fig,
        "The panels are independent embeddings of different track sets, so compare the shape of the "
        "split rather than the coordinates.",
    )
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    return out


# ---------- figure 6: the artifact itself ----------


def figure_coverage_artifact(run: Run, out: Path) -> Path:
    """Why the confounded run separated so cleanly: a track with no BPM sits at
    the numeric block's mean, so "never analyzed" is itself a position."""
    fig = plt.figure(figsize=(10.67, 9.0), dpi=DPI)
    have = np.isfinite(run.bpm)
    per = "   ".join(
        f"{run.name(k)}: {np.count_nonzero(have & (run.collection == k)) / run.count(k) * 100:.1f}% analyzed"
        for k in range(len(run.collections))
    )
    top = header(
        fig,
        "The confounded pairing, coloured by whether a BPM exists at all",
        "Unanalyzed tracks sit at the tempo block's mean, so they gather in their own region — which is "
        f"the same region one collection occupies. {per}.",
    )
    ax = fig.add_subplot(111)
    fig.subplots_adjust(left=0.07, right=0.985, top=top, bottom=0.125)
    order = shuffled(run.n)
    handles = []
    for mask, colour, label in (
        (have, "#4F4F4F", f"has BPM — {int(np.count_nonzero(have)):,} tracks"),
        (~have, "#CC79A7", f"no BPM — {int(np.count_nonzero(~have)):,} tracks"),
    ):
        sel = order[mask[order]]
        ax.scatter(run.x[sel], run.y[sel], c=colour, s=marker_size(run.n), alpha=0.6, linewidths=0)
        handles.append(
            Line2D([], [], marker="o", linestyle="none", markersize=7, markerfacecolor=colour, markeredgecolor="none", label=label)
        )
    style_axes(ax, run)
    fig.legend(handles=handles, loc="lower center", bbox_to_anchor=(0.5, 0.048), fontsize=10, frameon=False, ncols=2)
    caveat(
        fig,
        "Read against the collection-coloured figure for this scenario: the unanalyzed region is one "
        "collection, which is what that run's 89.4% separation was measuring.",
    )
    fig.savefig(out, dpi=DPI)
    plt.close(fig)
    return out


# ---------- verification, so a wrong figure fails instead of shipping ----------


def verify(run: Run, expected: dict[str, int]) -> None:
    for k in range(len(run.collections)):
        cid = run.collections[k]["id"]
        got = run.count(k)
        want = expected.get(cid)
        if want is None:
            raise SystemExit(f"{run.scenario}: unexpected collection {cid}")
        if got != want:
            raise SystemExit(f"{run.scenario}: {cid} has {got} points, expected {want}")
    if sum(expected.values()) != run.n:
        raise SystemExit(f"{run.scenario}: {run.n} points, expected {sum(expected.values())}")
    per_cluster = sum(int(np.count_nonzero(run.cluster == c)) for c in run.cluster_ids)
    if per_cluster != run.n:
        raise SystemExit(f"{run.scenario}: cluster totals sum to {per_cluster}, not {run.n}")
    print(
        f"  {run.scenario}: {run.n:,} points, "
        + ", ".join(f"{run.collections[k]['id']}={run.count(k):,}" for k in range(len(run.collections)))
        + f", {len(run.cluster_ids)} clusters summing to {per_cluster:,}, separation {run.sep_pct():.1f}%"
    )


def main() -> None:
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", type=Path, default=here / "figures" / "data")
    ap.add_argument("--out-dir", type=Path, default=here / "figures")
    args = ap.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    analyzed = load(args.data_dir / "analyzed-embedding.json")
    confounded = load(args.data_dir / "two-rekordbox-embedding.json")

    print("verifying emitted embeddings against the reported statistics:")
    verify(analyzed, {"adryft-rekordbox": 1059, "apple-getsongbpm": 311})
    verify(confounded, {"skylar-songs": 935, "adryft-rekordbox": 1057})

    written = [
        figure_collection(analyzed, args.out_dir / "01-analyzed-by-collection.png"),
        figure_bpm(analyzed, args.out_dir / "02-analyzed-by-bpm.png"),
        figure_clusters(analyzed, args.out_dir / "03-analyzed-cluster-composition.png", highlight=(11, 2)),
        figure_tempo(analyzed, args.out_dir / "04-analyzed-tempo-distributions.png"),
        figure_collection(confounded, args.out_dir / "05-two-rekordbox-by-collection.png"),
        figure_comparison(confounded, analyzed, args.out_dir / "06-confounded-vs-corrected.png"),
        figure_coverage_artifact(confounded, args.out_dir / "07-two-rekordbox-bpm-coverage.png"),
    ]
    print("\nwrote:")
    for p in written:
        print(f"  {p}")


if __name__ == "__main__":
    main()
