#!/usr/bin/env python3
"""
Contribution Chart Generator (True Step Charts)
Reads *-summary.csv and *-revisions.csv and outputs flat step charts by 
properly forward-filling missing timeline gaps.

Usage:
    python charts.py --summary <summary.csv> --revisions <revisions.csv> [--output <folder>]
"""

import argparse
import os
import sys
from io import StringIO

import pandas as pd
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import matplotlib.ticker as mticker
import seaborn as sns

# ── STYLE ─────────────────────────────────────────────────────────────────────

sns.set_theme(style="whitegrid", palette="tab10", rc={
    "axes.titlesize":   14,
    "axes.titleweight": "bold",
    "axes.labelsize":   10,
    "font.size":        9,
    "legend.frameon":   False,
})

# ── CSV PARSING ───────────────────────────────────────────────────────────────

def load_csv(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip().startswith("#"):
                rows.append(line)
    return pd.read_csv(StringIO("".join(rows)))

# ── PIE CHART ─────────────────────────────────────────────────────────────────

def plot_pie(summary_df, output_path):
    names  = summary_df["Name"].fillna("Unknown").tolist()
    values = (summary_df["Words Added"] - summary_df["Words Removed"]).clip(lower=0).tolist()
    total  = sum(values)
    colors = sns.color_palette("tab10", len(names))

    fig, ax = plt.subplots(figsize=(8, 6))

    wedges, texts, autotexts = ax.pie(
        values,
        labels=names,
        colors=colors,
        autopct=lambda p: f"{p:.1f}%" if p > 2 else "",
        startangle=90,
        counterclock=False,
        wedgeprops=dict(edgecolor="white", linewidth=1.5),
        pctdistance=0.75,
    )
    for text in texts:
        text.set_fontsize(9)
    for autotext in autotexts:
        autotext.set_fontsize(8)
        autotext.set_color("white")
        autotext.set_fontweight("bold")

    legend_labels = [
        f"{n}  —  {v:,} net words ({v / total * 100:.1f}%)" if total else f"{n}  —  {v:,}"
        for n, v in zip(names, values)
    ]
    ax.legend(wedges, legend_labels, loc="lower center", bbox_to_anchor=(0.5, -0.12),
              ncol=min(2, len(names)), fontsize=9, frameon=False)
    ax.set_title("Overall Net Word Contribution", pad=16)

    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  ✅ Pie chart saved → {output_path}")

# ── TRUE STEP CHART BY DATE ───────────────────────────────────────────────────

def plot_line(revisions_df, col, title, ylabel, output_path):
    df = revisions_df.copy()
    df[col]    = pd.to_numeric(df[col], errors="coerce").fillna(0)
    df["Name"] = df["Name"].fillna("Unknown")
    df["Timestamp"] = pd.to_datetime(
        df["Modified Time (SGT)"].str.replace(" SGT", "", regex=False),
        format="%Y-%m-%d %H:%M:%S",
    ).dt.normalize()

    # Group updates by name and date
    df = df.groupby(["Name", "Timestamp"], as_index=False)[col].sum()

    users = df["Name"].unique().tolist()
    if not users:
        return

    # Create a complete timeline range from start to finish
    min_date = df["Timestamp"].min()
    max_date = df["Timestamp"].max()
    all_dates = pd.date_range(start=min_date, end=max_date, freq='D')

    # Build a comprehensive matrix of every user x every date to prevent diagonal lines
    expanded_records = []
    for user in users:
        user_df = df[df["Name"] == user].set_index("Timestamp")[[col]]
        user_df = user_df.reindex(all_dates).fillna(0)
        user_df["Cumulative"] = user_df[col].cumsum()   
        
        for date, row in user_df.iterrows():
            expanded_records.append({
                "Timestamp": date,
                "User": user,
                "Cumulative": row["Cumulative"]
            })

    long_df = pd.DataFrame(expanded_records)

    fig, ax = plt.subplots(figsize=(11, 6))
    palette = sns.color_palette("tab10", len(users))

    # Plot step lines
    sns.lineplot(
        data=long_df,
        x="Timestamp",
        y="Cumulative",
        hue="User",
        palette=palette,
        linewidth=2,
        drawstyle="steps-post", 
        marker="o",
        markersize=4,
        ax=ax,
    )

    # Shaded step areas matching steps-post trajectory
    for i, user in enumerate(users):
        user_data = long_df[long_df["User"] == user].sort_values("Timestamp")
        ax.fill_between(
            user_data["Timestamp"], 
            user_data["Cumulative"],
            step="post",
            alpha=0.06, 
            color=palette[i]
        )

    # Axis formatting
    time_range = max_date - min_date
    padding    = pd.Timedelta(days=1)
    ax.set_xlim(min_date - padding, max_date + padding)

    if time_range.days <= 7:
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b"))
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=1))
    elif time_range.days <= 31:
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b"))
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=2))
    else:
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b"))
        ax.xaxis.set_major_locator(mdates.WeekdayLocator(interval=1))

    plt.xticks(rotation=45, ha="right")
    ax.set_xlabel("Date (SGT)", labelpad=8)
    ax.set_ylabel(ylabel, labelpad=8)
    ax.set_title(title, pad=16)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"{int(x):,}"))
    ax.axhline(0, color="grey", linewidth=0.8, linestyle="--")

    if len(users) > 4:
        ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1), borderaxespad=0, fontsize=9)
    else:
        ax.legend(loc="upper left", fontsize=9)

    sns.despine()
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  ✅ Step chart saved → {output_path}")

