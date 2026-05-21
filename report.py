#!/usr/bin/env python3
"""
PDF Report Generator
Combines contribution charts and AI plagiarism analysis into a single PDF report.

Usage:
    python report.py --charts <charts_folder> --analysis <ai-analysis.txt> [--output <report.pdf>] [--title <title>]

Requirements:
    pip install reportlab
"""

import argparse
import os
import sys
from datetime import datetime

from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image,
    PageBreak, HRFlowable, KeepTogether
)

PAGE_W, PAGE_H = A4
MARGIN = 2 * cm

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
# ── STYLES ────────────────────────────────────────────────────────────────────

def make_styles():
    styles = getSampleStyleSheet()

    styles.add(ParagraphStyle(
        "ReportTitle",
        parent=styles["Title"],
        fontSize=24,
        leading=30,
        spaceAfter=6,
        textColor=colors.HexColor("#1a1a2e"),
    ))
    styles.add(ParagraphStyle(
        "ReportSubtitle",
        parent=styles["Normal"],
        fontSize=11,
        textColor=colors.HexColor("#6b7280"),
        spaceAfter=20,
    ))
    styles.add(ParagraphStyle(
        "SectionHeading",
        parent=styles["Heading1"],
        fontSize=14,
        leading=18,
        spaceBefore=18,
        spaceAfter=8,
        textColor=colors.HexColor("#1a1a2e"),
        borderPad=4,
    ))
    styles.add(ParagraphStyle(
        "ChartCaption",
        parent=styles["Normal"],
        fontSize=9,
        textColor=colors.HexColor("#6b7280"),
        alignment=1,  # centre
        spaceAfter=16,
    ))
    styles.add(ParagraphStyle(
        "AnalysisBody",
        parent=styles["Normal"],
        fontSize=10,
        leading=15,
        spaceAfter=6,
        textColor=colors.HexColor("#1f2937"),
    ))
    styles.add(ParagraphStyle(
        "AnalysisUserHeading",
        parent=styles["Heading2"],
        fontSize=12,
        leading=16,
        spaceBefore=14,
        spaceAfter=6,
        textColor=colors.HexColor("#2563eb"),
    ))

    return styles

# ── HELPERS ───────────────────────────────────────────────────────────────────

def chart_image(path, max_width=None, max_height=None):
    """Return a reportlab Image scaled to fit within max dimensions."""
    if max_width is None:
        max_width = PAGE_W - 2 * MARGIN
    if max_height is None:
        max_height = PAGE_H * 0.55

    img = Image(path)
    w, h = img.drawWidth, img.drawHeight
    scale = min(max_width / w, max_height / h, 1.0)
    img.drawWidth  = w * scale
    img.drawHeight = h * scale
    return img

def hr():
    return HRFlowable(width="100%", thickness=1,
                      color=colors.HexColor("#e5e7eb"), spaceAfter=8)

def clean_line(line):
    """Strip markdown symbols and HTML tags but keep the underlying text."""
    import re
    line = re.sub(r'<[^>]+>', '', line)                              # HTML tags
    line = re.sub(r'[*]{1,3}(.*?)[*]{1,3}', lambda m: m.group(1), line)  # bold/italic
    line = re.sub(r'_{1,2}(.*?)_{1,2}',     lambda m: m.group(1), line)  # underscores
    line = re.sub(r'^[#]{1,6}\s*',          '', line)                   # headings
    line = re.sub(r'`(.*?)`',               lambda m: m.group(1), line)  # code
    line = re.sub(r'^\s*\d+[.]\s+',         '', line)                   # numbered lists
    line = re.sub(r'^\s*[-•*]\s+',          '', line)                   # bullets
    return line.strip()

def strip_html_tags(text):
    """Remove HTML tags like <font>, <b>, </b> etc from text."""
    import re
    return re.sub(r'<[^>]+>', '', text).strip()

