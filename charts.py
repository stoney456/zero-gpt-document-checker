#!/usr/bin/env python3
"""
Contribution Chart Generator
Reads *-summary.csv and *-revisions.csv and outputs:
  - contribution-pie.png            Overall net word contribution per user
  - contribution-line-networds.png  Cumulative net words over time per user
  - contribution-line-netchars.png  Cumulative net characters over time per user

Usage:
    python charts.py --summary <summary.csv> --revisions <revisions.csv> [--output <folder>]

Requirements:
    pip install matplotlib seaborn pandas
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

# ── LINE CHART ────────────────────────────────────────────────────────────────

def plot_line(revisions_df, col, title, ylabel, output_path):
    df = revisions_df.copy()
    df[col]    = pd.to_numeric(df[col], errors="coerce").fillna(0)
    df["Name"] = df["Name"].fillna("Unknown")
    df["Timestamp"] = pd.to_datetime(
        df["Modified Time (SGT)"].str.replace(" SGT", "", regex=False),
        format="%Y-%m-%d %H:%M:%S",
    )

    # Strip time — group by date only to avoid intra-day vertical jumps
    df["Timestamp"] = df["Timestamp"].dt.normalize()
    df = df.groupby(["Name", "Timestamp"], as_index=False)[col].sum()

    users     = df["Name"].unique().tolist()
    all_dates = df["Timestamp"].sort_values().unique()
    last_date = pd.Timestamp(all_dates.max())
    palette   = sns.color_palette("tab10", len(users))

    global_first_date = pd.Timestamp(all_dates.min())

    records = []
    for user in users:
        user_rows = (
            df[df["Name"] == user]
            .sort_values("Timestamp")
            .set_index("Timestamp")
        )

        # All users start at 0 on the earliest date across all users
        records.append({"Timestamp": global_first_date, "User": user, "Cumulative": 0})

        cumulative = 0
        for date in all_dates:
            if date in user_rows.index:
                val = user_rows.loc[date, col]
                cumulative += float(val) if not hasattr(val, "__len__") else float(val.iloc[0])
            # Append every date so all lines run the full length
            records.append({"Timestamp": date, "User": user, "Cumulative": cumulative})

    long_df = pd.DataFrame(records).sort_values("Timestamp")

    fig, ax = plt.subplots(figsize=(11, 6))

    sns.lineplot(
        data=long_df,
        x="Timestamp",
        y="Cumulative",
        hue="User",
        palette=palette,
        linewidth=2,
        marker="o",
        markersize=5,
        ax=ax,
    )

    # Shaded fill under each line
    for i, user in enumerate(users):
        user_data = long_df[long_df["User"] == user].sort_values("Timestamp")
        ax.fill_between(user_data["Timestamp"], user_data["Cumulative"],
                        alpha=0.08, color=palette[i])

    # x-axis limits
    first_ts   = pd.Timestamp(all_dates.min())
    time_range = last_date - first_ts
    padding    = pd.Timedelta(days=1)
    ax.set_xlim(first_ts - padding, last_date + padding)

    # Auto-format time axis based on date range
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
    print(f"  ✅ Line chart saved → {output_path}")

# ── LINE CHART BY REVISION ───────────────────────────────────────────────────

def plot_line_by_revision(revisions_df, col, title, ylabel, output_path):
    df = revisions_df.copy()
    df[col]              = pd.to_numeric(df[col], errors="coerce").fillna(0)
    df["Name"]           = df["Name"].fillna("Unknown")
    df["Revision Index"] = pd.to_numeric(df["Revision Index"], errors="coerce")

    users      = df["Name"].unique().tolist()
    max_rev    = int(df["Revision Index"].max())
    all_revs   = list(range(1, max_rev + 1))
    palette    = sns.color_palette("tab10", len(users))

    records = []
    for user in users:
        user_rows = (
            df[df["Name"] == user]
            .set_index("Revision Index")
        )
        # Anchor all users at revision 0 with cumulative 0
        records.append({"Revision": 0, "User": user, "Cumulative": 0})

        cumulative = 0
        for rev in all_revs:
            if rev in user_rows.index:
                val = user_rows.loc[rev, col]
                cumulative += float(val) if not hasattr(val, "__len__") else float(val.iloc[0])
            records.append({"Revision": rev, "User": user, "Cumulative": cumulative})

    long_df = pd.DataFrame(records).sort_values("Revision")

    fig, ax = plt.subplots(figsize=(11, 6))

    sns.lineplot(
        data=long_df,
        x="Revision",
        y="Cumulative",
        hue="User",
        palette=palette,
        linewidth=2,
        marker="o",
        markersize=5,
        ax=ax,
    )

    # Shaded fill under each line
    for i, user in enumerate(users):
        user_data = long_df[long_df["User"] == user].sort_values("Revision")
        ax.fill_between(user_data["Revision"], user_data["Cumulative"],
                        alpha=0.08, color=palette[i])

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
    print(f"  ✅ Revision chart saved → {output_path}")


# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Generate net contribution charts from Google Docs revision CSVs.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python charts.py --summary report-summary.csv --revisions report-revisions.csv
  python charts.py --summary report-summary.csv --revisions report-revisions.csv --output charts
        """
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

    # Compute net chars if not already in revisions CSV
    revisions_df["Net Chars"] = (
        pd.to_numeric(revisions_df["Chars Added"],   errors="coerce").fillna(0) -
        pd.to_numeric(revisions_df["Chars Removed"], errors="coerce").fillna(0)
    )

    print(f"   {len(summary_df)} users found in summary")
    print(f"   {len(revisions_df)} revisions found\n")

    pie_path            = os.path.join(args.output, "contribution-pie.png")
    words_line_path     = os.path.join(args.output, "contribution-line-networds.png")
    chars_line_path     = os.path.join(args.output, "contribution-line-netchars.png")
    words_rev_path      = os.path.join(args.output, "contribution-revision-networds.png")
    chars_rev_path      = os.path.join(args.output, "contribution-revision-netchars.png")

    print("🎨 Generating charts...")
    plot_pie(summary_df, pie_path)
    plot_line(revisions_df, "Net Words", "Progressive Net Word Contribution Over Time",
              "Cumulative Net Words", words_line_path)
    plot_line(revisions_df, "Net Chars", "Progressive Net Character Contribution Over Time",
              "Cumulative Net Characters", chars_line_path)
    plot_line_by_revision(revisions_df, "Net Words", "Net Word Contribution by Revision",
              "Cumulative Net Words", words_rev_path)
    plot_line_by_revision(revisions_df, "Net Chars", "Net Character Contribution by Revision",
              "Cumulative Net Characters", chars_rev_path)

    print(f"\n✅ Done! Charts saved to: {os.path.abspath(args.output)}")

if __name__ == "__main__":
    main()