# ── TRUE STEP CHART BY REVISION ───────────────────────────────────────────────

def plot_line_by_revision(revisions_df, col, title, ylabel, output_path):
    df = revisions_df.copy()
    df[col]              = pd.to_numeric(df[col], errors="coerce").fillna(0)
    df["Name"]           = df["Name"].fillna("Unknown")
    df["Revision Index"] = pd.to_numeric(df["Revision Index"], errors="coerce")

    users    = df["Name"].unique().tolist()
    max_rev  = int(df["Revision Index"].max()) if not df.empty else 0
    all_revs = list(range(0, max_rev + 1))

    # Track incremental changes per revision per user
    expanded_records = []
    for user in users:
        # Get revisions for this user, group duplicates if multiple edits happen on one revision
        user_revs = df[df["Name"] == user].groupby("Revision Index")[col].sum()
        
        # Build complete sequential baseline across all sequence indexes
        user_series = user_revs.reindex(all_revs).fillna(0)
        
        # Cumulative sum forward-fill
        cumulative = 0
        for rev in all_revs:
            cumulative += float(user_series.loc[rev])
            expanded_records.append({"Revision": rev, "User": user, "Cumulative": cumulative})

    long_df = pd.DataFrame(expanded_records)

    fig, ax = plt.subplots(figsize=(11, 6))
    palette = sns.color_palette("tab10", len(users))

    # Plot step lines
    sns.lineplot(
        data=long_df,
        x="Revision",
        y="Cumulative",
        hue="User",
        palette=palette,
        linewidth=2,
        drawstyle="steps-post",
        marker="o",
        markersize=4,
        ax=ax,
    )

    # Shaded step areas matching steps-post trajectory
    for i, user in enumerate(users):
        user_data = long_df[long_df["User"] == user].sort_values("Revision")
        ax.fill_between(
            user_data["Revision"], 
            user_data["Cumulative"],
            step="post",
            alpha=0.06, 
            color=palette[i]
        )

    ax.set_xlim(-0.5, max_rev + 0.5)
    ax.xaxis.set_major_locator(mticker.MaxNLocator(integer=True))
    ax.set_xlabel("Revision Number", labelpad=8)
    ax.set_ylabel(ylabel, labelpad=8)
    ax.set_title(title, pad=16)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"{int(x):,}"))
    ax.axhline(0, color="grey", linewidth=0.8, linestyle="--")

    if len(users) > 4:
        ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1), borderaxespad=0, fontsize=9)
    else:
        ax.legend(loc="upper left", fontsize=9)

    sns.despine()
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  ✅ Revision step chart saved → {output_path}")

# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate net contribution true step charts from Google Docs revision CSVs."
    )
    parser.add_argument("--summary",   required=True, help="Path to *-summary.csv")
    parser.add_argument("--revisions", required=True, help="Path to *-revisions.csv")
    parser.add_argument("--output",    default=".",   help="Output folder (default: current directory)")
    args = parser.parse_args()

    for p in [args.summary, args.revisions]:
        if not os.path.exists(p):
            print(f"❌ File not found: {p}")
            sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    print("📊 Loading CSVs...")
    summary_df   = load_csv(args.summary)
    revisions_df = load_csv(args.revisions)

    # Compute Net Words and Chars
    revisions_df["Net Words"] = (
        pd.to_numeric(revisions_df["Words Added"],   errors="coerce").fillna(0) -
        pd.to_numeric(revisions_df["Words Removed"], errors="coerce").fillna(0)
    )
    revisions_df["Net Chars"] = (
        pd.to_numeric(revisions_df["Chars Added"],   errors="coerce").fillna(0) -
        pd.to_numeric(revisions_df["Chars Removed"], errors="coerce").fillna(0)
    )

    print(f"   {len(summary_df)} users found in summary")
    print(f"   {len(revisions_df)} revisions found\n")

    # Target filenames updated to match "step chart" taxonomy
    pie_path        = os.path.join(args.output, "contribution-pie.png")
    words_line_path = os.path.join(args.output, "contribution-step-networds.png")
    chars_line_path = os.path.join(args.output, "contribution-step-netchars.png")
    words_rev_path  = os.path.join(args.output, "contribution-step-revision-networds.png")
    chars_rev_path  = os.path.join(args.output, "contribution-step-revision-netchars.png")

    print("🎨 Generating true step charts...")
    plot_pie(summary_df, pie_path)
    
    # Date true step charts
    plot_line(revisions_df, "Net Words", "Progressive Net Word Contribution Over Time",
              "Cumulative Net Words", words_line_path)
    plot_line(revisions_df, "Net Chars", "Progressive Net Character Contribution Over Time",
              "Cumulative Net Characters", chars_line_path)
    
    # Revision true step charts
    plot_line_by_revision(revisions_df, "Net Words", "Net Word Contribution by Revision",
                          "Cumulative Net Words", words_rev_path)
    plot_line_by_revision(revisions_df, "Net Chars", "Net Character Contribution by Revision",
                          "Cumulative Net Characters", chars_rev_path)

    print(f"\n✅ Done! Step charts saved to: {os.path.abspath(args.output)}")

if __name__ == "__main__":
    main()