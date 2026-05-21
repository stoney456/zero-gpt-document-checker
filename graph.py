#!/usr/bin/env python3
"""
Step Chart Generator for Document Contributions
Reads *-revisions.csv and outputs step charts for:
  - contribution-step-networds.png  Cumulative net words over time per user using steps
  - contribution-step-netchars.png  Cumulative net characters over time per user using steps

Usage:
    python graph.py --revisions <revisions.csv> [--output <folder>]
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
    "font.size":         9,
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

# ── STEP CHART OVER TIME ──────────────────────────────────────────────────────

def plot_step_chart(revisions_df, col, title, ylabel, output_path):
    df = revisions_df.copy()
    df[col]    = pd.to_numeric(df[col], errors="coerce").fillna(0)
    df["Name"] = df["Name"].fillna("Unknown")
    df["Timestamp"] = pd.to_datetime(
        df["Modified Time (SGT)"].str.replace(" SGT", "", regex=False),
        format="%Y-%m-%d %H:%M:%S",
    )

    # Sort strictly chronologically by exact timestamp
    df = df.sort_values("Timestamp")

    users     = df["Name"].unique().tolist()
    min_time  = df["Timestamp"].min()
    max_time  = df["Timestamp"].max()
    palette   = sns.color_palette("tab10", len(users))

    fig, ax = plt.subplots(figsize=(11, 6))

    # Plot an independent step line for each contributor
    for i, user in enumerate(users):
        user_df = df[df["Name"] == user].sort_values("Timestamp")
        
        # Calculate running cumulative total
        user_df["Cumulative"] = user_df[col].cumsum()
        
        # Structure baseline: Anchor at 0 right at the start of the project timeline
        times = [min_time] + user_df["Timestamp"].tolist() + [max_time]
        values = [0] + user_df["Cumulative"].tolist()
        if len(user_df) > 0:
            values.append(user_df["Cumulative"].iloc[-1])
        else:
            values.append(0)

        # Plot using standard matplotlib step plotting
        ax.step(
            times,
            values,
            where="post",
            label=user,
            color=palette[i],
            linewidth=2.5,
            marker="o",
            markersize=4,
        )
        
        # Optional: Subtle color fill under the steps for visibility
        ax.fill_between(
            times, 
            values, 
            step="post", 
            alpha=0.04, 
            color=palette[i]
        )

    # x-axis limits and formatting
    time_range = max_time - min_time
    padding    = pd.Timedelta(days=1) if time_range.days > 1 else pd.Timedelta(hours=2)
    ax.set_xlim(min_time - padding, max_time + padding)

    if time_range.days <= 7:
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b\n%H:%M"))
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=1))
    elif time_range.days <= 31:
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b"))
        ax.xaxis.set_major_locator(mdates.DayLocator(interval=2))
    else:
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%d %b"))
        ax.xaxis.set_major_locator(mdates.WeekdayLocator(interval=1))

    plt.xticks(rotation=45, ha="right")
    ax.set_xlabel("Timeline (SGT)", labelpad=8)
    ax.set_ylabel(ylabel, labelpad=8)
    ax.set_title(title, pad=16)
    ax.yaxis.set_major_formatter(mticker.FuncFormatter(lambda x, _: f"{int(x):,}"))
    ax.axhline(0, color="grey", linewidth=0.8, linestyle="--")

    ax.legend(title="Contributor", loc="upper left", bbox_to_anchor=(1.01, 1))

    sns.despine()
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"  ✅ Step chart saved → {output_path}")

# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate milestone step charts from Google Docs revision CSVs.",
    )
    parser.add_argument("--revisions", required=True, help="Path to *-revisions.csv")
    parser.add_argument("--output",    default=".",   help="Output folder (default: current directory)")
    args = parser.parse_args()

    if not os.path.exists(args.revisions):
        print(f"❌ File not found: {args.revisions}")
        sys.exit(1)

    os.makedirs(args.output, exist_ok=True)

    print("📊 Loading Revisions CSV...")
    revisions_df = load_csv(args.revisions)

    # Compute Net Chars if missing
    if "Net Chars" not in revisions_df.columns and "Chars Added" in revisions_df.columns:
        revisions_df["Net Chars"] = (
            pd.to_numeric(revisions_df["Chars Added"],   errors="coerce").fillna(0) -
            pd.to_numeric(revisions_df["Chars Removed"], errors="coerce").fillna(0)
        )
        
    if "Net Words" not in revisions_df.columns and "Words Added" in revisions_df.columns:
        revisions_df["Net Words"] = (
            pd.to_numeric(revisions_df["Words Added"],   errors="coerce").fillna(0) -
            pd.to_numeric(revisions_df["Words Removed"], errors="coerce").fillna(0)
        )

    words_step_path = os.path.join(args.output, "contribution-step-networds.png")
    chars_step_path = os.path.join(args.output, "contribution-step-netchars.png")

    print("🎨 Generating Step Charts...")
    plot_step_chart(
        revisions_df, "Net Words", 
        "Stepwise Cumulative Net Word Contribution Over Time",
        "Cumulative Net Words", words_step_path
    )
    plot_step_chart(
        revisions_df, "Net Chars", 
        "Stepwise Cumulative Net Character Contribution Over Time",
        "Cumulative Net Characters", chars_step_path
    )

    print(f"\n✅ Done! Step charts saved to: {os.path.abspath(args.output)}")

if __name__ == '__main__':
    main()