def parse_analysis(text):
    """
    Split AI analysis text into sections per user.
    Supports both "User: username" and "=== username ===" as section headers.
    Returns list of (username, body_lines) tuples.
    """
    import re
    sections = []
    current_heading = None
    current_lines = []

    for line in text.splitlines():
        stripped = line.strip()

        # Match "=== NAME ===" format
        if stripped.startswith("===") and stripped.endswith("==="):
            if current_heading is not None:
                sections.append((current_heading, current_lines))
            current_heading = stripped.strip("= ").strip()
            current_lines = []

        # Match "User: username" format — must have actual username after colon
        elif re.match(r'(?i)^user:\s*\S+', stripped):
            username = re.sub(r'(?i)^user:\s*', '', stripped).strip()
            # Only treat as a new section if there is an actual username
            if username:
                if current_heading is not None:
                    sections.append((current_heading, current_lines))
                current_heading = username
                current_lines = []
            # If no username (bare "User:"), skip the line entirely

        else:
            # Only append lines if we are already inside a user section
            if current_heading is not None:
                current_lines.append(line)

    if current_heading is not None and current_lines:
        sections.append((current_heading, current_lines))

    return sections

# ── BUILD PDF ─────────────────────────────────────────────────────────────────

CHART_META = [
    ("contribution-pie.png",                "Overall Net Word Contribution — Pie Chart"),
    ("contribution-line-networds.png",       "Progressive Net Word Contribution Over Time"),
    ("contribution-line-netchars.png",       "Progressive Net Character Contribution Over Time"),
    ("contribution-revision-networds.png",   "Net Word Contribution by Revision Number"),
    ("contribution-revision-netchars.png",   "Net Character Contribution by Revision Number"),
]

def build_pdf(charts_folder, analysis_path, output_path, title):
    styles = make_styles()
    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=MARGIN,  bottomMargin=MARGIN,
        title=title,
    )

    story = []
    generated = datetime.now().strftime("%d %B %Y, %H:%M SGT")

    # ── COVER ──
    story.append(Spacer(1, 2 * cm))
    story.append(Paragraph(title, styles["ReportTitle"]))
    story.append(Paragraph(f"Generated: {generated}", styles["ReportSubtitle"]))
    story.append(hr())
    story.append(Spacer(1, 0.5 * cm))

    # ── CHARTS SECTION ──
    story.append(Paragraph("Contribution Charts", styles["SectionHeading"]))
    story.append(hr())

    found_any_chart = False
    for filename, caption in CHART_META:
        path = os.path.join(charts_folder, filename)
        if not os.path.exists(path):
            continue
        found_any_chart = True
        story.append(Spacer(1, 0.3 * cm))
        story.append(KeepTogether([
            chart_image(path),
            Paragraph(caption, styles["ChartCaption"]),
        ]))

    if not found_any_chart:
        story.append(Paragraph(
            "No chart files found. Run charts.py first to generate them.",
            styles["AnalysisBody"]
        ))

    # ── AI ANALYSIS SECTION ──
    if analysis_path and os.path.exists(analysis_path):
        story.append(PageBreak())
        story.append(Paragraph("AI Plagiarism Analysis", styles["SectionHeading"]))
        story.append(hr())

        with open(analysis_path, encoding="utf-8") as f:
            raw = f.read()

        sections = parse_analysis(raw)

        for heading, lines in sections:
            # FIX: skip any section with a blank/empty heading to prevent stray "User:" labels
            if not heading.strip():
                continue

            # "User: username" on one line — "User:" blue+bold, username bold black
            safe_heading = (heading
                .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
            story.append(Paragraph(
                f'<font color="#2563eb"><b>User:</b></font> <b>{safe_heading}</b>',
                styles["AnalysisUserHeading"]
            ))

            excerpt_counter = 0
            i = 0
            while i < len(lines):
                raw_line = lines[i]
                stripped = raw_line.strip()
                cleaned  = clean_line(stripped)

                if not cleaned:
                    story.append(Spacer(1, 4))
                    i += 1
                    continue

                safe = (cleaned
                    .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

                # Skip lines that are just "User: username" (already shown in heading)
                if stripped.lower().startswith("user:"):
                    i += 1
                    continue

                # Bold the AI plagiarism percentage line, bold the value after ":"
                elif stripped.lower().startswith("ai plagiarism percentage"):
                    parts = safe.split(":", 1)
                    label = parts[0].strip()
                    value = parts[1].strip() if len(parts) > 1 else ""
                    story.append(Paragraph(
                        f"<b>{label}:</b> <b>{value}</b>",
                        styles["AnalysisBody"]
                    ))

                # Bold the text after ":" for Analysis and Specific Excerpts labels
                elif stripped.lower().startswith("analysis:"):
                    value = safe[len("Analysis:"):].strip()
                    story.append(Paragraph(
                        f"<b>Analysis:</b> {value}",
                        styles["AnalysisBody"]
                    ))

                elif stripped.lower().startswith("specific excerpts:"):
                    story.append(Spacer(1, 6))
                    story.append(Paragraph("<b>Specific Excerpts:</b>", styles["AnalysisBody"]))

                # Numbered excerpts
                elif stripped.upper().startswith("EXCERPT:"):
                    excerpt_counter += 1
                    excerpt_text = safe[len("EXCERPT:"):].strip()
                    story.append(Spacer(1, 6))
                    story.append(Paragraph(
                        f'<b>Excerpt {excerpt_counter}:</b> <i>"{excerpt_text}"</i>',
                        styles["AnalysisBody"]
                    ))
                    # Look ahead for the EXPLANATION line
                    if i + 1 < len(lines):
                        next_stripped = lines[i + 1].strip()
                        if next_stripped.upper().startswith("EXPLANATION:"):
                            explanation = clean_line(next_stripped[len("EXPLANATION:"):].strip())
                            safe_exp = (explanation
                                .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))
                            story.append(Spacer(1, 8))
                            story.append(Paragraph(safe_exp, styles["AnalysisBody"]))
                            story.append(Spacer(1, 8))
                            i += 2
                            continue

                # Explanation without preceding EXCERPT (fallback)
                elif stripped.upper().startswith("EXPLANATION:"):
                    explanation = safe[len("EXPLANATION:"):].strip()
                    story.append(Spacer(1, 8))
                    story.append(Paragraph(explanation, styles["AnalysisBody"]))
                    story.append(Spacer(1, 8))

                # Skip section dividers
                elif stripped.startswith("---"):
                    story.append(Spacer(1, 8))

                # Regular body line
                else:
                    story.append(Paragraph(safe, styles["AnalysisBody"]))

                i += 1
    else:
        story.append(PageBreak())
        story.append(Paragraph("AI Plagiarism Analysis", styles["SectionHeading"]))
        story.append(hr())
        story.append(Paragraph(
            "No AI analysis file found. Run index.js with a Gemini API key to generate it.",
            styles["AnalysisBody"]
        ))

    doc.build(story)
    print(f"✅ PDF report saved → {output_path}")

# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Combine contribution charts and AI analysis into a PDF report.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python report.py --charts . --analysis report-ai-analysis.txt
  python report.py --charts charts/ --analysis report-ai-analysis.txt --output final-report.pdf --title "Group Assignment Report"
        """
    )
    parser.add_argument("--charts",   required=True, help="Folder containing the chart PNG files")
    parser.add_argument("--analysis", default=None,  help="Path to the AI analysis .txt file (optional)")
    parser.add_argument("--output",   default="contribution-report.pdf", help="Output PDF filename")
    parser.add_argument("--title",    default="Contribution Report", help="Report title")
    args = parser.parse_args()

    if not os.path.isdir(args.charts):
        print(f"❌ Charts folder not found: {args.charts}")
        sys.exit(1)

    build_pdf(args.charts, args.analysis, args.output, args.title)

if __name__ == "__main__":
    main()